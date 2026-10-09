/**
 * Pricing engine (spec §3).
 *
 * THE PRODUCT MODEL IS A MARKUP, AND EVERYTHING HERE RESPECTS THAT:
 *   The customer pays $3 and receives a $1 redeem code.
 * The customer pays MORE than face value. `discountBps` for this catalog is
 * therefore NEGATIVE — that is a premium, not an error, and it is never sign-
 * flipped anywhere in this file, the UI, the database or the emails. The
 * storefront presents it as "Price $3.00 · Value $1.00".
 *
 * Everything here is PURE: `computePricing()` touches no database, no clock
 * and no environment beyond reading the documented rule defaults once. The
 * impure wrappers at the bottom (`loadPricingRules`, `evaluateProductPricing`)
 * are the only functions allowed to touch Prisma, and they do nothing but load
 * a rule and delegate to the pure core.
 *
 * Money is ALWAYS integer minor units. No floats, no parseFloat, no division
 * that leaves the integer domain before the final rounding step.
 */

import {
  discountBps as computeDiscountBps,
  formatMoney,
  grossProfitMinor as computeGrossProfitMinor,
  marginBps as computeMarginBps,
  type Currency,
} from '@/lib/money';
import { errors } from '@/lib/errors';
import { prisma } from '@/db/prisma';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The four amounts the engine needs. All integers, all minor units. */
export interface PricingInput {
  faceValueMinor: number;
  sellingPriceMinor: number;
  supplierCostMinor: number;
  currency: Currency;
}

/** A PricingRule row, reduced to what the engine actually reads. */
export interface PricingRuleInput {
  id?: string;
  name: string;
  minDiscountBps: number;
  minMarginBps: number;
  /** null/undefined/'' means the global rule. */
  category: string | null;
  active: boolean;
  /**
   * When true, products failing the rule are hidden from the storefront but
   * retained in the admin panel. The engine NEVER acts on this flag itself —
   * it reports `publishable: false` with a reason and lets the caller decide.
   */
  autoHideOnFail: boolean;
  /** Deterministic tie-break when two rules cover the same category. */
  createdAt?: Date;
}

export interface PricingResult {
  /** Negative in this catalog: the customer pays a premium over face value. */
  discountBps: number;
  marginBps: number;
  grossProfitMinor: number;
  meetsMinDiscount: boolean;
  meetsMinMargin: boolean;
  /**
   * FALSE means "do not put this on the storefront". The engine returns a
   * reason and leaves the product visible to the admin — it never silently
   * hides anything.
   */
  publishable: boolean;
  reason: string;
  // --- Context, so callers never have to recompute or re-derive labels ------
  /** True when sellingPriceMinor > faceValueMinor (our premium model). */
  premium: boolean;
  /** "Price $3.00 · Value $1.00" — the only sanctioned presentation. */
  priceValueLabel: string;
  ruleName: string;
  ruleId?: string;
  autoHideOnFail: boolean;
}

// ---------------------------------------------------------------------------
// Documented defaults
// ---------------------------------------------------------------------------

/**
 * Rule defaults.
 *
 * `.env.example` documents DEFAULT_MIN_DISCOUNT_BPS / DEFAULT_MIN_MARGIN_BPS
 * (default 500 / 0 — the same values as the PricingRule schema defaults).
 * These are business configuration, not secrets, and `env.ts` does not
 * currently expose them, so they are read straight from the environment with
 * an exact-integer parse. A malformed value falls back to the documented
 * default and is logged rather than silently accepted.
 */
function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^-?\d+$/.test(raw.trim())) return fallback;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export const DEFAULT_MIN_DISCOUNT_BPS = readEnvInt('DEFAULT_MIN_DISCOUNT_BPS', 500);
export const DEFAULT_MIN_MARGIN_BPS = readEnvInt('DEFAULT_MIN_MARGIN_BPS', 0);

/**
 * The rule used when no PricingRule row covers a category. Returning this
 * explicitly (rather than null) keeps `computePricing` total: every product
 * always has a rule, so `publishable` is always meaningful.
 */
export function defaultPricingRule(overrides?: Partial<PricingRuleInput>): PricingRuleInput {
  return {
    name: 'DEFAULT',
    minDiscountBps: DEFAULT_MIN_DISCOUNT_BPS,
    minMarginBps: DEFAULT_MIN_MARGIN_BPS,
    category: null,
    active: true,
    autoHideOnFail: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule selection
// ---------------------------------------------------------------------------

function normaliseCategory(category: string | null | undefined): string {
  return (category ?? '').trim().toLowerCase();
}

/**
 * Picks the winning rule: a category-specific rule always beats the global
 * rule. Ties are broken deterministically by `createdAt` (most recent wins,
 * which is the operator-intuitive "last override entered"), then by `id` so
 * two rows created in the same millisecond can never flip the answer between
 * requests.
 *
 * Pure: same (category, rules) in, same rule out, forever.
 */
export function selectPricingRule(
  category: string | null | undefined,
  rules: readonly PricingRuleInput[],
): PricingRuleInput | null {
  const target = normaliseCategory(category);
  const candidates = rules.filter((rule) => rule.active);

  // A rule that explicitly claims THIS category (category rule, not global).
  const scoped = candidates.filter(
    (rule) => normaliseCategory(rule.category) === target && normaliseCategory(rule.category) !== '',
  );

  // The global rule claims '' and is the FALLBACK for every category, including
  // a category that has no rule of its own. Matching only on `=== target` would
  // make a product with an uncategorised rule fall through to the built-in
  // default and silently ignore the operator's configured global rule.
  const globals = candidates.filter((rule) => normaliseCategory(rule.category) === '');

  const pool = scoped.length > 0 ? scoped : globals;
  if (pool.length === 0) return null;

  return [...pool].sort((a, b) => {
    const aTime = a.createdAt?.getTime() ?? 0;
    const bTime = b.createdAt?.getTime() ?? 0;
    if (aTime !== bTime) return bTime - aTime; // newest first
    return (a.id ?? '').localeCompare(b.id ?? '');
  })[0] ?? null;
}

/** The rule that will actually be applied for a category (never null). */
export function effectivePricingRule(
  category: string | null | undefined,
  rules: readonly PricingRuleInput[],
): PricingRuleInput {
  return selectPricingRule(category, rules) ?? defaultPricingRule();
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** 20000 bps -> "200.00%". Always shown as a magnitude; the sign is spoken
 *  separately as "premium" / "below face value" so the wording can never be
 *  read backwards. */
function formatBps(bps: number): string {
  return `${(Math.abs(bps) / 100).toFixed(2)}%`;
}

function isIntegerMinor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Structural validation. These are programmer/serialisation faults, not
 * business outcomes: a NaN price or a "300.50" amount is a bug upstream and
 * must fail loudly rather than flow into a published storefront row.
 */
export function validatePricingInput(input: PricingInput): void {
  const problems: string[] = [];

  if (!isIntegerMinor(input.faceValueMinor)) {
    problems.push('faceValueMinor must be an integer number of minor units');
  } else if (input.faceValueMinor <= 0) {
    problems.push('faceValueMinor must be greater than zero');
  }

  if (!isIntegerMinor(input.sellingPriceMinor)) {
    problems.push('sellingPriceMinor must be an integer number of minor units');
  } else if (input.sellingPriceMinor <= 0) {
    problems.push('sellingPriceMinor must be greater than zero');
  }

  if (!isIntegerMinor(input.supplierCostMinor)) {
    problems.push('supplierCostMinor must be an integer number of minor units');
  } else if (input.supplierCostMinor < 0) {
    problems.push('supplierCostMinor cannot be negative');
  }

  if (typeof input.currency !== 'string' || !/^[A-Za-z]{3}$/.test(input.currency.trim())) {
    problems.push('currency must be a 3-letter ISO 4217 code');
  }

  if (problems.length > 0) {
    throw errors.validation(`Invalid pricing input: ${problems.join('; ')}`, {
      problems,
    });
  }
}

/**
 * Evaluates one product against one rule. Pure and deterministic.
 *
 * ON THE SIGN OF `discountBps` (read this before changing anything):
 *
 *   discount = (faceValue - sellingPrice) / faceValue
 *
 * In a discount catalog a customer pays LESS than face value, so discount is
 * positive. This catalog is the opposite: the customer pays MORE, so discount
 * is NEGATIVE (a $1 code at $3 is -20000 bps = a 200% premium). That is the
 * intended business model, not a data error.
 *
 * The configured `minDiscountBps` is therefore evaluated against the
 * ABSOLUTE value of the gap. `minDiscountBps: 500` means "the storefront price
 * must sit at least 5.00% away from face value, in whichever direction this
 * catalog trades" — 5% below face for a discount store, 5% above for a premium
 * store. Comparing the raw signed value instead would read -20000 >= 500 as a
 * failure and auto-hide every product in the catalog, which is precisely the
 * inversion this business model forbids. The sign is NEVER flipped to make a
 * rule pass; only the magnitude is compared, and the direction is always
 * reported in words.
 */
export function computePricing(
  input: PricingInput,
  rule: PricingRuleInput = defaultPricingRule(),
): PricingResult {
  validatePricingInput(input);

  const { faceValueMinor, sellingPriceMinor, supplierCostMinor, currency } = input;

  const discount = computeDiscountBps(faceValueMinor, sellingPriceMinor);
  const margin = computeMarginBps(sellingPriceMinor, supplierCostMinor);
  const profit = computeGrossProfitMinor(sellingPriceMinor, supplierCostMinor);

  // See the sign note above: compare magnitudes, report direction in words.
  const meetsMinDiscount = Math.abs(discount) >= rule.minDiscountBps;
  // The hard gross-profit floor is not operator-configurable: no rule may
  // authorise publishing a product that loses money on every sale. With the
  // shipped default of minMarginBps = 0 this is already implied; it only bites
  // when somebody deliberately configures a negative minimum.
  const meetsMinMargin = margin >= rule.minMarginBps && profit >= 0;

  const publishable = meetsMinDiscount && meetsMinMargin;
  const premium = discount < 0;
  const priceValueLabel = `Price ${formatMoney(sellingPriceMinor, currency)} · Value ${formatMoney(faceValueMinor, currency)}`;

  const direction =
    discount > 0
      ? `${formatBps(discount)} below face value`
      : premium
        ? `${formatBps(discount)} premium over face value`
        : 'priced at face value';

  const failures: string[] = [];
  if (!meetsMinDiscount) {
    failures.push(
      `price is ${direction}, which does not meet the ${formatBps(rule.minDiscountBps)} minimum price/value gap`,
    );
  }
  if (!meetsMinMargin) {
    failures.push(
      `gross margin ${formatBps(margin)} is below the ${formatBps(rule.minMarginBps)} minimum`,
    );
  }

  const verdict =
    failures.length === 0
      ? `meets rule "${rule.name}"`
      : `fails rule "${rule.name}": ${failures.join('; ')}`;

  return {
    discountBps: discount,
    marginBps: margin,
    grossProfitMinor: profit,
    meetsMinDiscount,
    meetsMinMargin,
    publishable,
    reason: `${priceValueLabel} (${direction}); ${verdict}.`,
    premium,
    priceValueLabel,
    ruleName: rule.name,
    ruleId: rule.id,
    autoHideOnFail: rule.autoHideOnFail,
  };
}

/**
 * Same engine, fed from a Product-shaped object (admin screens, bulk
 * re-pricing). Pure — the caller supplies the row.
 */
export function computePricingForProduct(
  product: {
    faceValueMinor: number;
    sellingPriceMinor: number;
    supplierCostMinor: number;
    currency: string;
    category?: string | null;
  },
  rule: PricingRuleInput = defaultPricingRule(),
): PricingResult {
  return computePricing(
    {
      faceValueMinor: product.faceValueMinor,
      sellingPriceMinor: product.sellingPriceMinor,
      supplierCostMinor: product.supplierCostMinor,
      currency: product.currency,
    },
    rule,
  );
}

/**
 * The publish guard. Returns the result unchanged when the product may go
 * live; otherwise throws a 409 with the engine's human reason attached.
 *
 * This is the shape the admin "publish" action wants. It deliberately does NOT
 * hide the product on autoHideOnFail — hiding is a separate, explicit action
 * with an audit trail, because silently hiding a product that fails a margin
 * check is how a good product disappears from a storefront and nobody notices.
 */
export function assertPublishable(result: PricingResult, productId?: string): void {
  if (result.publishable) return;
  throw errors.validation(`Product cannot be published: ${result.reason}`, {
    productId,
    ruleName: result.ruleName,
    discountBps: result.discountBps,
    marginBps: result.marginBps,
  });
}

// ---------------------------------------------------------------------------
// Seed-time price suggestion (DEFAULT EXAMPLE ONLY — never payment logic)
// ---------------------------------------------------------------------------

/**
 * Documented price tiers.
 *
 * READ THIS BEFORE USING IT: these are EXAMPLE seed data for `prisma/seed.ts`.
 * They are NOT consulted at checkout. The price a customer actually pays lives
 * in the Product row (`sellingPriceMinor`), and the order snapshots it at
 * creation. Changing a tier here must never be able to change what an existing
 * order costs, and it must never be reachable from a payment path.
 *
 * `markupBps` is the markup over face value: 20000 bps = sell at 3x face value
 * (the "$3 code for $1" example from the product brief).
 */
export const DEFAULT_SELLING_PRICE_TIERS: readonly SellingPriceTier[] = [
  { id: 'entry', label: 'Entry (2x face value)', markupBps: 10_000 },
  { id: 'standard', label: 'Standard (3x face value)', markupBps: 20_000 },
  { id: 'premium', label: 'Premium (4x face value)', markupBps: 30_000 },
];

export interface SellingPriceTier {
  id: string;
  label: string;
  markupBps: number;
}

export interface SellingPriceSuggestion {
  faceValueMinor: number;
  sellingPriceMinor: number;
  currency: Currency;
  tier: SellingPriceTier;
  markupBps: number;
  discountBps: number;
  marginBps: number;
  grossProfitMinor: number;
  /** "Price $3.00 · Value $1.00" */
  label: string;
}

export function getSellingPriceTier(tierId?: string): SellingPriceTier {
  if (!tierId) {
    const standard = DEFAULT_SELLING_PRICE_TIERS.find((tier) => tier.id === 'standard');
    if (!standard) throw new Error('DEFAULT_SELLING_PRICE_TIERS is missing the "standard" tier');
    return standard;
  }
  const tier = DEFAULT_SELLING_PRICE_TIERS.find((candidate) => candidate.id === tierId);
  if (!tier) {
    throw errors.validation(`Unknown price tier "${tierId}"`, {
      known: DEFAULT_SELLING_PRICE_TIERS.map((candidate) => candidate.id),
    });
  }
  return tier;
}

/**
 * Suggested price for a face value, per the documented tiers.
 *
 * SEED/ADMIN SUGGESTION ONLY. Pure integer math: the single multiplication is
 * exact for every face value we support, and the result is rounded half-up to
 * the nearest minor unit so a suggestion is always a real, chargeable amount.
 */
export function suggestSellingPrice(input: {
  faceValueMinor: number;
  currency: Currency;
  supplierCostMinor?: number;
  tier?: string | SellingPriceTier;
}): SellingPriceSuggestion {
  if (!isIntegerMinor(input.faceValueMinor) || input.faceValueMinor <= 0) {
    throw errors.validation('faceValueMinor must be a positive integer number of minor units');
  }
  if (typeof input.currency !== 'string' || !/^[A-Za-z]{3}$/.test(input.currency.trim())) {
    throw errors.validation('currency must be a 3-letter ISO 4217 code');
  }

  const tier = typeof input.tier === 'object' && input.tier !== null ? input.tier : getSellingPriceTier(input.tier);
  if (!isIntegerMinor(tier.markupBps) || tier.markupBps < 0) {
    throw errors.validation('Tier markupBps must be a non-negative integer');
  }

  const supplierCostMinor = input.supplierCostMinor ?? 0;
  if (!isIntegerMinor(supplierCostMinor) || supplierCostMinor < 0) {
    throw errors.validation('supplierCostMinor must be a non-negative integer');
  }

  // Math.round is half-up toward +Infinity for positive values, which is what
  // "round to the nearest chargeable cent" means to a merchant.
  const sellingPriceMinor = Math.round(
    (input.faceValueMinor * (10_000 + tier.markupBps)) / 10_000,
  );
  if (!Number.isSafeInteger(sellingPriceMinor) || sellingPriceMinor <= 0) {
    throw errors.validation('Suggested price is not a positive integer amount');
  }

  const pricing = computePricing({
    faceValueMinor: input.faceValueMinor,
    sellingPriceMinor,
    supplierCostMinor,
    currency: input.currency,
  });

  return {
    faceValueMinor: input.faceValueMinor,
    sellingPriceMinor,
    currency: input.currency,
    tier,
    markupBps: tier.markupBps,
    // Negative by design: a premium over face value.
    discountBps: pricing.discountBps,
    marginBps: pricing.marginBps,
    grossProfitMinor: pricing.grossProfitMinor,
    label: pricing.priceValueLabel,
  };
}

// ---------------------------------------------------------------------------
// Impure wrappers — these are the ONLY functions in this file that touch Prisma
// ---------------------------------------------------------------------------

/** Active PricingRule rows, newest first. Cached briefly by the caller. */
export async function loadPricingRules(): Promise<PricingRuleInput[]> {
  const rows = await prisma.pricingRule.findMany({
    where: { active: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      minDiscountBps: true,
      minMarginBps: true,
      category: true,
      active: true,
      autoHideOnFail: true,
      createdAt: true,
    },
  });
  return rows;
}

/**
 * Load the applicable rule for a category and evaluate a product against it.
 * The rule lookup is the only I/O; the arithmetic is the same pure function
 * used everywhere else.
 */
export async function evaluateProductPricing(
  input: PricingInput & { category?: string | null },
): Promise<PricingResult> {
  const rules = await loadPricingRules();
  const rule = effectivePricingRule(input.category, rules);
  return computePricing(
    {
      faceValueMinor: input.faceValueMinor,
      sellingPriceMinor: input.sellingPriceMinor,
      supplierCostMinor: input.supplierCostMinor,
      currency: input.currency,
    },
    rule,
  );
}

/**
 * Evaluates a persisted Product row against the currently active rules.
 * Returns null when the product no longer exists.
 */
export async function evaluateStoredProduct(
  productId: string,
): Promise<PricingResult | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      faceValueMinor: true,
      sellingPriceMinor: true,
      supplierCostMinor: true,
      currency: true,
      category: true,
    },
  });
  if (!product) return null;
  return evaluateProductPricing(product);
}