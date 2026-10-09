/**
 * The order state machine.
 *
 * The transition table is the single source of truth for "a payment succeeded",
 * so this suite pins it EXHAUSTIVELY: every (from, to) pair over the whole
 * OrderStatus enum is asserted against a copy of the documented table. A new
 * status, or a new edge, fails here until the intent is written down.
 */

import { OrderStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  ATTENTION_STATUSES,
  HAPPY_PATH,
  TERMINAL_STATUSES,
  allowedTransitions,
  assertTransition,
  canTransition,
  isTerminal,
  pathIndex,
  shouldHoldForRisk,
} from '@/orders/state-machine';
import { AppError } from '@/lib/errors';

/** A copy of the documented transition table, transcribed independently. */
const EXPECTED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  CREATED: ['PAYMENT_PENDING', 'CANCELLED', 'PAYMENT_FAILED'],
  PAYMENT_PENDING: [
    'PAYMENT_VERIFIED',
    'PAYMENT_FAILED',
    'PAYMENT_EXPIRED',
    'MANUAL_REVIEW',
    'CANCELLED',
  ],
  PAYMENT_VERIFIED: [
    'FULFILLMENT_PENDING',
    'MANUAL_REVIEW',
    'PAYMENT_REVERSED',
    'REFUND_PENDING',
    'FULFILLMENT_FAILED',
  ],
  FULFILLMENT_PENDING: [
    'CODE_RESERVED',
    'FULFILLMENT_FAILED',
    'MANUAL_REVIEW',
    'REFUND_PENDING',
    'PAYMENT_REVERSED',
  ],
  CODE_RESERVED: ['CODE_DELIVERED', 'FULFILLMENT_FAILED', 'MANUAL_REVIEW', 'REFUND_PENDING'],
  CODE_DELIVERED: ['COMPLETED', 'FULFILLMENT_FAILED', 'REFUND_PENDING'],
  COMPLETED: ['REFUND_PENDING', 'PAYMENT_REVERSED', 'MANUAL_REVIEW'],
  PAYMENT_FAILED: ['PAYMENT_PENDING', 'REFUND_PENDING', 'MANUAL_REVIEW'],
  PAYMENT_EXPIRED: ['PAYMENT_PENDING', 'REFUND_PENDING', 'MANUAL_REVIEW'],
  PAYMENT_REVERSED: ['REFUND_PENDING', 'MANUAL_REVIEW'],
  FULFILLMENT_FAILED: ['FULFILLMENT_PENDING', 'MANUAL_REVIEW', 'REFUND_PENDING'],
  REFUND_PENDING: ['REFUNDED', 'FULFILLMENT_FAILED', 'MANUAL_REVIEW'],
  REFUNDED: [],
  MANUAL_REVIEW: [
    'FULFILLMENT_PENDING',
    'PAYMENT_VERIFIED',
    'REFUND_PENDING',
    'PAYMENT_FAILED',
    'CANCELLED',
    'COMPLETED',
  ],
  CANCELLED: [],
};

const ALL_STATUSES = Object.values(OrderStatus);

describe('transition table', () => {
  it('covers every status in the enum', () => {
    expect([...ALL_STATUSES].sort()).toEqual([...Object.keys(EXPECTED_TRANSITIONS)].sort());
  });

  it('allows exactly the documented edges, and no others', () => {
    const undocumented: string[] = [];
    for (const from of ALL_STATUSES) {
      const expected = EXPECTED_TRANSITIONS[from] ?? [];
      for (const to of ALL_STATUSES) {
        const shouldBeLegal = expected.includes(to);
        if (canTransition(from, to) !== shouldBeLegal) {
          undocumented.push(`${from} -> ${to} (expected legal=${String(shouldBeLegal)})`);
        }
      }
    }
    expect(undocumented).toEqual([]);
  });

  it('assertTransition passes for every legal transition', () => {
    for (const from of ALL_STATUSES) {
      for (const to of EXPECTED_TRANSITIONS[from] ?? []) {
        expect(() => assertTransition(from, to)).not.toThrow();
      }
    }
  });

  it('assertTransition throws for every illegal transition', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if ((EXPECTED_TRANSITIONS[from] ?? []).includes(to)) continue;
        expect(() => assertTransition(from, to, { orderId: 'order_test' })).toThrow(AppError);
      }
    }
  });
});

describe('illegal transitions', () => {
  it('refuses to skip straight to COMPLETED', () => {
    // The frontend `success` callback must never be able to do this: only the
    // verified webhook path reaches COMPLETED, via CODE_DELIVERED.
    for (const from of [
      OrderStatus.CREATED,
      OrderStatus.PAYMENT_PENDING,
      OrderStatus.PAYMENT_VERIFIED,
      OrderStatus.FULFILLMENT_PENDING,
      OrderStatus.CODE_RESERVED,
    ] as const) {
      expect(canTransition(from, OrderStatus.COMPLETED)).toBe(false);
      expect(() => assertTransition(from, OrderStatus.COMPLETED)).toThrow(
        /Illegal order state transition/,
      );
    }
  });

  it('refuses to deliver a code before it is reserved', () => {
    expect(canTransition(OrderStatus.PAYMENT_VERIFIED, OrderStatus.CODE_DELIVERED)).toBe(false);
    expect(canTransition(OrderStatus.FULFILLMENT_PENDING, OrderStatus.CODE_DELIVERED)).toBe(false);
  });

  it('refuses to complete a cancelled order', () => {
    expect(() => assertTransition(OrderStatus.CANCELLED, OrderStatus.COMPLETED)).toThrow();
  });

  it('throws a 500 INVALID_STATE_TRANSITION AppError with the allowed set', () => {
    try {
      assertTransition(OrderStatus.CREATED, OrderStatus.COMPLETED, {
        orderId: 'order_1',
        reason: 'unit test',
      });
      expect.unreachable('assertTransition should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.statusCode).toBe(500);
      expect(appError.code).toBe('INVALID_STATE_TRANSITION');
      expect(appError.details).toMatchObject({
        from: 'CREATED',
        to: 'COMPLETED',
        orderId: 'order_1',
        reason: 'unit test',
      });
    }
  });
});

describe('terminal states', () => {
  it('CANCELLED and REFUNDED have no exits at all', () => {
    for (const terminal of [OrderStatus.CANCELLED, OrderStatus.REFUNDED] as const) {
      expect(allowedTransitions(terminal)).toEqual([]);
      expect(isTerminal(terminal)).toBe(true);
      for (const to of ALL_STATUSES) {
        expect(canTransition(terminal, to)).toBe(false);
        expect(() => assertTransition(terminal, to)).toThrow();
      }
    }
  });

  it('COMPLETED is terminal for fulfillment: only reversal/refund/admin exits', () => {
    expect(TERMINAL_STATUSES.has(OrderStatus.COMPLETED)).toBe(true);
    expect(isTerminal(OrderStatus.COMPLETED)).toBe(true);
    // Terminal means "no further FULFILLMENT work". A refund or a reversal is
    // still legal — and must stay legal, otherwise a chargeback could never be
    // recorded against a delivered order.
    expect([...allowedTransitions(OrderStatus.COMPLETED)].sort()).toEqual(
      ['MANUAL_REVIEW', 'PAYMENT_REVERSED', 'REFUND_PENDING'].sort(),
    );
    for (const forbidden of [
      OrderStatus.PAYMENT_PENDING,
      OrderStatus.PAYMENT_VERIFIED,
      OrderStatus.FULFILLMENT_PENDING,
      OrderStatus.CODE_RESERVED,
      OrderStatus.CODE_DELIVERED,
      OrderStatus.COMPLETED,
    ] as const) {
      expect(canTransition(OrderStatus.COMPLETED, forbidden)).toBe(false);
    }
  });

  it('a terminal order never loops back into the happy path', () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const stage of HAPPY_PATH) {
        if (stage === terminal) continue;
        if (terminal === OrderStatus.COMPLETED && stage === OrderStatus.COMPLETED) continue;
        expect(canTransition(terminal, stage)).toBe(false);
      }
    }
  });
});

describe('happy path', () => {
  it('every adjacent hop is legal', () => {
    for (let i = 0; i + 1 < HAPPY_PATH.length; i += 1) {
      const from = HAPPY_PATH[i]!;
      const to = HAPPY_PATH[i + 1]!;
      expect(canTransition(from, to)).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });

  it('runs CREATED -> ... -> COMPLETED in order', () => {
    expect(HAPPY_PATH).toEqual([
      'CREATED',
      'PAYMENT_PENDING',
      'PAYMENT_VERIFIED',
      'FULFILLMENT_PENDING',
      'CODE_RESERVED',
      'CODE_DELIVERED',
      'COMPLETED',
    ]);
    expect(pathIndex(OrderStatus.CREATED)).toBe(0);
    expect(pathIndex(OrderStatus.COMPLETED)).toBe(HAPPY_PATH.length - 1);
    expect(pathIndex(OrderStatus.MANUAL_REVIEW)).toBe(-1);
  });
});

describe('risk hold', () => {
  it('only MANUAL_REVIEW holds inventory', () => {
    expect(shouldHoldForRisk(OrderStatus.MANUAL_REVIEW)).toBe(true);
    expect(shouldHoldForRisk(OrderStatus.PAYMENT_VERIFIED)).toBe(false);
    expect(shouldHoldForRisk(OrderStatus.COMPLETED)).toBe(false);
  });

  it('flags the statuses an operator must look at', () => {
    for (const status of [
      OrderStatus.MANUAL_REVIEW,
      OrderStatus.FULFILLMENT_FAILED,
      OrderStatus.PAYMENT_REVERSED,
      OrderStatus.PAYMENT_EXPIRED,
    ] as const) {
      expect(ATTENTION_STATUSES.has(status)).toBe(true);
    }
    expect(ATTENTION_STATUSES.has(OrderStatus.COMPLETED)).toBe(false);
  });
});