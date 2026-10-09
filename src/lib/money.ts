/**
 * Money handling.
 *
 * INVARIANT: all money is an integer count of a currency's MINOR units.
 * Never floats, never Decimal from a float, never `parseFloat` on user input.
 *
 * Why this matters concretely: a $1 code sold at $3 with a 2.7% + $0.30
 * processor fee leaves ~$2.19 gross before supplier cost. Float drift on a
 * rounding boundary is the difference between a product publishing at 5%
 * margin and being auto-hidden by the margin engine. Integers make the
 * arithmetic exact and the business rules reproducible.
 *
 * Whop additionally returns money as DECIMAL STRINGS in major units
 * ("29.99"), so `fromProviderDecimal` exists to convert without float loss.
 */

export type Currency = string; // ISO 4217, lowercase to match Whop's wire format

/** Currencies whose minor unit is not 1/100. Extend as needed. */
const MINOR_UNIT_EXPONENTS: Record<string, number> = {
  usd: 2,
  inr: 2,
  eur: 2,
  gbp: 2,
  cad: 2,
  aud: 2,
  jpy: 0, // yen has no minor unit
  cop: 2,
};

export function minorUnitExponent(currency: Currency): number {
  return MINOR_UNIT_EXPONENTS[currency.toLowerCase()] ?? 2;
}

/**
 * Parse a decimal string from a payment provider into minor units, exactly.
 * Handles "29.99", "29", "29.9", "-5.00". Rejects anything that is not a
 * clean decimal — notably NaN, Infinity, exponent notation and empty input,
 * all of which would otherwise flow through Number() silently.
 */
export function fromProviderDecimal(value: string, currency: Currency): number {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid monetary decimal from provider: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = unsigned.split('.');

  // Guard against provider values with more precision than the currency
  // supports (e.g. "29.999" in USD) rather than silently truncating.
  if (frac.length > minorUnitExponent(currency)) {
    throw new Error(
      `Amount ${trimmed} has more precision than ${currency.toUpperCase()} supports`,
    );
  }

  const padded = frac.padEnd(minorUnitExponent(currency), '0');
  const minor = Number(whole) * 10 ** minorUnitExponent(currency) + Number(padded || '0');
  return negative ? -minor : minor;
}

/** Render minor units as a decimal string, e.g. 300 USD -> "3.00". */
export function toProviderDecimal(minor: number, currency: Currency): string {
  const exp = minorUnitExponent(currency);
  if (exp === 0) return String(minor);
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const divisor = 10 ** exp;
  const whole = Math.floor(abs / divisor);
  const frac = String(abs % divisor).padStart(exp, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** Human display string, e.g. 300 USD -> "$3.00". */
export function formatMoney(minor: number, currency: Currency): string {
  const exp = minorUnitExponent(currency);
  const symbol = currency.toUpperCase() === 'USD' ? '$' : '';
  const suffix = symbol ? '' : ` ${currency.toUpperCase()}`;
  if (exp === 0) return `${symbol}${minor}${suffix}`;
  const abs = Math.abs(minor);
  const divisor = 10 ** exp;
  const whole = Math.floor(abs / divisor);
  const frac = String(abs % divisor).padStart(exp, '0');
  const grouped = whole.toLocaleString('en-US');
  return `${minor < 0 ? '-' : ''}${symbol}${grouped}.${frac}${suffix}`;
}

/**
 * Basis points, integer math only.
 * discount = how far BELOW face value the customer is paying, so a $3 price
 * for a $1 code is a NEGATIVE discount (-20000 bps) — i.e. a premium. The
 * storefront shows "Price $3 · Value $1"; it never inverts this.
 */
export function discountBps(faceValueMinor: number, sellingPriceMinor: number): number {
  if (faceValueMinor === 0) return 0;
  return Math.round(((faceValueMinor - sellingPriceMinor) * 10_000) / faceValueMinor);
}

/** Margin over supplier cost. 2000 bps = 20% gross margin. */
export function marginBps(sellingPriceMinor: number, supplierCostMinor: number): number {
  if (sellingPriceMinor === 0) return 0;
  return Math.round(((sellingPriceMinor - supplierCostMinor) * 10_000) / sellingPriceMinor);
}

/** Absolute gross profit in minor units. May be negative. */
export function grossProfitMinor(sellingPriceMinor: number, supplierCostMinor: number): number {
  return sellingPriceMinor - supplierCostMinor;
}

export function bpsToPercent(bps: number): number {
  return bps / 100;
}