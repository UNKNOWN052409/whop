/**
 * The pricing engine.
 *
 * Pure functions only — computePricing / selectPricingRule touch no database,
 * no clock and no environment beyond the documented rule defaults, so the whole
 * suite runs in milliseconds.
 *
 * THE MODEL IS A MARKUP: the customer pays $3 and receives a $1 code, so
 * `discountBps` is NEGATIVE. Every assertion below is written to catch a
 * sign flip that would read -20000 as "fails the 500 bps minimum" and auto-hide
 * the entire catalog.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_MARGIN_BPS,
  assertPublishable,
  computePricing,
  computePricingForProduct,
  defaultPricingRule,
  effectivePricingRule,
  getSellingPriceTier,
  selectPricingRule,
  suggestSellingPrice,
  validatePricingInput,
  type PricingRuleInput,
} from '@/catalog/pricing';

/** The shipped catalog: $1 code, $3 price, $0.90 supplier cost. */
const MARKUP_PRODUCT = {
  faceValueMinor: 100,
  sellingPriceMinor: 300,
  supplierCostMinor: 90,
  currency: 'usd',
};

function rule(overrides: Partial<PricingRuleInput> = {}): PricingRuleInput {
  return defaultPricingRule({ name: 'TEST RULE', ...overrides });
}

describe('computePricing — the $3 for $1 markup', () => {
  it('reports a NEGATIVE discount and flags the product as a premium', () => {
    const result = computePricing(MARKUP_PRODUCT);
    expect(result.discountBps).toBe(-20_000);
    expect(result.discountBps).toBeLessThan(0);
    expect(result.premium).toBe(true);
  });

  it('presents the label in the correct order: price first, value second', () => {
    const result = computePricing(MARKUP_PRODUCT);
    expect(result.priceValueLabel).toBe('Price $3.00 · Value $1.00');
    expect(result.priceValueLabel.indexOf('$3.00')).toBeLessThan(result.priceValueLabel.indexOf('$1.00'));
  });

  it('describes the direction in words', () => {
    const result = computePricing(MARKUP_PRODUCT);
    expect(result.reason).toContain('premium over face value');
    expect(result.reason).toContain('Price $3.00 · Value $1.00');
    expect(result.reason).toContain(`meets rule "${result.ruleName}"`);
  });

  it('computes margin and gross profit in integer minor units', () => {
    const result = computePricing(MARKUP_PRODUCT);
    expect(result.marginBps).toBe(7_000);
    expect(result.grossProfitMinor).toBe(210);
    expect(Number.isInteger(result.marginBps)).toBe(true);
    expect(Number.isInteger(result.grossProfitMinor)).toBe(true);
  });

  it('is publishable under the default rule even though the discount is negative', () => {
    // The inversion this guards: comparing the signed value would read
    // -20000 >= 500 as a failure and hide every product in the catalog.
    const result = computePricing(MARKUP_PRODUCT);
    expect(result.meetsMinDiscount).toBe(true);
    expect(result.meetsMinMargin).toBe(true);
    expect(result.publishable).toBe(true);
    expect(() => assertPublishable(result)).not.toThrow();
  });

  it('calls a below-face-value price a discount, not a premium', () => {
    const result = computePricing({ ...MARKUP_PRODUCT, faceValueMinor: 500, sellingPriceMinor: 300 });
    expect(result.discountBps).toBe(4_000);
    expect(result.premium).toBe(false);
    expect(result.reason).toContain('below face value');
  });

  it('calls an at-face-value price neither', () => {
    const result = computePricing({ ...MARKUP_PRODUCT, faceValueMinor: 300, sellingPriceMinor: 300 });
    expect(result.discountBps).toBe(0);
    expect(result.premium).toBe(false);
    expect(result.reason).toContain('priced at face value');
  });
});

describe('computePricing — minimum discount rule', () => {
  it('fails when the price/value gap is smaller than the configured minimum', () => {
    // 2% gap vs a 5% minimum: -200 bps fails -500 bps on magnitude.
    const result = computePricing(
      { ...MARKUP_PRODUCT, faceValueMinor: 1_000, sellingPriceMinor: 1_020 },
      rule({ minDiscountBps: 500 }),
    );
    expect(result.discountBps).toBe(-200);
    expect(result.meetsMinDiscount).toBe(false);
    expect(result.publishable).toBe(false);
    expect(result.reason).toContain('fails rule');
    expect(result.reason).toContain('minimum price/value gap');
  });

  it('passes exactly at the minimum (inclusive comparison)', () => {
    const result = computePricing(
      { ...MARKUP_PRODUCT, faceValueMinor: 1_000, sellingPriceMinor: 1_050 },
      rule({ minDiscountBps: 500 }),
    );
    expect(result.discountBps).toBe(-500);
    expect(result.meetsMinDiscount).toBe(true);
  });

  it('a failing product reports publishable:false with a reason, and never throws', () => {
    const result = computePricing(MARKUP_PRODUCT, rule({ minDiscountBps: 50_000 }));
    expect(result.publishable).toBe(false);
    expect(result.reason).toBeTypeOf('string');
    expect(result.reason.length).toBeGreaterThan(0);
    // The engine REPORTS; it never hides anything by itself.
    expect(result.autoHideOnFail).toBe(true);
    expect(() => computePricing(MARKUP_PRODUCT, rule({ minDiscountBps: 50_000 }))).not.toThrow();
  });
});

describe('computePricing — minimum margin rule', () => {
  it('fails when gross margin is below the configured minimum', () => {
    const result = computePricing(MARKUP_PRODUCT, rule({ minMarginBps: 8_000 }));
    expect(result.marginBps).toBe(7_000);
    expect(result.meetsMinMargin).toBe(false);
    expect(result.publishable).toBe(false);
    expect(result.reason).toContain('gross margin');
  });

  it('refuses to publish a product that loses money, whatever the rule says', () => {
    // Even a rule with a hugely negative minimum cannot authorise selling below
    // cost: the absolute gross-profit floor is not operator-configurable.
    const result = computePricing(
      { ...MARKUP_PRODUCT, supplierCostMinor: 400 },
      rule({ minMarginBps: -100_000 }),
    );
    expect(result.grossProfitMinor).toBe(-100);
    expect(result.marginBps).toBeLessThan(0);
    expect(result.meetsMinMargin).toBe(false);
    expect(result.publishable).toBe(false);
  });

  it('free stock has a 100% margin and passes a 0% floor', () => {
    const result = computePricing({ ...MARKUP_PRODUCT, supplierCostMinor: 0 }, rule({ minMarginBps: 0 }));
    expect(result.marginBps).toBe(10_000);
    expect(result.meetsMinMargin).toBe(true);
    expect(result.publishable).toBe(true);
    expect(DEFAULT_MIN_MARGIN_BPS).toBe(0);
  });
});

describe('computePricing — publish guard', () => {
  it('assertPublishable throws a validation error for a failing product', () => {
    const failing = computePricing(MARKUP_PRODUCT, rule({ minMarginBps: 9_000, name: 'STRICT' }));
    expect(failing.publishable).toBe(false);
    expect(() => assertPublishable(failing, 'product_1')).toThrow(/cannot be published/i);
  });
});

describe('validatePricingInput', () => {
  it('rejects non-integer money', () => {
    expect(() => validatePricingInput({ ...MARKUP_PRODUCT, sellingPriceMinor: 300.5 })).toThrow();
    expect(() => validatePricingInput({ ...MARKUP_PRODUCT, sellingPriceMinor: Number.NaN })).toThrow();
    expect(() => validatePricingInput({ ...MARKUP_PRODUCT, currency: 'US' })).toThrow();
  });

  it('rejects non-positive prices and negative costs', () => {
    expect(() => validatePricingInput({ ...MARKUP_PRODUCT, faceValueMinor: 0 })).toThrow();
    expect(() => validatePricingInput({ ...MARKUP_PRODUCT, sellingPriceMinor: -1 })).toThrow();
    expect(() => validatePricingInput({ ...MARKUP_PRODUCT, supplierCostMinor: -1 })).toThrow();
  });

  it('accepts zero supplier cost (stock product)', () => {
    expect(() => validatePricingInput({ ...MARKUP_PRODUCT, supplierCostMinor: 0 })).not.toThrow();
  });
});

describe('selectPricingRule — category precedence', () => {
  const global = defaultPricingRule({ id: 'a', name: 'GLOBAL', minDiscountBps: 500, category: null });
  const categoryRule = defaultPricingRule({
    id: 'b',
    name: 'GIFT CARDS',
    minDiscountBps: 2_000,
    category: 'gift-cards',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const rules = [global, categoryRule];

  it('a category rule beats the global rule', () => {
    expect(selectPricingRule('gift-cards', rules)?.id).toBe('b');
    expect(selectPricingRule('gift-cards', rules)?.name).toBe('GIFT CARDS');
  });

  it('the global rule applies when no category rule exists', () => {
    expect(selectPricingRule('electronics', rules)?.id).toBe('a');
    expect(selectPricingRule(null, rules)?.id).toBe('a');
  });

  it('matches the category case-insensitively and ignores padding', () => {
    expect(selectPricingRule('  GIFT-CARDS ', rules)?.id).toBe('b');
  });

  it('ignores inactive rules', () => {
    const inactive = { ...categoryRule, id: 'c', active: false };
    expect(selectPricingRule('gift-cards', [...rules, inactive])?.id).toBe('b');
    expect(selectPricingRule('gift-cards', [inactive, global])?.id).toBe('a');
  });

  it('breaks ties on the same category by newest createdAt, then by id', () => {
    const older = { ...categoryRule, id: 'z-old', createdAt: new Date('2026-01-01T00:00:00Z') };
    const newer = { ...categoryRule, id: 'a-new', createdAt: new Date('2026-02-01T00:00:00Z') };
    expect(selectPricingRule('gift-cards', [older, newer])?.id).toBe('a-new');

    const sameInstantA = { ...categoryRule, id: 'a-same', createdAt: new Date('2026-03-01T00:00:00Z') };
    const sameInstantB = { ...categoryRule, id: 'b-same', createdAt: new Date('2026-03-01T00:00:00Z') };
    expect(selectPricingRule('gift-cards', [sameInstantB, sameInstantA])?.id).toBe('a-same');
  });

  it('returns null when nothing applies, and effectivePricingRule falls back', () => {
    expect(selectPricingRule('gift-cards', [])).toBeNull();
    expect(effectivePricingRule('gift-cards', []).name).toBe('DEFAULT');
    expect(effectivePricingRule('gift-cards', rules).id).toBe('b');
  });

  it('the selected rule is what computePricing actually applies', () => {
    const strict = computePricing(MARKUP_PRODUCT, effectivePricingRule('gift-cards', [
      global,
      { ...categoryRule, minDiscountBps: 30_000 },
    ]));
    expect(strict.ruleName).toBe('GIFT CARDS');
    expect(strict.publishable).toBe(false);
  });
});

describe('computePricingForProduct', () => {
  it('is the same engine, fed from a Product-shaped row', () => {
    const viaProduct = computePricingForProduct({ ...MARKUP_PRODUCT, category: 'gift-cards' });
    const direct = computePricing(MARKUP_PRODUCT);
    expect(viaProduct).toEqual(direct);
    expect(viaProduct.discountBps).toBe(-20_000);
  });
});

describe('suggestSellingPrice (seed data only, never payment logic)', () => {
  it('suggests 3x face value for the standard tier', () => {
    const suggestion = suggestSellingPrice({ faceValueMinor: 100, currency: 'usd' });
    expect(suggestion.tier.id).toBe('standard');
    expect(suggestion.sellingPriceMinor).toBe(300);
    expect(suggestion.label).toBe('Price $3.00 · Value $1.00');
    // Still negative by design — a suggestion, never a discount.
    expect(suggestion.discountBps).toBe(-20_000);
  });

  it('resolves tiers and rejects unknown ones', () => {
    expect(getSellingPriceTier('premium').markupBps).toBe(30_000);
    expect(() => getSellingPriceTier('nope')).toThrow();
    expect(getSellingPriceTier().id).toBe('standard');
  });

  it('rejects a non-integer face value', () => {
    expect(() => suggestSellingPrice({ faceValueMinor: 1.5, currency: 'usd' })).toThrow();
  });
});