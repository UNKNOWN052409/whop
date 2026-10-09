/**
 * Storefront read APIs (spec §2, §4).
 *
 * SECURITY BOUNDARY — this module is the only place that builds a public
 * product shape, and it builds it from an explicit column `select`. There is
 * no `include`, no `toJSON` on the Prisma model, and no spread of a raw row
 * anywhere below. That is deliberate: a future `return prisma.product.findMany()`
 * refactor would leak `supplierCostMinor`, the ProductProvider join (supplier
 * ids, SKUs, per-supplier costs) and InventoryCode rows (encrypted code
 * material, fingerprints, supplier references) straight to the browser.
 *
 * What a public product IS, per spec §2:
 *   id, slug, productName, brand, category, region, faceValueMinor,
 *   sellingPriceMinor, currency, deliveryMethod, imageUrl, description,
 *   inventoryCount, availability.
 *
 * `faceValueMinor` is public on purpose: the storefront must be able to show
 * "Price $3.00 · Value $1.00". It is the customer's product value, not a
 * supplier cost, and hiding it would force the UI to lie about what the
 * customer is getting.
 *
 * Cached for a few seconds (see cache-control.ts) and invalidated explicitly on
 * every write that changes what the storefront shows.
 */

import { DeliveryMethod, ProductStatus, type Prisma } from '@prisma/client';
import { prisma } from '@/db/prisma';
import { formatMoney } from '@/lib/money';
import { logger } from '@/lib/logger';
import {
  catalogCache,
  invalidateCatalogCache,
  productByIdCacheKey,
  productBySlugCacheKey,
  productListCacheKey,
} from './cache-control';
import { deriveAvailability, type Availability } from './availability';

/**
 * The complete, exhaustive set of columns a public read may return.
 * Adding a column here is a deliberate act: it becomes customer-visible.
 */
export const PUBLIC_PRODUCT_SELECT = {
  id: true,
  slug: true,
  productName: true,
  brand: true,
  category: true,
  region: true,
  description: true,
  imageUrl: true,
  currency: true,
  faceValueMinor: true,
  sellingPriceMinor: true,
  deliveryMethod: true,
  inventoryCount: true,
} as const satisfies Prisma.ProductSelect;

export type ProductRow = Prisma.ProductGetPayload<{ select: typeof PUBLIC_PRODUCT_SELECT }>;

/** The one and only customer-facing product shape. */
export interface PublicProduct {
  id: string;
  slug: string;
  productName: string;
  brand: string;
  category: string;
  region: string;
  /** What the code is worth to the customer. */
  faceValueMinor: number;
  /** What the customer pays. In our catalog this is HIGHER, not lower. */
  sellingPriceMinor: number;
  currency: string;
  deliveryMethod: DeliveryMethod;
  imageUrl: string | null;
  description: string | null;
  inventoryCount: number;
  availability: Availability;
  // --- Display helpers, derived, never stored -----------------------
  /** "Price $3.00 · Value $1.00". Never inverted. */
  priceValueLabel: string;
  priceFormatted: string;
  valueFormatted: string;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 80;
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 60;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

/**
 * Projects a database row into the public shape. The ONLY place this happens.
 * Frozen so a cached instance handed to two callers cannot be mutated by
 * either of them.
 */
export function toPublicProduct(row: ProductRow): PublicProduct {
  const publicProduct: PublicProduct = {
    id: row.id,
    slug: row.slug,
    productName: row.productName,
    brand: row.brand,
    category: row.category,
    region: row.region,
    faceValueMinor: row.faceValueMinor,
    sellingPriceMinor: row.sellingPriceMinor,
    currency: row.currency,
    deliveryMethod: row.deliveryMethod,
    imageUrl: row.imageUrl,
    description: row.description,
    inventoryCount: row.inventoryCount,
    availability: deriveAvailability(row.inventoryCount, ProductStatus.ACTIVE),
    priceValueLabel: `Price ${formatMoney(row.sellingPriceMinor, row.currency)} · Value ${formatMoney(row.faceValueMinor, row.currency)}`,
    priceFormatted: formatMoney(row.sellingPriceMinor, row.currency),
    valueFormatted: formatMoney(row.faceValueMinor, row.currency),
  };
  return deepFreeze(publicProduct);
}

// --- Cache plumbing ---------------------------------------------------------

/**
 * Read-through cache. A cache fault is never a request fault: every failure
 * path falls through to the database and logs at debug level.
 */
async function readThrough<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cache = catalogCache();
  try {
    const hit = await cache.get<T>(key);
    if (hit !== null && hit !== undefined) return hit;
  } catch (error) {
    logger.debug('Catalog cache read failed', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const value = await load();

  try {
    await cache.set(key, deepFreeze(value));
  } catch (error) {
    logger.debug('Catalog cache write failed', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return value;
}

// --- Reads ------------------------------------------------------------------

export interface ListProductsOptions {
  category?: string;
  brand?: string;
  region?: string;
  /** Served from `inventoryCount`; hides sold-out SKUs from the grid. */
  inStockOnly?: boolean;
  limit?: number;
}

function buildListWhere(options: ListProductsOptions): Prisma.ProductWhereInput {
  const where: Prisma.ProductWhereInput = { status: ProductStatus.ACTIVE };
  if (options.category) where.category = options.category;
  if (options.brand) where.brand = options.brand;
  if (options.region) where.region = options.region.toUpperCase();
  if (options.inStockOnly) where.inventoryCount = { gt: 0 };
  return where;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(limit, MAX_LIST_LIMIT);
}

/**
 * Every ACTIVE product, in a deterministic order (brand, then name, then id)
 * so pagination and cache keys are stable across requests.
 *
 * Sold-out products are INCLUDED by default — they still convert, and the UI
 * decides how to present them. Pass `inStockOnly` for a grid that hides them.
 */
export async function listActiveProducts(
  options: ListProductsOptions = {},
): Promise<PublicProduct[]> {
  const limit = clampLimit(options.limit);
  const cacheKey = productListCacheKey({ ...options, limit });

  const products = await readThrough<ProductRow[]>(cacheKey, async () => {
    const rows = await prisma.product.findMany({
      where: buildListWhere(options),
      select: PUBLIC_PRODUCT_SELECT,
      orderBy: [{ brand: 'asc' }, { productName: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows;
  });

  return products.map(toPublicProduct);
}

/**
 * One product by its public slug. Returns null for an unknown slug, for a
 * slug that is not in the allowed shape, and for a non-ACTIVE product — a
 * draft must be indistinguishable from a missing one to a customer.
 */
export async function getProductBySlug(slug: string): Promise<PublicProduct | null> {
  const normalised = slug?.trim().toLowerCase() ?? '';
  if (normalised.length === 0 || normalised.length > MAX_SLUG_LENGTH) return null;
  if (!SLUG_PATTERN.test(normalised)) return null;

  const row = await readThrough<ProductRow | null>(productBySlugCacheKey(normalised), async () => {
    const found = await prisma.product.findFirst({
      where: { slug: normalised, status: ProductStatus.ACTIVE },
      select: PUBLIC_PRODUCT_SELECT,
    });
    return found;
  });

  return row ? toPublicProduct(row) : null;
}

/** One product by id. Same visibility rules as getProductBySlug. */
export async function getProductById(id: string): Promise<PublicProduct | null> {
  const normalised = id?.trim() ?? '';
  if (normalised.length === 0 || normalised.length > 64) return null;

  const row = await readThrough<ProductRow | null>(productByIdCacheKey(normalised), async () => {
    const found = await prisma.product.findFirst({
      where: { id: normalised, status: ProductStatus.ACTIVE },
      select: PUBLIC_PRODUCT_SELECT,
    });
    return found;
  });

  return row ? toPublicProduct(row) : null;
}

/** Distinct categories/brands with at least one live product. Powers filters. */
export async function listCatalogFacets(): Promise<{
  categories: string[];
  brands: string[];
  regions: string[];
}> {
  const key = productListCacheKey({ facets: true });
  return readThrough(key, async () => {
    const rows = await prisma.product.findMany({
      where: { status: ProductStatus.ACTIVE },
      select: { category: true, brand: true, region: true },
      distinct: ['category', 'brand', 'region'],
      orderBy: [{ category: 'asc' }, { brand: 'asc' }, { region: 'asc' }],
    });

    const categories = new Set<string>();
    const brands = new Set<string>();
    const regions = new Set<string>();
    for (const row of rows) {
      categories.add(row.category);
      brands.add(row.brand);
      regions.add(row.region);
    }
    return {
      categories: [...categories].sort(),
      brands: [...brands].sort(),
      regions: [...regions].sort(),
    };
  });
}

/**
 * Explicit invalidation hook for admin routes.
 *
 * Call after: creating a product, editing price/description/image, changing
 * status (publish/hide/archive), and after any inventory write that moves
 * `inventoryCount` (availability.ts does this already).
 */
export { invalidateCatalogCache };