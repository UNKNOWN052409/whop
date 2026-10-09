/**
 * Atomic inventory allocation (spec §11, §13, §21).
 *
 * This is the heart of the system. Everything else — the storefront counter, the
 * fulfillment pipeline, the reaper — exists to keep this one function honest:
 * a code is either fully reserved for an order or it was never touched.
 *
 * WHY RAW SQL AND NOT A PRISMA CALL
 * ---------------------------------
 * Allocation needs `SELECT ... FOR UPDATE SKIP LOCKED`: pick N rows, lock them,
 * and skip rows another transaction is already holding instead of blocking
 * behind them. Prisma's query API has no equivalent, and reading-then-writing
 * under the default READ COMMITTED isolation would let two workers observe the
 * same AVAILABLE row and sell it twice.
 *
 * WHY ALL-OR-NOTHING
 * ------------------
 * A partially allocated order is a customer who paid for one code and got a
 * different number than they paid for. If fewer rows are available than were
 * requested we throw, which rolls the transaction back — the row locks are
 * released and no counter was ever decremented.
 *
 * SAFETY NET: `InventoryCode.orderId` is @unique in the schema. Even if every
 * line of logic above were wrong — a replayed call, a retried transaction, two
 * instances racing — the database refuses to bind the same code row to a second
 * order, and refuses to bind a second code row to an order. That index is the
 * last line of defence against double-selling, and the reason `reserveCodes` is
 * safe to call any number of times for the same order.
 *
 * SECRETS: nothing in this file reads, returns or logs a plaintext redeem code.
 * Only row ids cross the boundary.
 */

import { InventoryStatus, Prisma } from '@prisma/client';
import { adjustInventoryCount } from '@/catalog/availability';
import { prisma, withTransactionRetry } from '@/db/prisma';
import { errors } from '@/lib/errors';
import { logger } from '@/lib/logger';

const DEFAULT_RESERVATION_TTL_SECONDS = 30 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 86_400;

/** Statuses that mean "this order still holds the code". */
const HELD_BY_ORDER: readonly InventoryStatus[] = [
  InventoryStatus.RESERVED,
  InventoryStatus.ASSIGNED,
  InventoryStatus.DELIVERED,
];

export interface ReserveCodesInput {
  orderId: string;
  productId: string;
  quantity: number;
  /** Reservation lease length. The reaper reclaims the code after this. */
  ttlSeconds?: number;
}

/** Identifiers only. Never the code itself. */
export interface ReservedCodeRef {
  readonly id: string;
}

export interface ReserveCodesResult {
  /** Reserved code row ids, oldest-first. No code material. */
  readonly codes: ReservedCodeRef[];
  /** Reservation lease expiry — the instant the reaper may reclaim these. */
  readonly expiresAt: Date;
}

/** Prisma's unique-constraint violation (P2002). */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

function resolveTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined) return DEFAULT_RESERVATION_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds)) {
    throw errors.validation('ttlSeconds must be a whole number of seconds');
  }
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, ttlSeconds));
}

function assertInput(input: ReserveCodesInput): void {
  if (!input.orderId || input.orderId.trim().length === 0) {
    throw errors.validation('orderId is required to reserve inventory');
  }
  if (!input.productId || input.productId.trim().length === 0) {
    throw errors.validation('productId is required to reserve inventory');
  }
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw errors.validation('quantity must be a positive whole number');
  }
}

/**
 * Reserve `quantity` redeem codes for an order, atomically.
 *
 * Throws `errors.insufficientInventory(productId)` — and changes nothing — when
 * the product cannot cover the whole request.
 */
export async function reserveCodes(input: ReserveCodesInput): Promise<ReserveCodesResult> {
  assertInput(input);
  const ttlSeconds = resolveTtl(input.ttlSeconds);
  const { orderId, productId, quantity } = input;

  try {
    return await withTransactionRetry(async (tx) => {
      // Replay safety. `InventoryCode.orderId` is unique, so binding a second
      // code to this order would fail at the database anyway; refusing up front
      // turns that crash into an idempotent no-op for a retried fulfillment job.
      const alreadyHeld = await tx.inventoryCode.findFirst({
        where: { orderId, status: { in: [...HELD_BY_ORDER] } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, status: true, reservationExpiresAt: true, reservedAt: true },
      });

      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

      if (alreadyHeld) {
        // Extend the lease only while the code is still merely RESERVED. An
        // ASSIGNED or DELIVERED code has no lease left to extend.
        if (
          alreadyHeld.status === InventoryStatus.RESERVED &&
          alreadyHeld.reservationExpiresAt !== null
        ) {
          await tx.inventoryCode.updateMany({
            where: { id: alreadyHeld.id, status: InventoryStatus.RESERVED },
            data: { reservationExpiresAt: expiresAt },
          });
        }

        logger.info('Inventory already reserved for order; reservation refreshed', {
          orderId,
          productId,
          codeId: alreadyHeld.id,
          status: alreadyHeld.status,
        });

        return { codes: [{ id: alreadyHeld.id }], expiresAt };
      }

      // Oldest-first: consume the stock that expires soonest so long-dated
      // codes stay sellable. SKIP LOCKED means a concurrent allocator takes the
      // next rows instead of blocking here, so throughput scales with cores.
      //
      // Expired-but-still-AVAILABLE codes are excluded on purpose — selling one
      // is a guaranteed refund.
      const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
          FROM "InventoryCode"
         WHERE "status" = 'AVAILABLE'
           AND "productId" = ${productId}
           AND ("expiresAt" IS NULL OR "expiresAt" > now())
         ORDER BY "createdAt" ASC
          LIMIT ${quantity}
          FOR UPDATE SKIP LOCKED
       `);

      if (candidates.length < quantity) {
        // Throwing inside the transaction rolls it back: the row locks above are
        // released, the counter is untouched, and not one code is half-sold.
        throw errors.insufficientInventory(productId);
      }

      const ids = candidates.map((row) => row.id);

      // The status guard is a compare-and-set: if anything moved these rows
      // between the SELECT and the UPDATE (they cannot, we hold the locks, but
      // defence in depth is free) we do not steal them.
      const claimed = await tx.inventoryCode.updateMany({
        where: {
          id: { in: ids },
          status: InventoryStatus.AVAILABLE,
          orderId: null,
        },
        data: {
          status: InventoryStatus.RESERVED,
          reservedAt: now,
          reservationExpiresAt: expiresAt,
          orderId,
        },
      });

      if (claimed.count !== quantity) {
        throw errors.insufficientInventory(productId);
      }

      // Same transaction, same product: the storefront counter can never show a
      // code that allocation has already taken.
      const remaining = await adjustInventoryCount(tx, productId, -quantity);

      logger.info('Redeem codes reserved', {
        orderId,
        productId,
        quantity,
        expiresAt: expiresAt.toISOString(),
        availableAfter: remaining,
      });

      return { codes: ids.map((id) => ({ id })), expiresAt };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The only reachable unique violation here is orderId: this order already
      // binds a code row. Say so plainly instead of surfacing a raw driver error.
      throw errors.criticalFulfillment(
        'A redeem code is already bound to this order; inventory was not changed',
        { orderId, productId, quantity },
      );
    }
    throw error;
  }
}

/**
 * Move an order's codes from RESERVED to ASSIGNED.
 *
 * ASSIGNMENT IS THE POINT OF NO RETURN: the reaper only reclaims RESERVED rows,
 * so once a code is ASSIGNED it stays with the order until it is delivered or
 * explicitly revoked.
 *
 * Idempotent — a second call updates zero rows and reports `assigned: 0`.
 */
export async function markAssigned(orderId: string): Promise<{ assigned: number }> {
  if (!orderId) throw errors.validation('orderId is required');

  const result = await prisma.inventoryCode.updateMany({
    where: { orderId, status: InventoryStatus.RESERVED },
    data: { status: InventoryStatus.ASSIGNED },
  });

  logger.info('Redeem codes assigned to order', {
    orderId,
    assigned: result.count,
  });

  return { assigned: result.count };
}