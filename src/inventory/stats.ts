import { InventoryStatus } from '@prisma/client';
import { prisma } from '@/db/prisma';

/**
 * Admin inventory aggregates.
 *
 * No return value in this module contains redeem-code material — only counts,
 * statuses, and supplier references an operator legitimately needs.
 */

export interface ProductInventorySummary {
  productId: string;
  productName: string;
  currency: string;
  available: number;
  reserved: number;
  assigned: number;
  delivered: number;
  revoked: number;
  expiredButAvailable: number;
  /** Below this the storefront should flag the product as low-stock. */
  lowStock: boolean;
}

const LOW_STOCK_THRESHOLD = 10;

export async function inventorySummary(): Promise<ProductInventorySummary[]> {
  const products = await prisma.product.findMany({
    select: { id: true, productName: true, currency: true, inventoryCount: true },
    orderBy: { productName: 'asc' },
  });

  const grouped = await prisma.inventoryCode.groupBy({
    by: ['productId', 'status'],
    _count: { _all: true },
  });

  const counts = new Map<string, Partial<Record<InventoryStatus, number>>>();
  for (const group of grouped) {
    const bucket = counts.get(group.productId) ?? {};
    bucket[group.status] = group._count._all;
    counts.set(group.productId, bucket);
  }

  const now = new Date();
  const expiredByProduct = await prisma.inventoryCode.groupBy({
    by: ['productId'],
    where: { status: InventoryStatus.AVAILABLE, expiresAt: { lte: now } },
    _count: { _all: true },
  });
  const expired = new Map(expiredByProduct.map((row) => [row.productId, row._count._all]));

  return products.map((product) => {
    const bucket = counts.get(product.id) ?? {};
    const available = bucket[InventoryStatus.AVAILABLE] ?? 0;
    return {
      productId: product.id,
      productName: product.productName,
      currency: product.currency,
      available,
      reserved: bucket[InventoryStatus.RESERVED] ?? 0,
      assigned: bucket[InventoryStatus.ASSIGNED] ?? 0,
      delivered: bucket[InventoryStatus.DELIVERED] ?? 0,
      revoked: bucket[InventoryStatus.REVOKED] ?? 0,
      expiredButAvailable: expired.get(product.id) ?? 0,
      lowStock: available <= LOW_STOCK_THRESHOLD,
    };
  });
}

export async function totalAvailable(): Promise<number> {
  return prisma.inventoryCode.count({
    where: {
      status: InventoryStatus.AVAILABLE,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
}