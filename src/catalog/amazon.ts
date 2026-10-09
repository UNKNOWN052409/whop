/**
 * Amazon as a first-class catalog option (spec §4).
 *
 * WHAT THIS IS: a typed display model so Amazon gift-balance products sit
 * alongside every other brand in the storefront without the UI special-casing
 * them, and a normaliser that turns a catalog row into that model.
 *
 * WHAT THIS IS NOT: an Amazon integration. There is no Amazon API call here,
 * no scraping, no credential handling, and — most importantly — NO HARDCODED
 * CODES OR PRICES. Every amount, region and name comes from the Product and
 * ProductProvider rows that the admin already created. This module has no
 * default price and no default denomination; if the database row is wrong, the
 * storefront shows the wrong thing, which is the correct failure mode.
 *
 * SOURCING GUARD (spec §4 / §13):
 *   Amazon inventory must come from an AUTHORIZED RESELLER OR SUPPLIER FEED —
 *   an approved reseller agreement, a sanctioned wholesale feed, or codes
 *   purchased through a legitimate channel and recorded against a Supplier row
 *   with its authorizationRef. Amazon gift balances are not ours to generate,
 *   scrape, brute-force or manufacture, and a code that was not obtained
 *   lawfully must never enter InventoryCode, because delivering it to a paying
 *   customer is a refund and a compliance problem, not a sale. Nothing in this
 *   module weakens that rule: it only shapes already-authorized catalog rows
 *   for display.
 *
 * PRICING: the premium model still holds for Amazon products. A $25 balance
 * sold at $60 is a premium, and `priceValueLabel` renders it as
 * "Price $60.00 · Value $25.00". Nothing here inverts price and value.
 */

import { DeliveryMethod } from '@prisma/client';
import { discountBps, formatMoney } from '@/lib/money';
import { errors } from '@/lib/errors';
import { type Availability } from './availability';
import { type PublicProduct } from './queries';

/** Canonical brand string. A Product row's `brand` is normalised to this. */
export const AMAZON_BRAND = 'Amazon';

/** Product slug prefix, e.g. "amazon-us-25". Keeps Amazon SKUs recognisable. */
export const AMAZON_SLUG_PREFIX = 'amazon-';

/** Amazon balance denominations are whole currency units in practice. */
export const AMAZON_FACE_VALUE_HINT =
  'Amazon gift balances are sold in whole units of the storefront currency (e.g. 25.00 USD).';

export interface AmazonProductInput {
  productName: string;
  faceValueMinor: number;
  /** What the customer pays. Higher than face value in this catalog. */
  sellingPriceMinor: number;
  currency: string;
  region: string;
  imageUrl?: string | null;
  description?: string | null;
  inventoryCount?: number;
  deliveryMethod?: DeliveryMethod;
  availability?: Availability;
}

/** The catalog-facing Amazon product model. Amounts stay integers. */
export interface AmazonProductDisplay {
  source: 'AMAZON';
  brand: typeof AMAZON_BRAND;
  title: string;
  slug: string;
  region: string;
  deliveryMethod: DeliveryMethod;
  /** Integer minor units — never a float, never a formatted string only. */
  faceValueMinor: number;
  sellingPriceMinor: number;
  currency: string;
  faceValueFormatted: string;
  sellingPriceFormatted: string;
  /** "Price $60.00 · Value $25.00" */
  priceValueLabel: string;
  /** Negative in this catalog: the customer pays a premium over face value. */
  discountBps: number;
  premium: boolean;
  imageUrl: string | null;
  description: string | null;
  inventoryCount: number;
  availability: Availability;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw errors.validation(`${field} must be a positive integer number of minor units`);
  }
}

/** Lowercase, dash-separated, no leading/trailing dashes. Pure. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** e.g. slugify("Amazon US $25 Gift Balance") -> "amazon-us-25-gift-balance". */
export function amazonSlug(productName: string, region: string): string {
  const base = slugify(`${AMAZON_BRAND} ${region} ${productName}`);
  const slug = base.startsWith(AMAZON_SLUG_PREFIX) ? base : `${AMAZON_SLUG_PREFIX}${base}`;
  return slug.length > 80 ? slug.slice(0, 80).replace(/-+$/, '') : slug;
}

/** Case-insensitive brand check for an existing catalog row. */
export function isAmazonProduct(brand: string | null | undefined): boolean {
  return (brand ?? '').trim().toLowerCase() === AMAZON_BRAND.toLowerCase();
}

/**
 * Builds the Amazon display model from data the caller already read out of the
 * catalog. Pure: no database, no network, no defaults for money.
 */
export function buildAmazonProductDisplay(input: AmazonProductInput): AmazonProductDisplay {
  assertPositiveInteger(input.faceValueMinor, 'faceValueMinor');
  assertPositiveInteger(input.sellingPriceMinor, 'sellingPriceMinor');
  if (typeof input.currency !== 'string' || !/^[A-Za-z]{3}$/.test(input.currency.trim())) {
    throw errors.validation('currency must be a 3-letter ISO 4217 code');
  }
  if (typeof input.productName !== 'string' || input.productName.trim() === '') {
    throw errors.validation('productName is required');
  }

  const currency = input.currency.trim().toUpperCase();
  const region = input.region.trim().toUpperCase();
  const discount = discountBps(input.faceValueMinor, input.sellingPriceMinor);

  return {
    source: 'AMAZON',
    brand: AMAZON_BRAND,
    title: input.productName.trim(),
    slug: amazonSlug(input.productName, region),
    region,
    deliveryMethod: input.deliveryMethod ?? DeliveryMethod.EMAIL,
    faceValueMinor: input.faceValueMinor,
    sellingPriceMinor: input.sellingPriceMinor,
    currency,
    faceValueFormatted: formatMoney(input.faceValueMinor, currency),
    sellingPriceFormatted: formatMoney(input.sellingPriceMinor, currency),
    priceValueLabel: `Price ${formatMoney(input.sellingPriceMinor, currency)} · Value ${formatMoney(input.faceValueMinor, currency)}`,
    discountBps: discount,
    premium: discount < 0,
    imageUrl: input.imageUrl ?? null,
    description: input.description ?? null,
    inventoryCount: input.inventoryCount ?? 0,
    availability:
      input.availability ?? ((input.inventoryCount ?? 0) > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK'),
  };
}

/**
 * Convenience for storefront code: takes the safe public projection (which
 * already hides supplier cost and inventory codes) and returns the Amazon view
 * of it. Nothing new is exposed.
 */
export function amazonDisplayFromPublicProduct(product: PublicProduct): AmazonProductDisplay {
  return buildAmazonProductDisplay({
    productName: product.productName,
    faceValueMinor: product.faceValueMinor,
    sellingPriceMinor: product.sellingPriceMinor,
    currency: product.currency,
    region: product.region,
    imageUrl: product.imageUrl,
    description: product.description,
    inventoryCount: product.inventoryCount,
    deliveryMethod: product.deliveryMethod,
    availability: product.availability,
  });
}

/**
 * Filters a public product list down to Amazon rows and maps them to the
 * display model. Non-Amazon rows are dropped; nothing else changes.
 */
export function selectAmazonProducts(products: readonly PublicProduct[]): AmazonProductDisplay[] {
  return products.filter((product) => isAmazonProduct(product.brand)).map(amazonDisplayFromPublicProduct);
}

/**
 * The Product-row fields an Amazon product needs. Deliberately does NOT include
 * a code, a supplier id or a cost: those come from ProductProvider/InventoryCode
 * rows created through the authorized-supplier import path.
 */
export interface AmazonProductDraft {
  slug: string;
  productName: string;
  brand: typeof AMAZON_BRAND;
  category: string;
  region: string;
  currency: string;
  faceValueMinor: number;
  sellingPriceMinor: number;
  description: string | null;
  imageUrl: string | null;
  deliveryMethod: DeliveryMethod;
}

/** Builds the draft for the admin create form. Money must already be integers. */
export function toAmazonProductDraft(input: AmazonProductInput): AmazonProductDraft {
  const display = buildAmazonProductDisplay(input);
  return {
    slug: display.slug,
    productName: display.title,
    brand: AMAZON_BRAND,
    // An explicit category keeps Amazon products filterable alongside the rest
    // of the catalog; operators can rename it later without code changes.
    category: 'amazon-gift-balance',
    region: display.region,
    currency: display.currency,
    faceValueMinor: display.faceValueMinor,
    sellingPriceMinor: display.sellingPriceMinor,
    description: display.description,
    imageUrl: display.imageUrl,
    deliveryMethod: display.deliveryMethod,
  };
}