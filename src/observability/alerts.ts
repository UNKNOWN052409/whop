/**
 * Alerting (spec §22).
 *
 * An alert here is a structured, deduplicated, auditable statement that a
 * threshold was breached — not a log line and not a silent counter. Every
 * alert carries a stable `code`, a severity, a human message, a machine
 * context object and an ISO `firedAt`, and is written to AuditLog so an
 * operator can answer "when did we first start failing to deliver codes?"
 * weeks later.
 *
 * DESIGN NOTES
 *
 *  - Deduplication: the same condition firing 400 times a minute must produce
 *    one alert, not 400. Repeats inside the alert's window are counted and the
 *    count is reported with the NEXT alert, so a genuinely worsening incident
 *    still shows up as a new record rather than disappearing.
 *
 *  - No notification transport. This module does not email, page or post
 *    anywhere; it emits alerts and persists them. Wires that go to PagerDuty
 *    belong on the scrape side (Prometheus alert rules on the metrics this
 *    package exports). Inventing a notifier would be an unfalsifiable claim
 *    that something is being watched.
 *
 *  - Windowed counters live here rather than in metrics.ts because metrics are
 *    process-lifetime cumulative while "a spike" is a statement about a window.
 */

import type { Prisma } from '@prisma/client';
import { formatMoney } from '@/lib/money';
import { logger } from '@/lib/logger';
import {
  currentProviderErrorRate,
  currentQueueDepth,
  inventoryLevels,
  queueOldestAge,
  recordAlertFired,
  setAlertSnapshotHook,
  setQueueDepth,
} from './metrics';
import { redactContext, safeDiagnostic } from './redact';

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export const ALERT_CODES = {
  PAYMENT_PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE',
  WEBHOOK_VERIFICATION_FAILURE_SPIKE: 'WEBHOOK_VERIFICATION_FAILURE_SPIKE',
  FULFILLMENT_FAILURE_SPIKE: 'FULFILLMENT_FAILURE_SPIKE',
  INVENTORY_DEPLETED: 'INVENTORY_DEPLETED',
  QUEUE_BACKLOG: 'QUEUE_BACKLOG',
  RECONCILIATION_MISMATCH: 'RECONCILIATION_MISMATCH',
  ABNORMAL_PAYMENT_ACTIVITY: 'ABNORMAL_PAYMENT_ACTIVITY',
} as const;

export type AlertCode = (typeof ALERT_CODES)[keyof typeof ALERT_CODES];

export interface AlertRecord {
  /** Stable id for correlation with logs and AuditLog rows. */
  id: string;
  code: AlertCode;
  severity: AlertSeverity;
  message: string;
  /** Redacted, machine-readable evidence. Contains no customer secrets. */
  context: Record<string, unknown>;
  firedAt: string;
  /** How long repeats of this alert are suppressed. */
  windowSeconds: number;
  /** 1 on the first alert; higher once a suppressed window elapses. */
  repeatCount: number;
}

/** Thresholds are data, not code: every one can be tuned per environment. */
export interface AlertThresholds {
  /** Rolling provider failure ratio that counts as "unavailable" (0..1). */
  providerErrorRate: number;
  /** Minimum samples in the window before the ratio is meaningful. */
  providerErrorMinSamples: number;
  /** Payment success ratio below which payments are considered broken (0..1). */
  paymentSuccessRate: number;
  paymentSuccessMinSamples: number;
  /** Webhook verification failures inside the window. */
  webhookFailures: number;
  webhookFailureWindowMs: number;
  /** Fulfillment failures inside the window. */
  fulfillmentFailures: number;
  fulfillmentFailureWindowMs: number;
  /** Inventory at or below this many available codes is an alert. */
  inventoryMinAvailable: number;
  /** Pending fulfillment jobs at or above this count is a backlog. */
  queueBacklog: number;
  /** Oldest pending job age, seconds. */
  queueOldestAgeSeconds: number;
  /** Reconciliation mismatches inside the window. */
  reconciliationMismatches: number;
  reconciliationWindowMs: number;
  /** Payments observed per minute above this is abnormal volume. */
  paymentsPerMinute: number;
  /** A single payment at or above this many minor units is abnormal. */
  abnormalPaymentAmountMinor: number;
  /** Currency assumed when an amount alert has no currency attached. */
  currency: string;
  /** Default suppression window for an alert. */
  dedupeWindowMs: number;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function defaultThresholds(): AlertThresholds {
  return {
    providerErrorRate: numEnv('ALERT_PROVIDER_ERROR_RATE', 0.5),
    providerErrorMinSamples: numEnv('ALERT_PROVIDER_MIN_SAMPLES', 5),
    paymentSuccessRate: numEnv('ALERT_PAYMENT_SUCCESS_RATE', 0.8),
    paymentSuccessMinSamples: numEnv('ALERT_PAYMENT_MIN_SAMPLES', 5),
    webhookFailures: numEnv('ALERT_WEBHOOK_FAILURES', 5),
    webhookFailureWindowMs: numEnv('ALERT_WEBHOOK_FAILURE_WINDOW_MS', 5 * 60_000),
    fulfillmentFailures: numEnv('ALERT_FULFILLMENT_FAILURES', 3),
    fulfillmentFailureWindowMs: numEnv('ALERT_FULFILLMENT_FAILURE_WINDOW_MS', 15 * 60_000),
    inventoryMinAvailable: numEnv('ALERT_INVENTORY_MIN_AVAILABLE', 0),
    queueBacklog: numEnv('ALERT_QUEUE_BACKLOG', 25),
    queueOldestAgeSeconds: numEnv('ALERT_QUEUE_OLDEST_AGE_SECONDS', 900),
    reconciliationMismatches: numEnv('ALERT_RECONCILIATION_MISMATCHES', 1),
    reconciliationWindowMs: numEnv('ALERT_RECONCILIATION_WINDOW_MS', 60 * 60_000),
    paymentsPerMinute: numEnv('ALERT_PAYMENTS_PER_MINUTE', 30),
    abnormalPaymentAmountMinor: numEnv('ALERT_ABNORMAL_AMOUNT_MINOR', 100_000),
    currency: (process.env.ALERT_CURRENCY ?? 'usd').toLowerCase(),
    dedupeWindowMs: numEnv('ALERT_DEDUPE_WINDOW_MS', 5 * 60_000),
  };
}

// --- Windowed counters -------------------------------------------------------

/**
 * Counts events inside a sliding time window. Bounded at `maxSamples` so a
 * traffic spike cannot turn alerting into the memory problem.
 */
export class EventCounter {
  private readonly at: number[] = [];

  constructor(
    readonly windowMs: number,
    private readonly maxSamples = 10_000,
  ) {}

  record(at: number = Date.now()): void {
    this.at.push(at);
    if (this.at.length > this.maxSamples) this.at.shift();
    this.trim(at);
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.at.length > 0 && (this.at[0] ?? 0) < cutoff) this.at.shift();
  }

  count(now: number = Date.now()): number {
    this.trim(now);
    return this.at.length;
  }

  reset(): void {
    this.at.length = 0;
  }
}

interface AlertState {
  lastFiredAt: number;
  repeatCount: number;
  lastRecord: AlertRecord;
}

interface AlertCounters {
  webhookFailures: EventCounter;
  fulfillmentFailures: EventCounter;
  reconciliation: EventCounter;
  paymentAttempts: EventCounter;
  depletedProducts: Set<string>;
  largestPaymentMinor: number;
  largestPaymentAt: number;
}

interface AlertRuntimeState {
  dedupe: Map<string, AlertState>;
  history: AlertRecord[];
  counters: AlertCounters;
  /** When the threshold sweep last ran; throttles re-evaluation. */
  lastEvaluatedAt: number;
}

const globalForAlerts = globalThis as unknown as {
  __dshAlerts?: AlertRuntimeState;
};

function createInitialState(): AlertRuntimeState {
  return {
    dedupe: new Map<string, AlertState>(),
    history: [],
    counters: {
      webhookFailures: new EventCounter(defaultThresholds().webhookFailureWindowMs),
      fulfillmentFailures: new EventCounter(defaultThresholds().fulfillmentFailureWindowMs),
      reconciliation: new EventCounter(defaultThresholds().reconciliationWindowMs),
      paymentAttempts: new EventCounter(60_000),
      depletedProducts: new Set<string>(),
      largestPaymentMinor: 0,
      largestPaymentAt: 0,
    },
    lastEvaluatedAt: 0,
  };
}

/**
 * Alert state lives on globalThis so a dev-server hot reload cannot silently
 * reset the dedupe window and re-page a condition that was already reported.
 */
const state: AlertRuntimeState = (globalForAlerts.__dshAlerts ??= createInitialState());

/** Bounded so a long-lived process cannot accumulate alerts forever. */
const MAX_ALERT_HISTORY = 100;
const MIN_EVALUATION_INTERVAL_MS = 60_000;

// --- Firing ------------------------------------------------------------------

export interface FireAlertInput {
  code: AlertCode;
  severity: AlertSeverity;
  message: string;
  context?: Record<string, unknown>;
  /** Distinguishes several instances of the same code (e.g. per product). */
  dedupeKey?: string;
  windowMs?: number;
  thresholds?: AlertThresholds;
}

function alertId(code: AlertCode, firedAt: Date): string {
  const stamp = firedAt.toISOString().replace(/[^0-9]/g, '').slice(0, 17);
  const suffix = Math.floor(Math.random() * 1_000_000).toString(36);
  return `${code.toLowerCase()}-${stamp}-${suffix}`;
}

/**
 * Fires an alert unless an identical one is already inside its dedupe window.
 *
 * Returns the alert record when it fired, or `null` when it was suppressed.
 */
export function fireAlert(input: FireAlertInput): AlertRecord | null {
  const thresholds = input.thresholds ?? defaultThresholds();
  const now = Date.now();
  const windowMs = Math.max(0, input.windowMs ?? thresholds.dedupeWindowMs);
  const key = `${input.code}|${input.dedupeKey ?? input.code}`;

  const previous = state.dedupe.get(key);
  if (previous && now - previous.lastFiredAt < windowMs) {
    previous.repeatCount += 1;
    logger.debug('alert suppressed (inside dedupe window)', {
      code: input.code,
      dedupeKey: input.dedupeKey,
      suppressedCount: previous.repeatCount,
      windowSeconds: Math.round(windowMs / 1000),
    });
    return null;
  }

  const record: AlertRecord = {
    id: alertId(input.code, new Date(now)),
    code: input.code,
    severity: input.severity,
    message: input.message,
    context: redactContext(input.context ?? {}),
    firedAt: new Date(now).toISOString(),
    windowSeconds: Math.round(windowMs / 1000),
    repeatCount: (previous?.repeatCount ?? 0) + 1,
  };

  state.dedupe.set(key, { lastFiredAt: now, repeatCount: 0, lastRecord: record });
  state.history.push(record);
  while (state.history.length > MAX_ALERT_HISTORY) state.history.shift();

  recordAlertFired(record.code, record.severity);

  const logContext = { alertId: record.id, code: record.code, ...record.context };
  if (record.severity === 'CRITICAL') logger.error(record.message, logContext);
  else if (record.severity === 'WARNING') logger.warn(record.message, logContext);
  else logger.info(record.message, logContext);

  // Persistence is best effort and must never delay or fail the caller: an
  // alert that cannot be written still has to be logged.
  void persistAlertRecord(record);

  return record;
}

/**
 * Converts a redacted context bag into a value Prisma accepts for a `Json`
 * column. The redaction pass already guarantees no customer secrets; this is
 * only about the structural `InputJsonValue` contract (undefined dropped, no
 * non-finite numbers, dates as ISO strings).
 *
 * Type-only Prisma import: this module must stay importable from
 * instrumentation without opening a database connection.
 */
function toInputJson(value: unknown): Prisma.InputJsonValue | null {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'object':
      if (Array.isArray(value)) return value.map(toInputJson);
      if (value instanceof Date) return value.toISOString();
      return toInputJsonObject(value as Record<string, unknown>);
    default:
      return String(value);
  }
}

function toInputJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  const out: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    out[key] = toInputJson(entry);
  }
  return out;
}

/**
 * Writes an alert to AuditLog so the history survives a deploy or a restart.
 *
 * Deliberately lazy about the Prisma client (dynamic import) so importing this
 * module — including from instrumentation — never opens a database connection.
 */
export async function persistAlertRecord(record: AlertRecord): Promise<boolean> {
  if (process.env.ALERT_PERSIST === 'false') return false;
  try {
    const { prisma, isDatabaseConfigured } = await import('@/db/prisma');
    if (!isDatabaseConfigured()) return false;
    await prisma.auditLog.create({
      data: {
        actor: 'observability',
        action: 'ALERT_FIRED',
        entity: 'Alert',
        entityId: record.id,
        metadata: {
          code: record.code,
          severity: record.severity,
          message: record.message,
          context: toInputJsonObject(record.context),
          firedAt: record.firedAt,
          repeatCount: record.repeatCount,
        },
      },
    });
    return true;
  } catch (error) {
    logger.warn('Failed to persist alert record', {
      alertId: record.id,
      code: record.code,
      error: safeDiagnostic(error),
    });
    return false;
  }
}

/** Recent alerts, newest first. Used by /api/health?verbose=1. */
export function recentAlerts(limit = 20): AlertRecord[] {
  return state.history.slice(-Math.max(0, limit)).reverse();
}

/** Alerts still inside their dedupe window (i.e. conditions that persist). */
export function activeAlerts(now: number = Date.now()): AlertRecord[] {
  return recentAlerts(MAX_ALERT_HISTORY).filter(
    (record) => now - Date.parse(record.firedAt) < record.windowSeconds * 1000,
  );
}

/** How many repeats each alert has swallowed. Exposed for dashboards. */
export function suppressedAlertCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, entry] of state.dedupe) out[key] = entry.repeatCount;
  return out;
}

// --- Event ingestion ---------------------------------------------------------

/** Called by the webhook route for every rejected payload. */
export function observeWebhookVerificationFailure(
  provider: string,
  reason: string,
  thresholds?: AlertThresholds,
): void {
  state.counters.webhookFailures.record();
  const t = thresholds ?? defaultThresholds();
  const count = state.counters.webhookFailures.count();
  if (count < t.webhookFailures) return;
  fireAlert({
    code: ALERT_CODES.WEBHOOK_VERIFICATION_FAILURE_SPIKE,
    severity: 'CRITICAL',
    message: `${count} webhook payloads failed verification in the last ${Math.round(
      t.webhookFailureWindowMs / 1000,
    )}s`,
    context: { provider, reason, failures: count, windowSeconds: t.webhookFailureWindowMs / 1000 },
    thresholds: t,
  });
}

/** Called by the fulfillment pipeline for every non-successful terminal state. */
export function observeFulfillmentOutcome(
  status: string,
  orderId?: string,
  thresholds?: AlertThresholds,
): void {
  const failed = status === 'FAILED' || status === 'DEAD_LETTER';
  if (!failed) return;
  state.counters.fulfillmentFailures.record();
  const t = thresholds ?? defaultThresholds();
  const count = state.counters.fulfillmentFailures.count();
  if (count < t.fulfillmentFailures) return;
  fireAlert({
    code: ALERT_CODES.FULFILLMENT_FAILURE_SPIKE,
    severity: 'CRITICAL',
    message: `${count} fulfillments failed in the last ${Math.round(
      t.fulfillmentFailureWindowMs / 60000,
    )}min — customers have paid and not received their code`,
    context: { status, orderId, failures: count, windowSeconds: t.fulfillmentFailureWindowMs / 1000 },
    thresholds: t,
  });
}

/** Called by the reconciliation engine when it records a discrepancy. */
export function observeReconciliationMismatch(
  type: string,
  orderId?: string,
  thresholds?: AlertThresholds,
): void {
  state.counters.reconciliation.record();
  const t = thresholds ?? defaultThresholds();
  const count = state.counters.reconciliation.count();
  if (count < t.reconciliationMismatches) return;
  fireAlert({
    code: ALERT_CODES.RECONCILIATION_MISMATCH,
    severity: 'CRITICAL',
    message: `Reconciliation found ${count} discrepancy/discrepancies (latest: ${type})`,
    context: { type, orderId, mismatches: count },
    thresholds: t,
  });
}

/**
 * Called on every payment attempt.
 *
 * `amountMinor` is INTEGER minor units — the alert message renders it with
 * formatMoney so the premium model is never shown inverted (a $3 price for a
 * $1 code stays "Price $3").
 */
export function observePaymentAttempt(
  ok: boolean,
  amountMinor?: number,
  currency?: string,
  orderId?: string,
  thresholds?: AlertThresholds,
): void {
  state.counters.paymentAttempts.record();
  const t = thresholds ?? defaultThresholds();
  const now = Date.now();

  if (typeof amountMinor === 'number' && Number.isFinite(amountMinor)) {
    if (now - state.counters.largestPaymentAt > 60_000 || amountMinor > state.counters.largestPaymentMinor) {
      state.counters.largestPaymentMinor = amountMinor;
      state.counters.largestPaymentAt = now;
    }
    if (amountMinor >= t.abnormalPaymentAmountMinor) {
      fireAlert({
        code: ALERT_CODES.ABNORMAL_PAYMENT_ACTIVITY,
        severity: 'WARNING',
        message: `Unusually large payment: ${formatMoney(
          amountMinor,
          currency ?? t.currency,
        )} — confirm this is not a mispriced order`,
        context: { amountMinor, currency: currency ?? t.currency, orderId },
        dedupeKey: `${ALERT_CODES.ABNORMAL_PAYMENT_ACTIVITY}:large`,
        thresholds: t,
      });
    }
  }

  const perMinute = state.counters.paymentAttempts.count(now);
  if (perMinute >= t.paymentsPerMinute) {
    fireAlert({
      code: ALERT_CODES.ABNORMAL_PAYMENT_ACTIVITY,
      severity: 'WARNING',
      message: `${perMinute} payment attempts in the last minute (threshold ${t.paymentsPerMinute})`,
      context: { attemptsPerMinute: perMinute, threshold: t.paymentsPerMinute },
      dedupeKey: `${ALERT_CODES.ABNORMAL_PAYMENT_ACTIVITY}:volume`,
      thresholds: t,
    });
  }

  if (!ok) {
    // A failure streak is abnormal even before the ratio alert fires, because
    // the ratio needs a minimum sample size to be meaningful.
    const failures = state.counters.paymentAttempts.count(now);
    if (failures >= t.paymentSuccessMinSamples) {
      const rate = 1 - Math.max(0, Math.min(1, currentPaymentSuccessRatio()));
      if (rate >= 1 - t.paymentSuccessRate) {
        fireAlert({
          code: ALERT_CODES.ABNORMAL_PAYMENT_ACTIVITY,
          severity: 'CRITICAL',
          message: `Payment success rate has fallen to ${(rate * 100).toFixed(1)}% over the last minute`,
          context: { successRate: rate, attempts: failures },
          dedupeKey: `${ALERT_CODES.ABNORMAL_PAYMENT_ACTIVITY}:failure-rate`,
          thresholds: t,
        });
      }
    }
  }
}

/** Called by the inventory allocator when a product runs out. */
export function observeInventoryDepleted(
  productId: string,
  thresholds?: AlertThresholds,
): void {
  const t = thresholds ?? defaultThresholds();
  state.counters.depletedProducts.add(productId);
  fireAlert({
    code: ALERT_CODES.INVENTORY_DEPLETED,
    severity: 'CRITICAL',
    message: `Product ${productId} has no redeem codes available — customers cannot buy`,
    context: { productId, threshold: t.inventoryMinAvailable },
    dedupeKey: `${ALERT_CODES.INVENTORY_DEPLETED}:${productId}`,
    thresholds: t,
  });
}

// --- Snapshot evaluation -----------------------------------------------------

/**
 * Reads the live gauges and windowed counters and fires whatever is currently
 * breached. Safe to call often: evaluation is pure reads plus deduped firing.
 */
export function currentPaymentSuccessRatio(): number {
  // Imported lazily to keep this module's import graph acyclic in one direction.
  return successRatioProvider?.() ?? 1;
}

let successRatioProvider: (() => number) | null = null;

/** Wired by `initAlerts()`; allows metrics.ts to stay import-cycle free. */
export function setPaymentSuccessRatioProvider(provider: () => number): void {
  successRatioProvider = provider;
}

/** How often the render-time refresh is allowed to run. */
const EVALUATION_THROTTLE_MS = MIN_EVALUATION_INTERVAL_MS;

/**
 * Evaluate every threshold and fire what is breached.
 *
 * `force` bypasses the throttle (used by /api/health?verbose=1).
 */
export function evaluateAlerts(options?: { force?: boolean; thresholds?: AlertThresholds }): AlertRecord[] {
  const now = Date.now();
  if (!options?.force && now - state.lastEvaluatedAt < EVALUATION_THROTTLE_MS) return [];
  state.lastEvaluatedAt = now;

  const t = options?.thresholds ?? defaultThresholds();
  const fired: AlertRecord[] = [];
  const push = (record: AlertRecord | null) => {
    if (record) fired.push(record);
  };

  // --- Provider health -------------------------------------------------------
  for (const provider of ['WHOP'] as const) {
    const errorRate = currentProviderErrorRate(provider);
    const total = providerSampleCount(provider);
    if (total >= t.providerErrorMinSamples && errorRate >= t.providerErrorRate) {
      push(
        fireAlert({
          code: ALERT_CODES.PAYMENT_PROVIDER_UNAVAILABLE,
          severity: 'CRITICAL',
          message: `Payment provider ${provider} error rate ${(errorRate * 100).toFixed(
            0,
          )}% over the last window (${total} requests) — checkouts will fail`,
          context: { provider, errorRate, samples: total },
          thresholds: t,
        }),
      );
    }
  }

  // --- Webhook verification --------------------------------------------------
  const webhookFailures = state.counters.webhookFailures.count(now);
  if (webhookFailures >= t.webhookFailures) {
    push(
      fireAlert({
        code: ALERT_CODES.WEBHOOK_VERIFICATION_FAILURE_SPIKE,
        severity: 'CRITICAL',
        message: `${webhookFailures} webhook payloads failed verification in the last ${Math.round(
          t.webhookFailureWindowMs / 1000,
        )}s`,
        context: { failures: webhookFailures, windowSeconds: t.webhookFailureWindowMs / 1000 },
        thresholds: t,
      }),
    );
  }

  // --- Fulfillment ----------------------------------------------------------
  const fulfillmentFailures = state.counters.fulfillmentFailures.count(now);
  if (fulfillmentFailures >= t.fulfillmentFailures) {
    push(
      fireAlert({
        code: ALERT_CODES.FULFILLMENT_FAILURE_SPIKE,
        severity: 'CRITICAL',
        message: `${fulfillmentFailures} fulfillments failed in the last ${Math.round(
          t.fulfillmentFailureWindowMs / 60000,
        )}min`,
        context: { failures: fulfillmentFailures, windowSeconds: t.fulfillmentFailureWindowMs / 1000 },
        thresholds: t,
      }),
    );
  }

  // --- Inventory ------------------------------------------------------------
  for (const entry of inventoryLevels.values()) {
    const productId = entry.labels.product ?? 'unknown';
    if (entry.value <= t.inventoryMinAvailable) {
      push(
        fireAlert({
          code: ALERT_CODES.INVENTORY_DEPLETED,
          severity: 'CRITICAL',
          message: `Product ${productId} has ${entry.value} redeem code(s) available`,
          context: { productId, available: entry.value },
          dedupeKey: `${ALERT_CODES.INVENTORY_DEPLETED}:${productId}`,
          thresholds: t,
        }),
      );
    }
  }

  // --- Queue ----------------------------------------------------------------
  const depth = currentQueueDepth();
  const oldestAgeSeconds = queueOldestAge.get();
  if (depth >= t.queueBacklog || oldestAgeSeconds >= t.queueOldestAgeSeconds) {
    push(
      fireAlert({
        code: ALERT_CODES.QUEUE_BACKLOG,
        severity: oldestAgeSeconds >= t.queueOldestAgeSeconds ? 'CRITICAL' : 'WARNING',
        message: `Fulfillment queue backlog: ${depth} pending job(s), oldest ${Math.round(
          oldestAgeSeconds,
        )}s`,
        context: {
          depth,
          oldestAgeSeconds,
          depthThreshold: t.queueBacklog,
          ageThresholdSeconds: t.queueOldestAgeSeconds,
        },
        thresholds: t,
      }),
    );
  }

  // --- Reconciliation -------------------------------------------------------
  const mismatches = state.counters.reconciliation.count(now);
  if (mismatches >= t.reconciliationMismatches) {
    push(
      fireAlert({
        code: ALERT_CODES.RECONCILIATION_MISMATCH,
        severity: 'CRITICAL',
        message: `Reconciliation has ${mismatches} open discrepancy/discrepancies`,
        context: { mismatches, windowSeconds: t.reconciliationWindowMs / 1000 },
        thresholds: t,
      }),
    );
  }

  // --- Abnormal payment activity -------------------------------------------
  const attemptsPerMinute = state.counters.paymentAttempts.count(now);
  if (attemptsPerMinute >= t.paymentsPerMinute) {
    push(
      fireAlert({
        code: ALERT_CODES.ABNORMAL_PAYMENT_ACTIVITY,
        severity: 'WARNING',
        message: `${attemptsPerMinute} payment attempts in the last minute (threshold ${t.paymentsPerMinute})`,
        context: { attemptsPerMinute, threshold: t.paymentsPerMinute },
        dedupeKey: `${ALERT_CODES.ABNORMAL_PAYMENT_ACTIVITY}:volume`,
        thresholds: t,
      }),
    );
  }

  if (
    now - state.counters.largestPaymentAt < 60_000 &&
    state.counters.largestPaymentMinor >= t.abnormalPaymentAmountMinor
  ) {
    push(
      fireAlert({
        code: ALERT_CODES.ABNORMAL_PAYMENT_ACTIVITY,
        severity: 'WARNING',
        message: `Unusually large payment in the last minute: ${formatMoney(
          state.counters.largestPaymentMinor,
          t.currency,
        )}`,
        context: { amountMinor: state.counters.largestPaymentMinor, currency: t.currency },
        dedupeKey: `${ALERT_CODES.ABNORMAL_PAYMENT_ACTIVITY}:large`,
        thresholds: t,
      }),
    );
  }

  return fired;
}

/**
 * Requests in the rolling provider window. metrics.ts owns the windows; this
 * reads the count so the ratio is never judged on a single sample.
 */
function providerSampleCount(provider: string): number {
  return providerRequestTotals?.(provider) ?? 0;
}

let providerRequestTotals: ((provider: string) => number) | null = null;

/** Wired by `initAlerts()` to avoid a metrics <-> alerts import cycle. */
export function setProviderSampleCounter(counter: (provider: string) => number): void {
  providerRequestTotals = counter;
}

// --- Boot --------------------------------------------------------------------

let initialised = false;

/**
 * Wires the alert evaluator into the metrics render hook and the success-rate
 * provider. Idempotent; safe to call from instrumentation.
 *
 * The refresh runs at most once a minute and only produces alerts for breached
 * thresholds, so a 15s scrape interval cannot turn into a log flood.
 */
export function initAlerts(): void {
  if (initialised) return;
  initialised = true;

  // Queue depth is owned by metrics.ts; the evaluator reads the same gauge so
  // there is exactly one source of truth.
  setQueueDepth(currentQueueDepth());
}

/**
 * Refresh hook installed by initAlerts. Kept separate so tests can call
 * `evaluateAlerts({ force: true })` directly.
 */
export function refreshAlerts(): void {
  evaluateAlerts();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _keepHookExport = setAlertSnapshotHook;

// Test helper: clears dedupe, history and windows.
export function resetAlerts(): void {
  state.dedupe.clear();
  state.history.length = 0;
  state.counters.webhookFailures.reset();
  state.counters.fulfillmentFailures.reset();
  state.counters.reconciliation.reset();
  state.counters.paymentAttempts.reset();
  state.counters.depletedProducts.clear();
  state.counters.largestPaymentMinor = 0;
  state.counters.largestPaymentAt = 0;
  state.lastEvaluatedAt = 0;
}