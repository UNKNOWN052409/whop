/**
 * Money: integer minor units, no floats, ever.
 *
 * These tests are pure — no database, no env, no clock — because every other
 * layer of the system trusts these functions to be exactly right. A rounding
 * drift here is a product that publishes at the wrong margin.
 */

import { describe, expect, it } from 'vitest';
import {
  bpsToPercent,
  discountBps,
  formatMoney,
  fromProviderDecimal,
  grossProfitMinor,
  marginBps,
  minorUnitExponent,
  toProviderDecimal,
} from '@/lib/money';

describe('fromProviderDecimal', () => {
  it('converts decimal strings to exact minor units', () => {
    expect(fromProviderDecimal('29.99', 'usd')).toBe(2999);
    expect(fromProviderDecimal('0.99', 'usd')).toBe(99);
    expect(fromProviderDecimal('3', 'usd')).toBe(300);
    expect(fromProviderDecimal('3.00', 'usd')).toBe(300);
    expect(fromProviderDecimal('0', 'usd')).toBe(0);
    expect(fromProviderDecimal('0.05', 'usd')).toBe(5);
    expect(fromProviderDecimal('0.1', 'usd')).toBe(10);
  });

  it('tolerates surrounding whitespace but nothing else', () => {
    expect(fromProviderDecimal('  29.99 ', 'usd')).toBe(2999);
  });

  it('handles negative amounts (refunds, chargebacks)', () => {
    expect(fromProviderDecimal('-5.00', 'usd')).toBe(-500);
    expect(fromProviderDecimal('-0.01', 'usd')).toBe(-1);
  });

  it('rejects over-precision rather than truncating it', () => {
    expect(() => fromProviderDecimal('29.999', 'usd')).toThrow(/precision/i);
    expect(() => fromProviderDecimal('0.001', 'usd')).toThrow(/precision/i);
    expect(() => fromProviderDecimal('1.234', 'inr')).toThrow(/precision/i);
  });

  it('rejects malformed input instead of coercing it to NaN', () => {
    // The failure mode this guards: Number('abc') -> NaN flowing into a charge.
    expect(() => fromProviderDecimal('abc', 'usd')).toThrow();
    expect(() => fromProviderDecimal('', 'usd')).toThrow();
    expect(() => fromProviderDecimal('   ', 'usd')).toThrow();
    expect(() => fromProviderDecimal('NaN', 'usd')).toThrow();
    expect(() => fromProviderDecimal('Infinity', 'usd')).toThrow();
    // Exponent notation changes the magnitude silently through Number().
    expect(() => fromProviderDecimal('1e5', 'usd')).toThrow();
    expect(() => fromProviderDecimal('1E5', 'usd')).toThrow();
    expect(() => fromProviderDecimal('29,99', 'usd')).toThrow();
    expect(() => fromProviderDecimal('$29.99', 'usd')).toThrow();
    expect(() => fromProviderDecimal('29.99.1', 'usd')).toThrow();
    expect(() => fromProviderDecimal('+29.99', 'usd')).toThrow();
  });

  it('supports zero-decimal currencies (JPY) exactly', () => {
    expect(minorUnitExponent('jpy')).toBe(0);
    expect(minorUnitExponent('JPY')).toBe(0);
    // 300 yen is 300 minor units — no multiplier, no phantom cents.
    expect(fromProviderDecimal('300', 'jpy')).toBe(300);
    expect(fromProviderDecimal('1000', 'jpy')).toBe(1000);
    expect(fromProviderDecimal('0', 'jpy')).toBe(0);
    // A fractional yen is not representable and must be rejected.
    expect(() => fromProviderDecimal('300.50', 'jpy')).toThrow(/precision/i);
    expect(() => fromProviderDecimal('300.1', 'jpy')).toThrow(/precision/i);
  });

  it('defaults unknown currencies to a 2-digit minor unit', () => {
    expect(minorUnitExponent('zzz')).toBe(2);
    expect(fromProviderDecimal('1.23', 'zzz')).toBe(123);
  });

  it('round-trips through toProviderDecimal', () => {
    for (const [value, currency] of [
      ['29.99', 'usd'],
      ['0.05', 'usd'],
      ['-5.00', 'usd'],
      ['300', 'jpy'],
    ] as const) {
      expect(toProviderDecimal(fromProviderDecimal(value, currency), currency)).toBe(value);
    }
    expect(toProviderDecimal(300, 'usd')).toBe('3.00');
    expect(toProviderDecimal(300, 'jpy')).toBe('300');
  });
});

describe('formatMoney', () => {
  it('renders USD with a symbol and grouping', () => {
    expect(formatMoney(300, 'usd')).toBe('$3.00');
    expect(formatMoney(100, 'usd')).toBe('$1.00');
    expect(formatMoney(2999, 'usd')).toBe('$29.99');
    expect(formatMoney(0, 'usd')).toBe('$0.00');
    expect(formatMoney(123456, 'usd')).toBe('$1,234.56');
    expect(formatMoney(-300, 'usd')).toBe('-$3.00');
  });

  it('appends the ISO code for non-USD currencies', () => {
    expect(formatMoney(300, 'inr')).toBe('3.00 INR');
    expect(formatMoney(123456, 'eur')).toBe('1,234.56 EUR');
  });

  it('never shows a minor unit for zero-decimal currencies', () => {
    expect(formatMoney(300, 'jpy')).toBe('300 JPY');
    expect(formatMoney(0, 'jpy')).toBe('0 JPY');
  });

  it('presents the markup model without inverting it', () => {
    // The storefront label for the shipped catalog: $1 code, $3 price.
    expect(`Price ${formatMoney(300, 'usd')} · Value ${formatMoney(100, 'usd')}`).toBe(
      'Price $3.00 · Value $1.00',
    );
  });
});

describe('discountBps — THIS IS THE MARKUP MODEL', () => {
  it('is NEGATIVE when the customer pays more than face value', () => {
    // THE CUSTOMER PAYS $3 AND RECEIVES A $1 CODE. Never inverted.
    expect(discountBps(100, 300)).toBe(-20_000);
    expect(discountBps(100, 300)).toBeLessThan(0);
    expect(discountBps(100, 1000)).toBe(-90_000);
  });

  it('is zero at face value and positive below it', () => {
    expect(discountBps(100, 100)).toBe(0);
    expect(discountBps(300, 100)).toBe(6_667);
    expect(discountBps(100, 75)).toBe(2_500);
  });

  it('returns 0 rather than dividing by zero', () => {
    expect(discountBps(0, 300)).toBe(0);
  });

  it('agrees with the documented example: $3 price for a $1 code is -20000 bps', () => {
    // A sign flip here would render "Save 200%" on a product the customer is
    // paying 3x for, so this assertion is deliberately absolute.
    const faceValueMinor = 100;
    const sellingPriceMinor = 300;
    expect(discountBps(faceValueMinor, sellingPriceMinor)).toBe(-20_000);
    expect(bpsToPercent(discountBps(faceValueMinor, sellingPriceMinor))).toBe(-200);
  });
});

describe('marginBps', () => {
  it('measures margin over supplier cost in basis points', () => {
    expect(marginBps(300, 0)).toBe(10_000);
    expect(marginBps(300, 210)).toBe(3_000);
    expect(marginBps(300, 300)).toBe(0);
  });

  it('is negative when the product loses money on every sale', () => {
    expect(marginBps(300, 400)).toBe(-3_333);
    expect(grossProfitMinor(300, 400)).toBe(-100);
  });

  it('returns 0 rather than dividing by zero', () => {
    expect(marginBps(0, 100)).toBe(0);
  });

  it('uses the $3-for-$1 example consistently', () => {
    // $3 sale, $2.19 after processor fees -> 2700 bps.
    expect(marginBps(300, 219)).toBe(2_700);
    expect(grossProfitMinor(300, 219)).toBe(81);
    expect(bpsToPercent(2_700)).toBe(27);
  });
});