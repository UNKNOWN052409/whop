import { InventoryStatus } from '@prisma/client';
import { prisma } from '@/db/prisma';
import { logger } from '@/lib/logger';

/**
 * Revocation.
 *
 * A REVOKED code must NEVER re-enter AVAILABLE. That holds for two distinct
 * reasons, and conflating them is how a store accidentally resells a code it
 * has already promised to someone else:
 *
 *  - Chargeback / fraud: the code was delivered and the buyer reversed payment.
 *    The code is burned. Returning it to the pool means the next customer
 *    receives a code the card issuer already reversed — an unredeemable paid
 *    order and a second chargeback.
 *  - Supplier recall: the upstream batch is bad. Same outcome.
 *
 * The release reaper only ever touches status = RESERVED, so a REVOKED row is
 * structurally unreachable from the return-to-stock path.
 */

export async function revokeCode(codeId: string, reason?: string): Promise<boolean> {
  const code = await prisma.inventoryCode.findUnique({
    where: { id: codeId },
    select: { status: true, orderId: true },
  });
  if (!code) return false;
  if (code.status === InventoryStatus.REVOKED) return false;

  await prisma.inventoryCode.update({
    where: { id: codeId },
    data: {
      status: InventoryStatus.REVOKED,
      revokedAt: new Date(),
      orderId: null,
    },
  });

  logger.warn('Inventory code revoked', {
    codeId,
    reason: reason ?? undefined,
    orderId: code.orderId ?? undefined,
  });
  return true;
}

/**
 * Revoke every code attached to an order — used when a payment is reversed,
 * disputed, or refunded before delivery.
 *
 * Does NOT restore Product.inventoryCount: a revoked code is consumed, not
 * returned. Counting it back would overstate sellable inventory.
 */
export async function revokeCodeForOrder(orderId: string, reason?: string): Promise<number> {
  const result = await prisma.inventoryCode.updateMany({
    where: { orderId, status: { not: InventoryStatus.REVOKED } },
    data: { status: InventoryStatus.REVOKED, revokedAt: new Date(), orderId: null },
  });

  if (result.count > 0) {
    logger.warn('Inventory codes revoked for order', { orderId, count: result.count, reason });
  }
  return result.count;
}

/** ASSIGNED -> DELIVERED. Terminal: a delivered code is never recycled. */
export async function markDelivered(orderId: string): Promise<number> {
  const result = await prisma.inventoryCode.updateMany({
    where: { orderId, status: InventoryStatus.ASSIGNED },
    data: { status: InventoryStatus.DELIVERED, deliveredAt: new Date() },
  });
  return result.count;
}