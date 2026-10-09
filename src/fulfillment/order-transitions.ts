/**
 * The single writer of Order.status used by the fulfillment pipeline.
 *
 * `src/orders/state-machine.ts` owns the transition TABLE; this module owns the
 * DB write. The split matters:
 *
 *  - `assertTransition()` decides whether a move is legal. An illegal move is a
 *    bug and throws INVALID_STATE_TRANSITION (surfaced as a 500).
 *  - The write itself is a compare-and-set: `UPDATE ... WHERE id = ? AND status
 *    = <the state we validated>`. If the count comes back 0, somebody else
 *    moved the order first and we do nothing. Without this, two concurrent
 *    fulfillment workers would both read PAYMENT_VERIFIED and both write
 *    FULFILLMENT_PENDING, producing two OrderStateTransition rows and two
 *    deliveries for one order.
 *  - The status write and its audit row share one transaction, so a crash can
 *    never leave an order in a new state with no explanation of why.
 *
 * NOTHING else in the fulfillment pipeline assigns Order.status.
 */

import { OrderStatus, type Prisma } from '@prisma/client';
import { prisma, withTransaction } from '@/db/prisma';
import { assertTransition } from '@/orders/state-machine';
import { logger } from '@/lib/logger';
import { errors } from '@/lib/errors';

/** Either the singleton client or an ambient transaction. */
export type TransitionDb = Prisma.TransactionClient | typeof prisma;

export type TransitionSkipReason = 'ALREADY_IN_STATE' | 'CONCURRENT_WRITE' | 'UNKNOWN';

export interface TransitionResult {
  applied: boolean;
  from: OrderStatus;
  to: OrderStatus;
  skipReason?: TransitionSkipReason;
}

export interface TransitionInput {
  /**
   * States the caller believes the order is in. When supplied they are folded
   * into the WHERE clause, so the write fails closed if anything moved the
   * order between our read and our write.
   */
  expectedFrom?: OrderStatus | readonly OrderStatus[];
  reason: string;
  /** Who caused the move: 'system', 'webhook', 'fulfillment', an admin id... */
  actor?: string;
  metadata?: Prisma.InputJsonValue;
  /**
   * Extra columns written in the same UPDATE (e.g. completedAt). `status` is
   * deliberately excluded from the type so a caller cannot smuggle in an
   * unvalidated status change.
   */
  data?: Omit<Prisma.OrderUncheckedUpdateInput, 'status'>;
}

async function readStatus(db: TransitionDb, orderId: string): Promise<OrderStatus | null> {
  const row = await db.order.findUnique({ where: { id: orderId }, select: { status: true } });
  return row?.status ?? null;
}

async function applyTransition(
  db: TransitionDb,
  orderId: string,
  to: OrderStatus,
  input: TransitionInput,
): Promise<TransitionResult> {
  const current = await readStatus(db, orderId);
  if (current === null) throw errors.notFound('Order');

  // Re-running a completed transition is a no-op, not an error: durable queues
  // redeliver, and "already done" is the correct answer for them.
  if (current === to) {
    return { applied: false, from: current, to, skipReason: 'ALREADY_IN_STATE' };
  }

  // Throws INVALID_STATE_TRANSITION for an illegal edge.
  assertTransition(current, to, { orderId, reason: input.reason });

  const expected = input.expectedFrom;
  // Typed separately so the readonly-array case narrows to a Prisma enum filter
  // rather than leaking a union the updateMany call rejects.
  const statusFilter: Prisma.OrderWhereInput['status'] =
    expected === undefined
      ? (current as OrderStatus)
      : Array.isArray(expected)
        ? { in: [...expected] as OrderStatus[] }
        : (expected as OrderStatus);

  const where: Prisma.OrderWhereInput = {
    id: orderId,
    status: statusFilter,
  };

  const updated = await db.order.updateMany({
    where,
    data: { ...(input.data ?? {}), status: to },
  });

  if (updated.count === 0) {
    const after = await readStatus(db, orderId);
    logger.warn('Order transition lost a compare-and-set race', {
      orderId,
      from: current,
      to,
      actual: after,
      reason: input.reason,
    });
    return {
      applied: false,
      from: after ?? current,
      to,
      skipReason: after === to ? 'ALREADY_IN_STATE' : 'CONCURRENT_WRITE',
    };
  }

  await db.orderStateTransition.create({
    data: {
      orderId,
      fromState: current,
      toState: to,
      reason: input.reason,
      actor: input.actor ?? 'system',
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  });

  logger.info('Order state transition applied', {
    orderId,
    from: current,
    to,
    reason: input.reason,
    actor: input.actor ?? 'system',
  });

  return { applied: true, from: current, to };
}

/**
 * Move an order through the state machine and record the audit trail.
 *
 * Pass `db` when the caller already holds a transaction (so the transition
 * joins it); otherwise the write and the audit row are wrapped together here.
 */
export async function transitionOrder(
  orderId: string,
  to: OrderStatus,
  input: TransitionInput,
  db?: TransitionDb,
): Promise<TransitionResult> {
  if (db) return applyTransition(db, orderId, to, input);
  return withTransaction((tx) => applyTransition(tx, orderId, to, input));
}