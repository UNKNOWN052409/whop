import { InventoryStatus } from '@prisma/client';
import { prisma } from '@/db/prisma';
import { logger } from '@/lib/logger';

/**
 * Returns expired reservations to the pool.
 *
 * A reservation that is never delivered — worker crashed mid-flight, email
 * provider outage, process OOM-killed — would otherwise strand a valuable code
 * in RESERVED forever, shrinking sellable inventory on every incident.
 *
 * IDEMPOTENT AND CONCURRENCY-SAFE: the UPDATE is conditional on the lease
 * actually being expired, so two reapers running simultaneously (multiple
 * serverless instances) cannot both release the same row, and a second run
 * finds nothing left to do.
 */
export async function releaseExpiredReservations(): Promise<{
  released: number;
  restoredCount: number;
}> {
  const now = new Date();

  // Single atomic UPDATE ... RETURNING so the reaper can see exactly which
  // orders it touched and repair their denormalised counts.
  const released = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; orderId: string | null }>>`
      UPDATE "InventoryCode"
         SET status = 'AVAILABLE',
             "reservedAt" = NULL,
             "reservationExpiresAt" = NULL,
             "orderId" = NULL,
             "updatedAt" = now()
       WHERE status = 'RESERVED'
         AND "reservationExpiresAt" IS NOT NULL
         AND "reservationExpiresAt" < ${now}
     RETURNING id, "orderId"
    `;
    return rows;
  });

  if (released.length === 0) {
    return { released: 0, restoredCount: 0 };
  }

  // Restore Product.inventoryCount per product for the released rows.
  const byProduct = await prisma.inventoryCode.groupBy({
    by: ['productId'],
    where: { id: { in: released.map((row) => row.id) }, status: InventoryStatus.AVAILABLE },
    _count: { _all: true },
  });

  for (const group of byProduct) {
    await prisma.product.update({
      where: { id: group.productId },
      data: { inventoryCount: { increment: group._count._all } },
    });
  }

  logger.warn('Released expired inventory reservations', {
    released: released.length,
    restoredCount: released.length,
  });

  return { released: released.length, restoredCount: released.length };
}