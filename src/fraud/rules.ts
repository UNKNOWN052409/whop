/**
 * Fraud rule engine (spec §17).
 *
 * Every rule is a pure-ish function over a `FraudRuleContext`: it answers
 * "did this signal fire, how much is it worth, and why". The runner in
 * `evaluate.ts` sums the weights into a 0-100 score.
 *
 * TWO INVARIANTS THIS FILE EXISTS TO PROTECT
 *
 * 1. NO RAW PII LEAVES A RULE. A rule may count orders, sum amounts and read
 *    a domain, but it may never put the customer's address, IP, card digits
 *    or redeem code into `detail`. The value that leaves is a COUNT or an
 *    integer amount, keyed by a salted hash the caller already computed. That
 *    detail string lands in `FraudEvent.signals` (JSON, admin-visible) and in
 *    the log stream.
 *
 * 2. NO HARD-CODED THRESHOLDS. Every number that decides someone's money is
 *    read from the environment with a documented default. An operator tuning
 *    the risk engine must not need a redeploy of a magic constant in here.
 *
 * A rule that THROWS is not silently skipped: the runner turns it into a
 * "could not evaluate" signal that leans toward review, because the honest
 * answer to "I don't know" on a payment is "hold it", not "allow it".
 */

import { OrderStatus, PaymentStatus } from '@prisma/client';

import type { Prisma } from '@/db/prisma';
import { logger, type LogContext } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const warnedKeys = new Set<string>();

/**
 * Log-at-most-once. Used for conditions that are permanent properties of the
 * environment (a malformed var, a missing Redis) rather than events — logging
 * them on every evaluation would bury real incidents.
 */
export function warnOnce(key: string, message: string, context?: LogContext): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  logger.warn(message, context);
}

/**
 * Reads a bounded integer from the environment.
 *
 * A malformed or out-of-range value falls back to the default and says so,
 * rather than letting a typo in `.env.local` quietly disable a fraud control
 * (or, worse, set the velocity limit to 0 and block every customer).
 */
export function intEnv(
  key: string,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    warnOnce(`invalid-int:${key}`, `Ignoring non-integer ${key}; using the default`, {
      key,
      fallback,
    });
    return fallback;
  }
  if (opts.min !== undefined && parsed < opts.min) {
    warnOnce(`below-min:${key}`, `Ignoring ${key} below its minimum; using the default`, {
      key,
      value: parsed,
      min: opts.min,
      fallback,
    });
    return fallback;
  }
  if (opts.max !== undefined && parsed > opts.max) {
    warnOnce(`above-max:${key}`, `Ignoring ${key} above its maximum; using the default`, {
      key,
      value: parsed,
      max: opts.max,
      fallback,
    });
    return fallback;
  }
  return parsed;
}

function csvEnv(key: string): string[] {
  return (process.env[key] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Test seam: forget which warnings have been emitted. */
export function resetWarnOnce(): void {
  warnedKeys.clear();
}

/**
 * Every tunable in one object, resolved fresh on each read so a test (or a
 * runtime env change) sees the current environment. Defaults are conservative
 * for a $3-goods store, where a single $15 dispute fee is five times the
 * revenue of the transaction that caused it.
 */
export interface FraudThresholds {
  // velocity
  velocityOrders1h: number;
  velocityOrders24h: number;
  velocityWeightHour: number;
  velocityWeightDay: number;
  // repeated failures
  failedPayments24h: number;
  repeatedFailuresWeight: number;
  failureEscalationWeight: number;
  // amount anomaly
  amountAnomalyBps: number;
  amountAnomalyMinDeltaMinor: number;
  amountAnomalyWeight: number;
  amountAnomalyHistorySize: number;
  // email hygiene
  disposableEmailWeight: number;
  roleEmailWeight: number;
  // region
  regionMismatchWeight: number;
  // duplicate payment
  duplicatePaymentWeight: number;
  // rapid repeat
  rapidRepeatWindowMinutes: number;
  rapidRepeatCount: number;
  rapidRepeatWeight: number;
  // inventory targeting
  inventoryTargetingFailures: number;
  highValueOrderMinor: number;
  inventoryTargetingWeight: number;
  // meta
  ruleFailureWeight: number;
  riskMediumScore: number;
  riskHighScore: number;
  riskCriticalScore: number;
}

export function fraudThresholds(): FraudThresholds {
  return {
    velocityOrders1h: intEnv('FRAUD_VELOCITY_ORDERS_1H', 3, { min: 1, max: 500 }),
    velocityOrders24h: intEnv('FRAUD_VELOCITY_ORDERS_24H', 8, { min: 1, max: 5_000 }),
    velocityWeightHour: intEnv('FRAUD_W_VELOCITY_HOUR', 25, { min: 0, max: 100 }),
    velocityWeightDay: intEnv('FRAUD_W_VELOCITY_DAY', 10, { min: 0, max: 100 }),

    failedPayments24h: intEnv('FRAUD_FAILED_PAYMENTS_24H', 3, { min: 1, max: 500 }),
    repeatedFailuresWeight: intEnv('FRAUD_W_REPEATED_FAILURES', 30, { min: 0, max: 100 }),
    failureEscalationWeight: intEnv('FRAUD_W_FAILURE_ESCALATION', 5, { min: 0, max: 100 }),

    amountAnomalyBps: intEnv('FRAUD_AMOUNT_ANOMALY_BPS', 30_000, { min: 1_000, max: 1_000_000 }),
    amountAnomalyMinDeltaMinor: intEnv('FRAUD_AMOUNT_ANOMALY_MIN_DELTA_MINOR', 500, {
      min: 0,
      max: 100_000_000,
    }),
    amountAnomalyWeight: intEnv('FRAUD_W_AMOUNT_ANOMALY', 20, { min: 0, max: 100 }),
    amountAnomalyHistorySize: intEnv('FRAUD_AMOUNT_HISTORY_SIZE', 50, { min: 3, max: 500 }),

    disposableEmailWeight: intEnv('FRAUD_W_DISPOSABLE_EMAIL', 20, { min: 0, max: 100 }),
    roleEmailWeight: intEnv('FRAUD_W_ROLE_EMAIL', 10, { min: 0, max: 100 }),

    regionMismatchWeight: intEnv('FRAUD_W_REGION_MISMATCH', 20, { min: 0, max: 100 }),

    duplicatePaymentWeight: intEnv('FRAUD_W_DUPLICATE_PAYMENT', 100, { min: 0, max: 100 }),

    rapidRepeatWindowMinutes: intEnv('FRAUD_RAPID_REPEAT_WINDOW_MINUTES', 30, {
      min: 1,
      max: 1_440,
    }),
    rapidRepeatCount: intEnv('FRAUD_RAPID_REPEAT_COUNT', 2, { min: 1, max: 100 }),
    rapidRepeatWeight: intEnv('FRAUD_W_RAPID_REPEAT', 15, { min: 0, max: 100 }),

    inventoryTargetingFailures: intEnv('FRAUD_INVENTORY_TARGETING_FAILURES', 5, {
      min: 1,
      max: 500,
    }),
    highValueOrderMinor: intEnv('FRAUD_HIGH_VALUE_ORDER_MINOR', 5_000, {
      min: 0,
      max: 100_000_000,
    }),
    inventoryTargetingWeight: intEnv('FRAUD_W_INVENTORY_TARGETING', 30, { min: 0, max: 100 }),

    ruleFailureWeight: intEnv('FRAUD_W_RULE_FAILURE', 25, { min: 0, max: 100 }),

    riskMediumScore: intEnv('FRAUD_RISK_MEDIUM_SCORE', 30, { min: 1, max: 100 }),
    riskHighScore: intEnv('FRAUD_RISK_HIGH_SCORE', 60, { min: 1, max: 100 }),
    riskCriticalScore: intEnv('FRAUD_RISK_CRITICAL_SCORE', 85, { min: 1, max: 100 }),
  };
}

// ---------------------------------------------------------------------------
// Built-in reference data
// ---------------------------------------------------------------------------

/**
 * Throwaway inbox providers. A real customer cannot read a reply here, so an
 * order delivered to one is an order we cannot support when it breaks.
 * Extend with FRAUD_DISPOSABLE_EMAIL_DOMAINS (comma separated).
 */
const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  '0-mail.com',
  '10minutemail.com',
  '20minutemail.com',
  'dispostable.com',
  'emailfake.com',
  'emailondeck.com',
  'fakeinbox.com',
  'getairmail.com',
  'getnada.com',
  'grr.la',
  'guerrillamail.com',
  'guerrillamailblock.com',
  'inboxkitten.com',
  'mail-temporaire.fr',
  'mailcatch.com',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'mintemail.com',
  'mohmal.com',
  'mytemp.email',
  'mytrashmail.com',
  'sharklasers.com',
  'spamgourmet.com',
  'temp-mail.io',
  'temp-mail.org',
  'tempail.com',
  'tempmailaddress.com',
  'tempmailo.com',
  'tempr.email',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
]);

/** Shared mailboxes. Legitimate for a business, never for a retail buyer. */
const ROLE_EMAIL_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'abuse',
  'accounting',
  'accounts',
  'admin',
  'billing',
  'contact',
  'customerservice',
  'finance',
  'help',
  'hostmaster',
  'info',
  'invoices',
  'mail',
  'marketing',
  'no-reply',
  'noreply',
  'notifications',
  'orders',
  'pay',
  'payments',
  'postmaster',
  'refunds',
  'sales',
  'security',
  'service',
  'support',
  'team',
  'webmaster',
]);

/**
 * Regions that carry an elevated card-not-present dispute rate relative to the
 * catalogue's default US region. This is a DEFAULT, not a policy: extend or
 * override it with FRAUD_HIGH_RISK_REGIONS. The rule only fires on a MISMATCH
 * involving one of these — a US catalogue billed to Canada is not an anomaly.
 */
const DEFAULT_HIGH_RISK_REGIONS: ReadonlySet<string> = new Set([
  'NG',
  'VN',
  'RO',
  'UA',
  'BY',
  'ID',
  'PK',
  'BR',
  'PH',
]);

export function highRiskRegions(): ReadonlySet<string> {
  const extra = csvEnv('FRAUD_HIGH_RISK_REGIONS');
  if (extra.length === 0) return DEFAULT_HIGH_RISK_REGIONS;
  return new Set([...DEFAULT_HIGH_RISK_REGIONS, ...extra]);
}

export function disposableEmailDomains(): ReadonlySet<string> {
  const extra = csvEnv('FRAUD_DISPOSABLE_EMAIL_DOMAINS');
  if (extra.length === 0) return DISPOSABLE_EMAIL_DOMAINS;
  return new Set([...DISPOSABLE_EMAIL_DOMAINS, ...extra]);
}

/** Order states in which money has actually been taken or committed. */
const SETTLED_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PAYMENT_VERIFIED,
  OrderStatus.FULFILLMENT_PENDING,
  OrderStatus.CODE_RESERVED,
  OrderStatus.CODE_DELIVERED,
  OrderStatus.COMPLETED,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The slice of an Order the rules are allowed to look at. */
export interface FraudOrderSnapshot {
  id: string;
  reference: string;
  status: OrderStatus;
  productId: string;
  productName: string;
  quantity: number;
  /** Product region, e.g. "US". */
  region: string;
  currency: string;
  faceValueMinor: number;
  sellingPriceMinor: number;
  unitPriceMinor: number;
  totalMinor: number;
  /** Precomputed by the caller; derived from `email` when absent. */
  customerEmailNormalized?: string;
  userId?: string | null;
  createdAt?: Date;
}

/** The exact shape persisted in FraudEvent.signals. Never contains PII. */
export interface FraudSignal {
  name: string;
  fired: boolean;
  /** Points added to the 0-100 score. Always 0 when `fired` is false. */
  weight: number;
  /** Operator-facing explanation. Counts and integers only — never PII. */
  detail: string;
  /**
   * A hard integrity failure that cannot be out-scored: the decision becomes
   * BLOCK regardless of the summed score. Used for a provider payment id
   * bound to two different orders.
   */
  hardBlock?: boolean;
}

/** Prisma delegates this module needs; satisfied by PrismaClient or a tx. */
export type FraudDb = Pick<
  Prisma.TransactionClient,
  'order' | 'payment' | 'fraudEvent' | 'auditLog' | 'inventoryCode' | 'orderStateTransition'
>;

export interface FraudRuleContext {
  db: FraudDb;
  now: Date;
  order: FraudOrderSnapshot;
  /** Salted hash of the normalized email. Used for matching, never stored raw. */
  emailHash: string;
  emailNormalized: string;
  /** Domain part only, e.g. "mailinator.com". */
  emailDomain: string;
  ipHash?: string | undefined;
  /** Buyer billing region when the provider tells us. Optional. */
  billingRegion?: string | null | undefined;
  /** Bound provider payment id, when the order already has one. */
  providerPaymentId?: string | null | undefined;
  thresholds: FraudThresholds;
}

export interface FraudRule {
  name: FraudRuleName;
  description: string;
  run(ctx: FraudRuleContext): Promise<FraudSignal>;
}

/**
 * The complete rule inventory. Declared as data (rather than derived from the
 * array below) so it is importable as a type without instantiating the rules.
 */
export const FRAUD_RULE_NAMES = [
  'velocity',
  'repeated_failures',
  'amount_anomaly',
  'disposable_email',
  'role_email',
  'region_mismatch',
  'duplicate_payment',
  'rapid_repeat_purchase',
  'inventory_targeting',
] as const;

export type FraudRuleName = (typeof FRAUD_RULE_NAMES)[number];

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function signal(
  name: FraudRuleName | string,
  fired: boolean,
  weight: number,
  detail: string,
  extra?: { hardBlock?: boolean },
): FraudSignal {
  return {
    name,
    fired,
    weight: fired ? weight : 0,
    detail,
    ...(extra?.hardBlock ? { hardBlock: true } : {}),
  };
}

/** Order-creation velocity for the same buyer. */
const velocityRule: FraudRule = {
  name: 'velocity',
  description: 'Number of orders placed by this buyer in the last 1h and 24h',
  async run(ctx) {
    const hourAgo = new Date(ctx.now.getTime() - HOUR_MS);
    const dayAgo = new Date(ctx.now.getTime() - DAY_MS);
    // The order under evaluation is excluded — it would always count itself.
    const scope = {
      customerEmailNormalized: ctx.emailNormalized,
      NOT: { id: ctx.order.id },
    };

    const [lastHour, lastDay] = await Promise.all([
      ctx.db.order.count({ where: { ...scope, createdAt: { gte: hourAgo } } }),
      ctx.db.order.count({ where: { ...scope, createdAt: { gte: dayAgo } } }),
    ]);

    const overHour = lastHour >= ctx.thresholds.velocityOrders1h;
    const overDay = lastDay >= ctx.thresholds.velocityOrders24h;
    const weight =
      (overHour ? ctx.thresholds.velocityWeightHour : 0) +
      (overDay ? ctx.thresholds.velocityWeightDay : 0);

    return signal(
      'velocity',
      overHour || overDay,
      weight,
      `${lastHour} order(s) in 1h (limit ${ctx.thresholds.velocityOrders1h}), ` +
        `${lastDay} in 24h (limit ${ctx.thresholds.velocityOrders24h})`,
    );
  },
};

/** Repeated failed payments — a classic card-testing / brute-force pattern. */
const repeatedFailuresRule: FraudRule = {
  name: 'repeated_failures',
  description: 'Failed payments for this buyer in the last 24h',
  async run(ctx) {
    const dayAgo = new Date(ctx.now.getTime() - DAY_MS);
    const orderScope = { customerEmailNormalized: ctx.emailNormalized };

    const [failedPayments, failedOrders] = await Promise.all([
      ctx.db.payment.count({
        where: {
          status: { in: [PaymentStatus.FAILED] },
          updatedAt: { gte: dayAgo },
          order: orderScope,
        },
      }),
      ctx.db.order.count({
        where: { ...orderScope, status: OrderStatus.PAYMENT_FAILED, createdAt: { gte: dayAgo } },
      }),
    ]);

    // A failed order usually also has a failed payment; counting both would
    // double-count the same incident, so take the stronger of the two signals.
    const failures = Math.max(failedPayments, failedOrders);
    const limit = ctx.thresholds.failedPayments24h;
    const fired = failures >= limit;
    const extra = fired ? Math.max(0, failures - limit) : 0;
    const weight =
      ctx.thresholds.repeatedFailuresWeight + extra * ctx.thresholds.failureEscalationWeight;

    return signal(
      'repeated_failures',
      fired,
      weight,
      `${failures} failed payment attempt(s) in 24h (limit ${limit}); ` +
        `${failedOrders} of them ended in a failed order`,
    );
  },
};

/** This order costs far more than this buyer has ever paid before. */
const amountAnomalyRule: FraudRule = {
  name: 'amount_anomaly',
  description: 'Order total far above this buyer’s own historical average',
  async run(ctx) {
    const history = await ctx.db.order.findMany({
      where: {
        customerEmailNormalized: ctx.emailNormalized,
        currency: ctx.order.currency,
        NOT: { id: ctx.order.id },
        status: { notIn: [OrderStatus.CANCELLED] },
      },
      select: { totalMinor: true },
      orderBy: { createdAt: 'desc' },
      take: ctx.thresholds.amountAnomalyHistorySize,
    });

    const typical = medianOf(history.map((row) => row.totalMinor));
    if (typical === null || typical <= 0) {
      return signal('amount_anomaly', false, 0, 'no comparable order history for this buyer');
    }

    const bps = ctx.thresholds.amountAnomalyBps;
    // Integer comparison: total >= typical * (1 + bps/10_000). Never a float.
    const ratioHit = ctx.order.totalMinor * 10_000 >= typical * (10_000 + bps);
    const deltaHit =
      ctx.order.totalMinor - typical >= ctx.thresholds.amountAnomalyMinDeltaMinor;
    const fired = ratioHit && deltaHit;

    return signal(
      'amount_anomaly',
      fired,
      ctx.thresholds.amountAnomalyWeight,
      `order total ${ctx.order.totalMinor} ${ctx.order.currency.toUpperCase()} vs median ` +
        `${typical} ${ctx.order.currency.toUpperCase()} over ${history.length} prior order(s)` +
        ` (threshold +${bps}bps and +${ctx.thresholds.amountAnomalyMinDeltaMinor} minor units)`,
    );
  },
};

/** Throwaway inbox providers — an order delivered here can never be supported. */
const disposableEmailRule: FraudRule = {
  name: 'disposable_email',
  description: 'Email domain is a known throwaway inbox provider',
  async run(ctx) {
    const domains = disposableEmailDomains();
    if (!ctx.emailDomain) {
      return signal('disposable_email', false, 0, 'email has no domain part');
    }
    const fired = domains.has(ctx.emailDomain);
    return signal(
      'disposable_email',
      fired,
      ctx.thresholds.disposableEmailWeight,
      fired
        ? `email domain "${ctx.emailDomain}" is a known throwaway inbox provider`
        : 'email domain is not a known throwaway inbox provider',
    );
  },
};

/** Shared mailboxes (`support@`, `billing@`) — legitimate for a firm, not a buyer. */
const roleEmailRule: FraudRule = {
  name: 'role_email',
  description: 'Email local part is a shared role mailbox rather than a person',
  async run(ctx) {
    const at = ctx.emailNormalized.lastIndexOf('@');
    const localPart = at === -1 ? ctx.emailNormalized : ctx.emailNormalized.slice(0, at);
    const fired = ROLE_EMAIL_LOCAL_PARTS.has(localPart);
    return signal(
      'role_email',
      fired,
      ctx.thresholds.roleEmailWeight,
      // The local part is echoed only when it matched a fixed role word, so
      // this can never carry a person's address.
      fired
        ? `email local part matches a shared role mailbox (${localPart})`
        : 'email local part is not a shared role mailbox',
    );
  },
};

/** Product region vs the buyer's billing region, when the provider gives one. */
const regionMismatchRule: FraudRule = {
  name: 'region_mismatch',
  description: 'Billing region disagrees with the product region',
  async run(ctx) {
    const billing = (ctx.billingRegion ?? '').trim().toUpperCase();
    if (!billing) {
      return signal(
        'region_mismatch',
        false,
        0,
        'billing region not available from the provider; rule not applicable',
      );
    }

    const productRegion = ctx.order.region.trim().toUpperCase();
    const mismatch = productRegion !== '' && productRegion !== billing;
    if (!mismatch) {
      return signal(
        'region_mismatch',
        false,
        0,
        `billing region ${billing} matches product region ${productRegion}`,
      );
    }

    const risky = highRiskRegions();
    const involvesHighRisk = risky.has(billing) || risky.has(productRegion);
    if (!involvesHighRisk) {
      return signal(
        'region_mismatch',
        false,
        0,
        `billing region ${billing} differs from product region ${productRegion}, ` +
          'but neither region is on the elevated-dispute list',
      );
    }

    return signal(
      'region_mismatch',
      true,
      ctx.thresholds.regionMismatchWeight,
      `billing region ${billing} does not match product region ${productRegion}, ` +
        'and at least one is on the elevated-dispute region list',
    );
  },
};

/**
 * One provider payment bound to two orders. This is a correctness failure of
 * the payment binding, not a behavioural guess — hence `hardBlock`.
 */
const duplicatePaymentRule: FraudRule = {
  name: 'duplicate_payment',
  description: 'Provider payment id already bound to a different order',
  async run(ctx) {
    const providerPaymentId = ctx.providerPaymentId?.trim();
    if (!providerPaymentId) {
      return signal(
        'duplicate_payment',
        false,
        0,
        'no provider payment id bound to this order yet',
      );
    }

    const conflict = await ctx.db.payment.findFirst({
      where: { providerPaymentId, orderId: { not: ctx.order.id } },
      select: { id: true, orderId: true },
    });

    if (!conflict) {
      return signal(
        'duplicate_payment',
        false,
        0,
        'provider payment id is bound to this order only',
      );
    }

    return signal(
      'duplicate_payment',
      true,
      ctx.thresholds.duplicatePaymentWeight,
      `provider payment id is already bound to order ${conflict.orderId} (payment ${conflict.id})`,
      { hardBlock: true },
    );
  },
};

/** The same SKU bought repeatedly by one buyer inside a short window. */
const rapidRepeatRule: FraudRule = {
  name: 'rapid_repeat_purchase',
  description: 'Same product bought repeatedly by this buyer in a short window',
  async run(ctx) {
    const since = new Date(ctx.now.getTime() - ctx.thresholds.rapidRepeatWindowMinutes * MINUTE_MS);
    const priorCount = await ctx.db.order.count({
      where: {
        customerEmailNormalized: ctx.emailNormalized,
        productId: ctx.order.productId,
        status: { in: [...SETTLED_ORDER_STATUSES] },
        createdAt: { gte: since, lte: ctx.now },
        NOT: { id: ctx.order.id },
      },
    });

    const fired = priorCount >= ctx.thresholds.rapidRepeatCount;
    return signal(
      'rapid_repeat_purchase',
      fired,
      ctx.thresholds.rapidRepeatWeight,
      `${priorCount} settled order(s) of this product in the last ` +
        `${ctx.thresholds.rapidRepeatWindowMinutes}m (limit ${ctx.thresholds.rapidRepeatCount})`,
    );
  },
};

/**
 * Inventory targeting: a run of failed attempts followed by a purchase of a
 * high-value SKU. The failed attempts are how a carder discovers which cards
 * are stolen and which codes are worth taking.
 */
const inventoryTargetingRule: FraudRule = {
  name: 'inventory_targeting',
  description: 'Many recent failures followed by a high-value purchase',
  async run(ctx) {
    const dayAgo = new Date(ctx.now.getTime() - DAY_MS);
    const failures = await ctx.db.payment.count({
      where: {
        status: { in: [PaymentStatus.FAILED] },
        updatedAt: { gte: dayAgo },
        order: { customerEmailNormalized: ctx.emailNormalized },
      },
    });

    const highValue = ctx.order.totalMinor >= ctx.thresholds.highValueOrderMinor;
    const enoughFailures = failures >= ctx.thresholds.inventoryTargetingFailures;
    const fired = highValue && enoughFailures;

    if (fired) {
      return signal(
        'inventory_targeting',
        true,
        ctx.thresholds.inventoryTargetingWeight,
        `${failures} failed attempt(s) in 24h (limit ${ctx.thresholds.inventoryTargetingFailures}) ` +
          `followed by a ${ctx.order.totalMinor} ${ctx.order.currency.toUpperCase()} order ` +
          `(high-value threshold ${ctx.thresholds.highValueOrderMinor})`,
      );
    }
    return signal(
      'inventory_targeting',
      false,
      0,
      `${failures} failed attempt(s) in 24h; high-value order = ${highValue}`,
    );
  },
};

/** Ordered rule inventory. Order is stable so `signals` is diffable. */
export const FRAUD_RULES: readonly FraudRule[] = [
  velocityRule,
  repeatedFailuresRule,
  amountAnomalyRule,
  disposableEmailRule,
  roleEmailRule,
  regionMismatchRule,
  duplicatePaymentRule,
  rapidRepeatRule,
  inventoryTargetingRule,
];

// A missing or renamed rule is a compile-time-visible defect in the inventory
// above; this keeps the runtime array honest about it.
const registeredNames = new Set<string>(FRAUD_RULES.map((rule) => rule.name));
for (const name of FRAUD_RULE_NAMES) {
  if (!registeredNames.has(name)) {
    throw new Error(`Fraud rule "${name}" is declared in FRAUD_RULE_NAMES but not implemented`);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Runs every rule and returns one signal per rule, in declaration order.
 *
 * A rule that throws does not abort the evaluation: it becomes a fired
 * "could not evaluate" signal worth `thresholds.ruleFailureWeight`, which
 * pushes a marginal order into REVIEW rather than letting a database hiccup
 * read as a clean bill of health.
 */
export async function runFraudRules(ctx: FraudRuleContext): Promise<FraudSignal[]> {
  const signals: FraudSignal[] = [];
  for (const rule of FRAUD_RULES) {
    try {
      signals.push(await rule.run(ctx));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Fraud rule failed to evaluate', {
        orderId: ctx.order.id,
        rule: rule.name,
        error: message,
      });
      signals.push({
        name: `${rule.name}_error`,
        fired: true,
        weight: ctx.thresholds.ruleFailureWeight,
        detail: `rule "${rule.name}" could not be evaluated: ${message}`,
      });
    }
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Median of an integer list, or null when there is no history to compare. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const midIndex = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midIndex] ?? null;
  const low = sorted[midIndex - 1] ?? 0;
  const high = sorted[midIndex] ?? 0;
  return Math.round((low + high) / 2);
}

export function emailDomainOf(normalizedEmail: string): string {
  const at = normalizedEmail.lastIndexOf('@');
  return at === -1 ? '' : normalizedEmail.slice(at + 1);
}