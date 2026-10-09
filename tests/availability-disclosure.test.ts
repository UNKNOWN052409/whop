/**
 * Inventory disclosure to an unauthenticated visitor (spec §31, inventory
 * probing).
 *
 * The threat this suite locks down: `Product.inventoryCount` is an exact,
 * per-SKU remaining-units counter. The storefront used to render it verbatim
 * ("· 12 left") on every product card and product page, so ONE unauthenticated
 * `GET /` returned the precise stock level of the entire catalog. That is a free
 * stock oracle — it tells a competitor or a reseller which SKUs are thin
 * enough to buy out, and when to buy them.
 *
 * These are pure-function and source-shape assertions. No database, no clock,
 * no network: the properties under test are "the number cannot reach the
 * public surface" and "the number is still enforced where it matters".
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { deriveAvailability, isLowStock, lowStockThreshold } from '@/catalog/availability';

const SRC = path.join(process.cwd(), 'src');

function source(relativePath: string): string {
  return readFileSync(path.join(SRC, relativePath), 'utf8');
}

describe('isLowStock', () => {
  afterEach(() => {
    delete process.env.LOW_STOCK_THRESHOLD;
  });

  it('is true only for a strictly positive count at or under the threshold', () => {
    expect(isLowStock(1)).toBe(true);
    expect(isLowStock(5)).toBe(true);
    expect(isLowStock(6)).toBe(false);
    expect(isLowStock(10_000)).toBe(false);
  });

  it('is false for a sold-out product, so the badge never contradicts itself', () => {
    // "Sold out · low stock" would be a nonsense pair on a customer-facing page.
    expect(isLowStock(0)).toBe(false);
  });

  it('never inverts: more stock is never scarcer', () => {
    // Swept over PURCHASABLE counts only. Zero is excluded because it is a
    // different state entirely (sold out, and the badge says so), so the
    // 0 -> 1 edge legitimately crosses from "sold out" to "low stock".
    let previous = true;
    for (let count = 1; count <= 100; count += 1) {
      const current = isLowStock(count);
      if (previous === false && current === true) {
        throw new Error(`scarcity increased at count=${count}`);
      }
      previous = current;
    }
  });

  it('rejects nonsense counts rather than calling them scarce', () => {
    expect(isLowStock(-1)).toBe(false);
    expect(isLowStock(1.5)).toBe(false);
    expect(isLowStock(Number.NaN)).toBe(false);
  });

  it('honours an explicit threshold over the environment default', () => {
    expect(isLowStock(20, 25)).toBe(true);
    expect(isLowStock(20, 10)).toBe(false);
  });

  it('never leaks the count in its return value', () => {
    // A boolean is the whole contract. Returning the count here would put the
    // exact figure straight back into the component that renders it.
    expect(typeof isLowStock(3)).toBe('boolean');
  });
});

describe('lowStockThreshold', () => {
  afterEach(() => {
    delete process.env.LOW_STOCK_THRESHOLD;
  });

  it('uses the documented default when unset', () => {
    expect(lowStockThreshold()).toBe(5);
  });

  it('accepts a positive integer override', () => {
    process.env.LOW_STOCK_THRESHOLD = '12';
    expect(lowStockThreshold()).toBe(12);
  });

  it('falls back to the default on a malformed value rather than disabling it', () => {
    for (const raw of ['', '  ', 'abc', '0', '-4', '2.5', '1e3']) {
      process.env.LOW_STOCK_THRESHOLD = raw;
      expect(lowStockThreshold(), `"${raw}" must not be honoured`).toBe(5);
    }
  });
});

describe('sold-out behaviour is unchanged', () => {
  it('still derives OUT_OF_STOCK from a zero counter', () => {
    expect(deriveAvailability(0)).toBe('OUT_OF_STOCK');
    expect(deriveAvailability(0, 'ACTIVE' as never)).toBe('OUT_OF_STOCK');
  });

  it('still derives OUT_OF_STOCK for a non-ACTIVE product with stock on hand', () => {
    // Unpublishing a SKU must hide it from sale even if codes remain.
    expect(deriveAvailability(50, 'DRAFT' as never)).toBe('OUT_OF_STOCK');
    expect(deriveAvailability(50, 'ARCHIVED' as never)).toBe('OUT_OF_STOCK');
  });

  it('still derives IN_STOCK from any positive counter', () => {
    expect(deriveAvailability(1)).toBe('IN_STOCK');
    expect(deriveAvailability(1, 'ACTIVE' as never)).toBe('IN_STOCK');
  });
});

describe('the exact stock count never reaches the public storefront', () => {
  const PUBLIC_SURFACES: ReadonlyArray<[label: string, relativePath: string]> = [
    ['availability badge', 'components/availability-badge.tsx'],
    ['product card', 'components/product-card.tsx'],
    ['landing page', 'app/page.tsx'],
    ['product page', 'app/(storefront)/product/[slug]/page.tsx'],
    ['checkout page', 'app/(checkout)/checkout/page.tsx'],
    ['checkout form', 'app/(checkout)/checkout/CheckoutForm.tsx'],
  ];

  it.each(PUBLIC_SURFACES)('%s does not render a count', (_label, relativePath) => {
    const contents = source(relativePath);
    // The badge is the only component that ever took a count, and it no longer
    // accepts one, so no caller can pass it either.
    expect(contents).not.toMatch(/count=\{product\.inventoryCount\}/);
    expect(contents).not.toMatch(/left<\/span>/);
    expect(contents).not.toMatch(/\{\s*product\.inventoryCount\s*\}/);
  });

  it('the badge no longer accepts a numeric count at all', () => {
    const badge = source('components/availability-badge.tsx');
    // The prop was the leak. Removing it — rather than merely not using it —
    // is what stops the next caller from reintroducing the disclosure.
    expect(badge).not.toMatch(/\bcount\?:/);
    expect(badge).toMatch(/lowStock\?: boolean/);
  });

  it('the two live badge call sites derive the boolean, never the number', () => {
    for (const relativePath of ['components/product-card.tsx', 'app/(storefront)/product/[slug]/page.tsx']) {
      const contents = source(relativePath);
      expect(contents, relativePath).toMatch(/lowStock=\{isLowStock\(product\.inventoryCount\)\}/);
    }
  });
});

describe('the count is still enforced server-side where it decides money', () => {
  it('checkout still refuses a quantity the counter cannot cover', () => {
    // Reducing the DISCLOSURE must not reduce the CHECK. If this guard were
    // removed the storefront would happily sell stock that does not exist.
    expect(source('app/api/checkout/route.ts')).toMatch(
      /product\.inventoryCount\s*<\s*body\.quantity[\s\S]{0,120}insufficientInventory/,
    );
  });
});