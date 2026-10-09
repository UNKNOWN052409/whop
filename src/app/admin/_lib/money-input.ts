/**
 * Money input parsing for admin forms.
 *
 * An operator typing into a price field is entering MAJOR units ("3.00").
 * Everything downstream is integer minor units. This module is the one place
 * that conversion happens, and it is exact:
 *
 *   - the string is matched against a strict decimal grammar before anything
 *     is converted, so "1e3", "NaN", "Infinity", "1,000", "" and " 3 0 " are
 *     REJECTED rather than quietly becoming 1000, NaN or 30;
 *   - `parseFloat` is never used anywhere in this project;
 *   - the conversion reuses `fromProviderDecimal`, which is currency-aware
 *     (JPY has no minor unit) and refuses a value with more precision than the
 *     currency can represent instead of truncating a half-cent away.
 */

import { fromProviderDecimal, minorUnitExponent } from '@/lib/money';
import { errors } from '@/lib/errors';

/** `3`, `3.0`, `3.00`, `-1.25`. No exponent, no separators, no whitespace. */
const STRICT_DECIMAL = /^-?\d+(\.\d+)?$/;

/** A valid 3-letter ISO-4217-shaped code. */
export function normaliseCurrency(raw: string): string {
  const value = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) {
    throw errors.validation('Currency must be a 3-letter code, e.g. USD', { currency: raw });
  }
  return value;
}

/**
 * Parses an operator-entered amount into integer minor units.
 *
 * @throws AppError VALIDATION_FAILED with a message naming the field, so the
 * form can show it verbatim next to the input.
 */
export function parseAmountInput(raw: string, currency: string, field: string): number {
  const trimmed = (raw ?? '').trim();

  if (trimmed === '') {
    throw errors.validation(`${field} is required`, { field });
  }
  if (!STRICT_DECIMAL.test(trimmed)) {
    throw errors.validation(
      `${field} must be a plain decimal amount such as 3.00 (no currency symbol, thousands separator, or exponent)`,
      { field, received: trimmed },
    );
  }

  let minor: number;
  try {
    minor = fromProviderDecimal(trimmed, currency);
  } catch (error) {
    throw errors.validation(
      `${field}: ${error instanceof Error ? error.message : String(error)}`,
      { field, received: trimmed, currency },
    );
  }

  if (!Number.isSafeInteger(minor)) {
    throw errors.validation(`${field} is not a representable amount`, { field, received: trimmed });
  }
  return minor;
}

/** Non-negative variant, for face value / supplier cost / stock thresholds. */
export function parseNonNegativeAmountInput(
  raw: string,
  currency: string,
  field: string,
): number {
  const minor = parseAmountInput(raw, currency, field);
  if (minor < 0) throw errors.validation(`${field} cannot be negative`, { field });
  return minor;
}

/**
 * Renders integer minor units back into an editable major-unit string, so a
 * form round-trips without losing precision or re-parsing "3" as 300.
 */
export function amountInputValue(minor: number, currency: string): string {
  const exp = minorUnitExponent(currency);
  const divisor = 10 ** exp;
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / divisor);
  const frac = exp === 0 ? '' : `.${String(abs % divisor).padStart(exp, '0')}`;
  return `${negative ? '-' : ''}${whole}${frac}`;
}

/**
 * Client-side hint for a price field. Deliberately NOT the source of truth —
 * the server re-parses and re-validates; this only prevents an operator from
 * being told "3 dollars" when they meant "3 cents".
 */
export function minorHint(minor: number, currency: string): string {
  return `${minor} minor units of ${currency.toUpperCase()}`;
}