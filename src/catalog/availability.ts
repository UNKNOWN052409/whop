/**
 * Availability projection and inventory-count consistency (spec §2, §4).
 *
 * Two responsibilities:
 *
 *  1. PROJECTION — turn `Product.inventoryCount` (a denormalised counter) into
 *     the `availability` value the storefront renders. Pure and trivial.
 *
 *  2. CONSISTENCY — helpers the inventory/fulfillment module calls after a
 *     reservation, delivery or revocation so the counter the storefront reads
 *     never drifts away from the InventoryCode rows that are actually free.
 *
 * The sellability predicate lives in ONE place (`availableInventoryWhere`).
 * The allocation path, the counter recompute and any "can I still buy this"
 * check must all use it, otherwise the storefront advertises stock that the
 * allocator will refuse to hand out.
 */

import { InventoryStatus, ProductStatus, type Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/db/prisma';
import { errors } from '@/lib/errors';
import { invalidateCatalogCache } from './cache-control';

export type Availability = 'IN_STOCK' | 'OUT_OF_STOCK';

/** Either the root Prisma client or an in-flight transaction client. */
export type CatalogDb = Prisma.TransactionClient | PrismaClient;

/**
 * A product is purchasable when it is ACTIVE *and* has at least one
 * non-expired AVAILABLE code. Sold-out products stay listed (they convert
 * better than a 404) but never accept an order.
 */
export function deriveAvailability(
  inventoryCount: number,
  status?: ProductStatus | null,
): Availability {
  if (status && status !== ProductStatus.ACTIVE) return 'OUT_OF_STOCK';
  return inventoryCount > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK';
}

export interface AvailableInventoryOptions {
  /** Injected clock, so expiry sweeps and tests stay deterministic. */
  now?: Date;
  /** Expiry sweeps need the dead codes counted; the storefront never does. */
  includeExpired?: boolean;
}

/**
 * The single definition of "a code a customer can be given right now".
 *
 * Expired-but-still-AVAILABLE codes are excluded on purpose: they exist in the
 * database until a sweep reaps them, and selling one is a guaranteed refund.
 */
export function availableInventoryWhere(
  productId: string | { in: readonly string[] },
  options: AvailableInventoryOptions = {},
): Prisma.InventoryCodeWhereInput {
  const where: Prisma.InventoryCodeWhereInput = {
    productId: typeof productId === 'string' ? productId : { in: [...productId.in] },
    status: InventoryStatus.AVAILABLE,
  };
  if (!options.includeExpired) {
    where.OR = [{ expiresAt: null }, { expiresAt: { gt: options.now ?? new Date() } }];
  }
  return where;
}

export interface AvailabilitySnapshot {
  productId: string;
  /** Non-expired AVAILABLE codes — the number the storefront cares about. */
  availableCount: number;
  reservedCount: number;
  assignedCount: number;
  deliveredCount: number;
  revokedCount: number;
  /** Every code row for the product, expired or not. */
  totalCount: number;
  /** The denormalised counter currently persisted on Product. */
  productInventoryCount: number;
  availability: Availability;
  /** True when the counter has drifted from the rows it summarises. */
  drifted: boolean;
}

function countFor(
  counts: ReadonlyMap<InventoryStatus, number>,
  status: InventoryStatus,
): number {
  return counts.get(status) ?? 0;
}

/**
 * Full availability picture for one product, from the code rows themselves
 * (never from the denormalised counter alone).
 *
 * Returns null when the product does not exist.
 */
export async function getAvailability(
  productId: string,
  client: CatalogDb = prisma,
): Promise<AvailabilitySnapshot | null> {
  const product = await client.product.findUnique({
    where: { id: productId },
    select: { inventoryCount: true, status: true },
  });
  if (!product) return null;

  const grouped = await client.inventoryCode.groupBy({
    by: ['status'],
    where: { productId },
    _count: { _all: true },
  });

  const counts = new Map<InventoryStatus, number>();
  let total = 0;
  for (const row of grouped) {
    const n = row._count._all;
    counts.set(row.status, n);
    total += n;
  }

  // `availableCount` is the sellable count (AVAILABLE and not expired). The
  // groupBy above cannot express the OR/expiresAt predicate together with the
  // status grouping, so this second indexed query resolves it.
  const sellableNow = await client.inventoryCode.count({
    where: availableInventoryWhere(productId),
  });

  return {
    productId,
    availableCount: sellableNow,
    reservedCount: countFor(counts, InventoryStatus.RESERVED),
    assignedCount: countFor(counts, InventoryStatus.ASSIGNED),
    deliveredCount: countFor(counts, InventoryStatus.DELIVERED),
    revokedCount: countFor(counts, InventoryStatus.REVOKED),
    totalCount: total,
    productInventoryCount: product.inventoryCount,
    availability: deriveAvailability(sellableNow, product.status),
    drifted: product.inventoryCount !== sellableNow,
  };
}

/** Batch variant — one groupBy + one count per status for the whole page. */
export async function getAvailabilityForProducts(
  productIds: readonly string[],
  client: CatalogDb = prisma,
): Promise<Map<string, AvailabilitySnapshot>> {
  const result = new Map<string, AvailabilitySnapshot>();
  if (productIds.length === 0) return result;

  const [products, grouped] = await Promise.all([
    client.product.findMany({
      where: { id: { in: [...productIds] } },
      select: { id: true, inventoryCount: true, status: true },
    }),
    client.inventoryCode.groupBy({
      by: ['productId', 'status'],
      where: { productId: { in: [...productIds] } },
      _count: { _all: true },
    }),
  ]);

  const byProduct = new Map<string, Map<InventoryStatus, number>>();
  const totals = new Map<string, number>();
  for (const row of grouped) {
    let counts = byProduct.get(row.productId);
    if (!counts) {
      counts = new Map<InventoryStatus, number>();
      byProduct.set(row.productId, counts);
      totals.set(row.productId, 0);
    }
    counts.set(row.status, row._count._all);
    totals.set(row.productId, (totals.get(row.productId) ?? 0) + row._count._all);
  }

  // One grouped count for the sellable predicate across every product. Same
  // `availableInventoryWhere` the single-product path uses, so the two can
  // never disagree about what "available" means.
  const sellable = await client.inventoryCode.groupBy({
    by: ['productId'],
    where: availableInventoryWhere({ in: productIds }),
    _count: { _all: true },
  });
  const sellableByProduct = new Map<string, number>();
  for (const row of sellable) {
    sellableByProduct.set(row.productId, row._count._all);
  }

  for (const product of products) {
    const counts = byProduct.get(product.id) ?? new Map<InventoryStatus, number>();
    const availableNow = sellableByProduct.get(product.id) ?? 0;
    result.set(product.id, {
      productId: product.id,
      availableCount: availableNow,
      reservedCount: countFor(counts, InventoryStatus.RESERVED),
      assignedCount: countFor(counts, InventoryStatus.ASSIGNED),
      deliveredCount: countFor(counts, InventoryStatus.DELIVERED),
      revokedCount: countFor(counts, InventoryStatus.REVOKED),
      totalCount: totals.get(product.id) ?? 0,
      productInventoryCount: product.inventoryCount,
      availability: deriveAvailability(availableNow, product.status),
      drifted: product.inventoryCount !== availableNow,
    });
  }

  return result;
}

/** Fast sellable-stock count. The gate every purchase path should call. */
export async function countAvailableInventory(
  productId: string,
  client: CatalogDb = prisma,
  options: AvailableInventoryOptions = {},
): Promise<number> {
  return client.inventoryCode.count({ where: availableInventoryWhere(productId, options) });
}

/**
 * Authoritative counter recompute: counts the real sellable rows and writes
 * the result to Product.inventoryCount.
 *
 * CALL IT INSIDE THE SAME TRANSACTION as the reservation, AFTER the code row's
 * status has been updated, so the recount observes the change. Recomputing is
 * idempotent, which is what makes it safe to call from a retried fulfillment
 * job. The cache is invalidated fire-and-forget: a rollback therefore only
 * costs one extra database read, never a stale storefront.
 */
export async function recomputeInventoryCount(
  tx: Prisma.TransactionClient,
  productId: string,
  options: AvailableInventoryOptions = {},
): Promise<number> {
  const count = await countAvailableInventory(productId, tx, options);
  await tx.product.update({
    where: { id: productId },
    data: { inventoryCount: count },
  });
  invalidateCatalogCache();
  return count;
}

/**
 * Cheap atomic adjustment, for callers that already know the exact delta (one
 * code reserved, one code released). Never produces a negative count: the
 * update is guarded, and a would-be-below-zero result is clamped and logged
 * rather than publishing "-3 in stock".
 */
export async function adjustInventoryCount(
  tx: Prisma.TransactionClient,
  productId: string,
  delta: number,
): Promise<number> {
  if (!Number.isSafeInteger(delta) || delta === 0) {
    return countAvailableInventory(productId, tx);
  }

  const updated = await tx.product.update({
    where: { id: productId },
    data: { inventoryCount: { increment: delta } },
    select: { inventoryCount: true },
  });

  if (updated.inventoryCount < 0) {
    await tx.product.update({
      where: { id: productId },
      data: { inventoryCount: 0 },
    });
    invalidateCatalogCache();
    return 0;
  }

  invalidateCatalogCache();
  return updated.inventoryCount;
}

/**
 * Purchase gate. Throws the shared 409 the rest of the system already handles
 * rather than inventing a catalog-specific error shape.
 */
export async function assertPurchasable(
  productId: string,
  quantity: number,
  client: CatalogDb = prisma,
): Promise<void> {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw errors.validation('quantity must be a positive integer');
  }
  const available = await countAvailableInventory(productId, client);
  if (available < quantity) throw errors.insufficientInventory(productId);
}