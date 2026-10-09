/**
 * Whop money <-> integer minor units.
 *
 * THE RULE: our system only ever holds `amountMinor: number` (an integer) plus
 * a currency. Whop sends `amount` as a DECIMAL STRING IN MAJOR UNITS ("29.99").
 * `Number("29.99")` is 29.989999999999998 in binary floating point, so the
 * conversion goes through `fromProviderDecimal()` which does the scaling with
 * string arithmetic and only touches `Number()` on already-integral pieces.
 *
 * THE BUSINESS RULE THAT MAKES THIS URGENT: the customer pays $3 and receives a
 * $1 redeem code. The $3 is the SELLING PRICE and is the only number that ever
 * crosses this boundary. Nothing here — or anywhere else — may substitute face
 * value for price, or invert "Price $3 / Value $1".
 *
 * Margin context (documented, not enforced here): Whop's baseline card fee is
 * 2.7% + $0.30 per successful transaction, plus $0.03 for 3DS and $0.07 for
 * Radar when they apply. The $0.30 fixed component is per transaction and is
 * NOT amortised across a cart, so on a $3 SKU it is ~10% of revenue on its own.
 * The $15.00 dispute fee and $29.00 early-dispute-alert fee are flat and are
 * the real exposure: one chargeback on a $3 order costs five times the sale.
 */

import { fromProviderDecimal, minorUnitExponent, toProviderDecimal } from '@/lib/money';
import { AppError } from '@/lib/errors';
import { asCurrency, asRecord, type WhopMoney } from './types';

export interface MinorAmount {
  amountMinor: number;
  currency: string;
}

/** Context used in error messages so a mis-scaled value can be traced. */
export interface MoneyContext {
  /** e.g. "payment.total" — where the value came from. */
  field: string;
  /** e.g. a payment id, for log correlation. */
  resourceId?: string;
}

function fail(message: string, context: MoneyContext, cause?: unknown): never {
  throw new AppError(message, 502, 'PAYMENT_VERIFICATION_FAILED', {
    details: { field: context.field, resourceId: context.resourceId },
    cause,
  });
}

/**
 * `fromProviderDecimal` rejects NaN/Infinity/exponent notation/over-precise
 * values by throwing a plain Error. Inside this adapter that becomes a typed
 * PAYMENT_VERIFICATION_FAILED so the failure mode is visible to alerting rather
 * than escaping as a generic 500.
 */
function parseDecimal(value: string, currency: string, context: MoneyContext): number {
  try {
    return fromProviderDecimal(value, currency);
  } catch (error) {
    fail(
      `Whop ${context.field}.amount is not a valid decimal: ${JSON.stringify(value)}`,
      context,
      error,
    );
  }
}

/**
 * Converts a Whop `Money` object into integer minor units.
 *
 * Returns undefined ONLY when the value is genuinely absent (null / not an
 * object) — callers decide whether that is acceptable. A value that is PRESENT
 * but unparseable THROWS, because silently treating "$0.00" as a missing amount
 * would let a payment verify against the wrong expectation.
 */
export function whopMoneyToMinor(money: unknown, context: MoneyContext): MinorAmount | undefined {
  const record = asRecord(money);
  if (!record) return undefined;

  const whopMoney: WhopMoney = record as WhopMoney;

  const rawAmount = whopMoney.amount;
  if (typeof rawAmount !== 'string') {
    fail(
      `Whop ${context.field}.amount is not a decimal string (got ${typeof rawAmount})`,
      context,
    );
  }

  const currency = asCurrency(whopMoney.currency);
  if (!currency) {
    fail(`Whop ${context.field}.currency is missing`, context);
  }

  // Cross-check the currency's minor-unit exponent against Whop's own
  // `decimals`. If they disagree, one of the two is wrong and scaling by the
  // wrong one is a 100x error. Refuse rather than guess.
  const declared = whopMoney.decimals;
  if (typeof declared === 'number' && Number.isInteger(declared)) {
    const expected = minorUnitExponent(currency);
    if (declared !== expected) {
      fail(
        `Whop ${context.field} declares decimals=${declared} but ${currency.toUpperCase()} ` +
          `scales by 10^${expected}. Add the currency to MINOR_UNIT_EXPONENTS in ` +
          `src/lib/money.ts rather than accepting a mis-scaled amount.`,
        context,
      );
    }
  }

  return { amountMinor: parseDecimal(rawAmount, currency, context), currency };
}

/**
 * Reads the first present Money field from a set of candidates. Used because
 * refunds carry `amount` (settlement currency, nets against `total`) while fee
 * lines carry only `amount`, and payments carry `total`.
 */
export function firstMoneyToMinor(
  source: Record<string, unknown> | undefined,
  fields: readonly string[],
  context: MoneyContext,
): MinorAmount | undefined {
  if (!source) return undefined;
  for (const field of fields) {
    const value = whopMoneyToMinor(source[field], { ...context, field });
    if (value) return value;
  }
  return undefined;
}

/**
 * Integer minor units -> the decimal Whop expects on a numeric wire field
 * (`initial_price`, `renewal_price`).
 *
 * Whop's create-checkout schema types `initial_price` as a NUMBER in major
 * units, so this is the one place in the adapter that must produce a float. It
 * is derived from an integer we already hold — never from user input — and the
 * value is round-tripped back through `fromProviderDecimal` as a guard, so a
 * currency whose exponent we get wrong fails here instead of charging a
 * customer $0.03 for a $3 code.
 */
export function minorToWhopPrice(amountMinor: number, currency: string): number {
  if (!Number.isInteger(amountMinor)) {
    throw new AppError('Amount must be an integer number of minor units', 400, 'VALIDATION_FAILED', {
      details: { amountMinor, currency },
    });
  }
  const code = asCurrency(currency);
  if (!code) throw new AppError('Currency is required', 400, 'VALIDATION_FAILED');

  const decimal = toProviderDecimal(amountMinor, code);
  const asNumber = Number(decimal);

  if (fromProviderDecimal(decimal, code) !== amountMinor) {
    throw new AppError(
      `Refusing to send ${amountMinor} minor units as ${code}: it does not round-trip`,
      500,
      'INTERNAL_ERROR',
    );
  }
  return asNumber;
}

/**
 * Net amount and fee for a payment.
 *
 *   fee      = total - amount_after_fees
 *   net      = amount_after_fees
 *
 * `amount_after_fees` is documented as "what you keep", so the dashboard's
 * margin must be computed from it. Reporting `total` as revenue overstates
 * margin by the whole processor fee — on a $3 order that is $0.38, which is
 * more than 10% of the sale.
 *
 * Returns undefined when Whop has not populated `amount_after_fees` (it is null
 * on some list rows). Callers must treat that as "margin unknown", never as
 * "margin equals gross".
 */
export function computeNetAndFee(
  payment: Record<string, unknown> | undefined,
  context: MoneyContext,
): { net: MinorAmount; feeMinor: number; currency: string } | undefined {
  if (!payment) return undefined;
  const total = whopMoneyToMinor(payment.total, { ...context, field: 'payment.total' });
  const afterFees = whopMoneyToMinor(payment.amount_after_fees, {
    ...context,
    field: 'payment.amount_after_fees',
  });
  if (!afterFees) return undefined;
  if (!total) return undefined;

  // A negative or wildly oversized fee means the two Money objects are in
  // different currencies (e.g. `usd_total` vs `total`). Reporting it would
  // corrupt the margin, so we drop the split and keep only the net.
  const feeMinor = total.amountMinor - afterFees.amountMinor;
  if (feeMinor < 0 || feeMinor > total.amountMinor) return undefined;

  return { net: afterFees, feeMinor, currency: afterFees.currency };
}
