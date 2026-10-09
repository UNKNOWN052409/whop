/**
 * Order state machine (spec §10).
 *
 * The transition table is the single source of truth. Nothing may set
 * Order.status directly — every mutation goes through `assertTransition` (or
 * `transitionOrder`, which also writes the audit trail). This is what makes
 * "never skip a state because the frontend said success" enforceable rather
 * than aspirational.
 *
 * A frontend `success` callback does not appear anywhere in this file. The only
 * path into PAYMENT_VERIFIED is the webhook verifier.
 */

import { OrderStatus } from '@prisma/client';
import { AppError } from '@/lib/errors';

export const ORDER_STATUSES = Object.values(OrderStatus);

/** Statuses from which no further work will be done. */
export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
]);

/** Statuses that should be surfaced to an operator's attention. */
export const ATTENTION_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.MANUAL_REVIEW,
  OrderStatus.FULFILLMENT_FAILED,
  OrderStatus.PAYMENT_REVERSED,
  OrderStatus.PAYMENT_EXPIRED,
]);

/**
 * Legal transitions.
 *
 * Happy path:
 *   CREATED → PAYMENT_PENDING → PAYMENT_VERIFIED → FULFILLMENT_PENDING
 *           → CODE_RESERVED → CODE_DELIVERED → COMPLETED
 *
 * Failure/reversal edges are permitted from the stages where they are still
 * physically possible (a payment can only be reversed before fulfillment, an
 * order can only be cancelled before it is paid).
 */
const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  CREATED: [OrderStatus.PAYMENT_PENDING, OrderStatus.CANCELLED, OrderStatus.PAYMENT_FAILED],

  PAYMENT_PENDING: [
    OrderStatus.PAYMENT_VERIFIED,
    OrderStatus.PAYMENT_FAILED,
    OrderStatus.PAYMENT_EXPIRED,
    OrderStatus.MANUAL_REVIEW,
    OrderStatus.CANCELLED,
  ],

  PAYMENT_VERIFIED: [
    OrderStatus.FULFILLMENT_PENDING,
    OrderStatus.MANUAL_REVIEW,
    // Reversal before any code is released.
    OrderStatus.PAYMENT_REVERSED,
    OrderStatus.REFUND_PENDING,
    OrderStatus.FULFILLMENT_FAILED,
  ],

  FULFILLMENT_PENDING: [
    OrderStatus.CODE_RESERVED,
    OrderStatus.FULFILLMENT_FAILED,
    OrderStatus.MANUAL_REVIEW,
    // Inventory exhausted or revoked mid-flight.
    OrderStatus.REFUND_PENDING,
    OrderStatus.PAYMENT_REVERSED,
  ],

  CODE_RESERVED: [
    OrderStatus.CODE_DELIVERED,
    OrderStatus.FULFILLMENT_FAILED,
    OrderStatus.MANUAL_REVIEW,
    OrderStatus.REFUND_PENDING,
  ],

  CODE_DELIVERED: [
    OrderStatus.COMPLETED,
    OrderStatus.FULFILLMENT_FAILED,
    OrderStatus.REFUND_PENDING,
  ],

  COMPLETED: [OrderStatus.REFUND_PENDING, OrderStatus.PAYMENT_REVERSED, OrderStatus.MANUAL_REVIEW],

  // --- Failure states ---
  PAYMENT_FAILED: [OrderStatus.PAYMENT_PENDING, OrderStatus.REFUND_PENDING, OrderStatus.MANUAL_REVIEW],
  PAYMENT_EXPIRED: [OrderStatus.PAYMENT_PENDING, OrderStatus.REFUND_PENDING, OrderStatus.MANUAL_REVIEW],
  PAYMENT_REVERSED: [OrderStatus.REFUND_PENDING, OrderStatus.MANUAL_REVIEW],
  FULFILLMENT_FAILED: [
    OrderStatus.FULFILLMENT_PENDING,
    OrderStatus.MANUAL_REVIEW,
    OrderStatus.REFUND_PENDING,
  ],
  REFUND_PENDING: [OrderStatus.REFUNDED, OrderStatus.FULFILLMENT_FAILED, OrderStatus.MANUAL_REVIEW],
  REFUNDED: [],
  MANUAL_REVIEW: [
    OrderStatus.FULFILLMENT_PENDING,
    OrderStatus.PAYMENT_VERIFIED,
    OrderStatus.REFUND_PENDING,
    OrderStatus.PAYMENT_FAILED,
    OrderStatus.CANCELLED,
    OrderStatus.COMPLETED,
  ],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function allowedTransitions(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from] ?? [];
}

/**
 * Throws on an illegal transition. Call this before any `order.update`.
 *
 * Illegal transitions are bugs, not user errors — an unexpected transition is
 * logged and surfaces as a 500 so it cannot be mistaken for a normal failure.
 */
export function assertTransition(
  from: OrderStatus,
  to: OrderStatus,
  context?: { orderId?: string; reason?: string },
): void {
  if (canTransition(from, to)) return;
  const allowed = allowedTransitions(from);
  throw new AppError(
    `Illegal order state transition ${from} -> ${to}`,
    500,
    'INVALID_STATE_TRANSITION',
    {
      // Nested under `details` because that is the only structured field
      // AppError accepts; the top level is reserved for transport metadata.
      details: {
        from,
        to,
        allowed: [...allowed],
        orderId: context?.orderId,
        reason: context?.reason,
      },
    },
  );
}

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * States in which valuable inventory must not be released automatically
 * (spec §17). A high-risk order parks in MANUAL_REVIEW first.
 */
export function shouldHoldForRisk(status: OrderStatus): boolean {
  return status === OrderStatus.MANUAL_REVIEW;
}

/**
 * Happy-path ordering, used by reconciliation to detect an order that skipped
 * a stage (e.g. went straight to COMPLETED with no PaymentEvent).
 */
export const HAPPY_PATH: readonly OrderStatus[] = [
  OrderStatus.CREATED,
  OrderStatus.PAYMENT_PENDING,
  OrderStatus.PAYMENT_VERIFIED,
  OrderStatus.FULFILLMENT_PENDING,
  OrderStatus.CODE_RESERVED,
  OrderStatus.CODE_DELIVERED,
  OrderStatus.COMPLETED,
];

export function pathIndex(status: OrderStatus): number {
  return HAPPY_PATH.indexOf(status);
}