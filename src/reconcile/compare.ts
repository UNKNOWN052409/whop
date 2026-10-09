/**
 * Reconciliation comparisons (spec §18).
 *
 * Everything in this file is PURE: plain data in, plain data out. No Prisma, no
 * fetch, no clock reads that the caller cannot inject. That is what makes the
 * engine's correctness testable without a database and without a provider.
 *
 * MONEY RULE: every amount handled here is an INTEGER count of minor units
 * (cents) plus a currency code. A provider amount that is not an integer is
 * itself reported as a discrepancy rather than silently rounded — a rounded
 * amount in a ledger is a financial bug, not a rounding error.
 *
 * SECURITY: nothing in this module can emit a plaintext redeem code, PAN, CVV
 * or OTP. Provider snapshots are read from the `PaymentProvider` interface,
 * which by construction exposes only opaque ids, amounts and currencies.
 */

import {
  EmailStatus,
  InventoryStatus,
  OrderStatus,
  PaymentStatus,
  ProductStatus,
  ProviderKind,
  ReconciliationType,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { formatMoney } from '@/lib/money';
import { sha256 } from '@/lib/ids';
import type { ProviderPaymentDetails, RefundRecord } from '@/payments/types';

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/**
 * Normalises an arbitrary value into something a Prisma `Json` column accepts.
 *
 * Returns `null` for a null input: this feeds `Discrepancy.expected`/`.actual`,
 * whose values are `InputJsonValue | null`, so a JSON null (rather than the
 * Prisma-side `JsonNull`/`DbNull` sentinels) is the correct representation for
 * "we observed nothing here".
 */
function toJsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') return toJsonObject(value as Record<string, unknown>);
  return String(value);
}

/** Drops `undefined` so the value round-trips through Postgres jsonb cleanly. */
export function toJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  const out: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    out[key] = toJsonValue(entry);
  }
  return out;
}

/**
 * Stable identity for "the same issue, seen again".
 *
 * Stored inside `ReconciliationRecord.expected.fingerprint` and used to make the
 * worker idempotent: re-running a window that still shows the same problem must
 * not create a second OPEN record. It must be a pure function of the *identity*
 * of the problem, never of when it was observed — otherwise every run mints a
 * new "new" discrepancy and the queue is useless.
 */
export function fingerprint(parts: ReadonlyArray<string | number | null | undefined>): string {
  const normalized = parts.map((part) => (part === null || part === undefined ? '~' : String(part)));
  return sha256(normalized.join('|'));
}

/** Reads a fingerprint back out of a persisted `expected` JSON column. */
export function readFingerprint(expected: unknown): string | null {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) return null;
  const value = (expected as Record<string, unknown>)['fingerprint'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Snapshots — structural projections of the rows this worker reads
// ---------------------------------------------------------------------------

export interface OrderSnapshot {
  id: string;
  reference: string;
  status: OrderStatus;
  totalMinor: number;
  currency: string;
  productId: string;
  quantity: number;
  createdAt: Date;
  updatedAt: Date;
  paidAt: Date | null;
}

export interface PaymentSnapshot {
  id: string;
  orderId: string;
  provider: ProviderKind;
  providerPaymentId: string | null;
  providerCheckoutId: string | null;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefundSnapshot {
  id: string;
  orderId: string;
  paymentId: string;
  providerRefundId: string | null;
  status: string;
  amountMinor: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliverySnapshot {
  id: string;
  orderId: string;
  status: EmailStatus;
  sentAt: Date | null;
}

/** Per-order redeem-code counts. Codes are NEVER read, only counted. */
export interface OrderCodeCount {
  orderId: string;
  total: number;
  reserved: number;
  assigned: number;
  delivered: number;
  revoked: number;
}

export interface ProductInventorySnapshot {
  id: string;
  slug: string;
  productName: string;
  status: ProductStatus;
  /** Denormalised `Product.inventoryCount` — what the storefront trusts. */
  inventoryCount: number;
  /** Rows actually in InventoryStatus.AVAILABLE right now. */
  availableCount: number;
}

// ---------------------------------------------------------------------------
// Discrepancy — the unit of work this worker produces
// ---------------------------------------------------------------------------

export type DiscrepancySeverity = 'INFO' | 'WARN' | 'CRITICAL';

export interface Discrepancy {
  type: ReconciliationType;
  severity: DiscrepancySeverity;
  /** Stable identity; see `fingerprint`. */
  fingerprint: string;
  /** Machine-readable sub-kind, e.g. "completed-without-delivery". */
  reason: string;
  orderId: string | null;
  paymentId: string | null;
  providerPaymentId: string | null;
  productId: string | null;
  /** What the ledger says should be true. */
  expected: Prisma.InputJsonObject;
  /** What was actually observed. */
  actual: Prisma.InputJsonObject;
  /** One-line human summary for `ReconciliationRecord.discrepancy`. */
  discrepancy: string;
}

function discrepancy(input: {
  type: ReconciliationType;
  severity: DiscrepancySeverity;
  reason: string;
  orderId?: string | null;
  paymentId?: string | null;
  providerPaymentId?: string | null;
  productId?: string | null;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  discrepancy: string;
}): Discrepancy {
  return {
    type: input.type,
    severity: input.severity,
    fingerprint: fingerprint([input.type, input.reason, input.orderId, input.paymentId, input.providerPaymentId, input.productId]),
    reason: input.reason,
    orderId: input.orderId ?? null,
    paymentId: input.paymentId ?? null,
    providerPaymentId: input.providerPaymentId ?? null,
    productId: input.productId ?? null,
    expected: toJsonObject(input.expected),
    actual: toJsonObject(input.actual),
    discrepancy: input.discrepancy,
  };
}

// ---------------------------------------------------------------------------
// Small normalisers
// ---------------------------------------------------------------------------

/**
 * Whop returns lowercase ISO 4217 ("usd"); the catalog stores lowercase too but
 * order snapshots may carry either. Comparing case-insensitively is correct —
 * comparing loosely (stripping letters) would hide a real mismatch.
 */
export function normalizeCurrency(currency: string | null | undefined): string {
  return (currency ?? '').trim().toUpperCase();
}

export function currenciesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return normalizeCurrency(a) === normalizeCurrency(b);
}

export type ProviderOutcome =
  | 'PAID'
  | 'PENDING'
  | 'REQUIRES_ACTION'
  | 'FAILED'
  | 'CANCELED'
  | 'DISPUTED'
  | 'REVERSED'
  | 'REFUNDED'
  | 'UNKNOWN';

export function providerOutcome(details: ProviderPaymentDetails): ProviderOutcome {
  switch (details.status.status) {
    case 'PAID':
      // Whop reports a fully refunded payment as status "paid"; the money is
      // gone, so money-wise this is a REFUNDED outcome.
      if (typeof details.refundedAmountMinor === 'number' && details.refundedAmountMinor > 0) {
        return 'REFUNDED';
      }
      return 'PAID';
    case 'PENDING':
      return 'PENDING';
    case 'REQUIRES_ACTION':
      return 'REQUIRES_ACTION';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELED':
      return 'CANCELED';
    case 'DISPUTED':
      return 'DISPUTED';
    case 'REVERSED':
      return 'REVERSED';
    default:
      return 'UNKNOWN';
  }
}

/** True when the outcome means "the customer paid and the money moved". */
export function isProviderSettled(outcome: ProviderOutcome): boolean {
  return outcome === 'PAID' || outcome === 'REFUNDED';
}

/** True when the money was taken back (refund, dispute, chargeback). */
export function isProviderReversed(outcome: ProviderOutcome): boolean {
  return outcome === 'REFUNDED' || outcome === 'DISPUTED' || outcome === 'REVERSED';
}

/** Internal Payment.status values that mean "we already know how this ended". */
export const SETTLED_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>([
  PaymentStatus.PAID,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
  PaymentStatus.DISPUTED,
  PaymentStatus.REVERSED,
]);

/**
 * States where a paid-but-undelivered customer has already been hurt, or where
 * a paid order should have moved on within minutes.
 */
export const STUCK_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PAYMENT_VERIFIED,
  OrderStatus.FULFILLMENT_PENDING,
  OrderStatus.CODE_RESERVED,
];

// ---------------------------------------------------------------------------
// Provider ↔ internal link (the join the engine builds)
// ---------------------------------------------------------------------------

export interface ProviderPaymentLink {
  providerPayment: ProviderPaymentDetails;
  /** Internal Payment row matched on providerPaymentId, if any. */
  payment: PaymentSnapshot | null;
  /** The order that payment belongs to, if any. */
  order: OrderSnapshot | null;
  /** PaymentEvents linked to the internal payment row. */
  eventCount: number;
  /** Of those, how many failed to verify or failed to process. */
  failedEventCount: number;
}

export interface CompareProviderOptions {
  /** When false, amount/currency comparisons against the order are skipped. */
  compareOrderTotals?: boolean;
}

// ---------------------------------------------------------------------------
// The core comparison
// ---------------------------------------------------------------------------

/**
 * Compares one provider payment against the order/ledger and emits every
 * discrepancy it implies. Pure — links are passed in already joined.
 *
 * Emitted types (spec §18):
 *   MISSING_PAYMENT, MISSING_WEBHOOK, FAILED_WEBHOOK,
 *   WRONG_AMOUNT, WRONG_CURRENCY, REVERSED_PAYMENT
 */
export function compareProviderPaymentLinks(
  links: readonly ProviderPaymentLink[],
  options: CompareProviderOptions = {},
): Discrepancy[] {
  const compareOrderTotals = options.compareOrderTotals ?? true;
  const out: Discrepancy[] = [];

  for (const link of links) {
    const providerPayment = link.providerPayment;
    const providerId = providerPayment.providerPaymentId;
    const outcome = providerOutcome(providerPayment);
    const settled = isProviderSettled(outcome);

    // --- MISSING_PAYMENT --------------------------------------------------
    // A paid provider payment with no Payment row bound to it: the customer
    // handed over money and we have no record of the sale (and usually no
    // order either, since the order is reached through the payment).
    if (link.payment === null && settled) {
      out.push(
        discrepancy({
          type: ReconciliationType.MISSING_PAYMENT,
          severity: 'CRITICAL',
          reason: 'no-internal-payment-row',
          orderId: link.order?.id ?? null,
          providerPaymentId: providerId,
          expected: {
            providerPaymentId: providerId,
            amountMinor: providerPayment.amountMinor ?? null,
            currency: providerPayment.currency ?? null,
            outcome,
          },
          actual: {
            internalPaymentFound: false,
            internalOrderFound: link.order !== null,
            paidAt: providerPayment.paidAt ?? null,
          },
          discrepancy:
            `Provider ${providerId} settled ${formatMoney(
              providerPayment.amountMinor ?? 0,
              providerPayment.currency ?? 'USD',
            )} but no internal Payment row exists. A customer paid and we have no order.`,
        }),
      );
    }

    // --- MISSING_WEBHOOK / FAILED_WEBHOOK ---------------------------------
    // The headline check: the provider says the money moved and we have no
    // PaymentEvent proving a webhook told us about it.
    if (settled && link.eventCount === 0) {
      out.push(
        discrepancy({
          type: ReconciliationType.MISSING_WEBHOOK,
          severity: 'CRITICAL',
          reason: 'no-payment-event',
          orderId: link.order?.id ?? null,
          paymentId: link.payment?.id ?? null,
          providerPaymentId: providerId,
          expected: {
            paymentEventCount: { gte: 1 },
            internalPaymentStatus: link.payment?.status ?? null,
            orderStatus: link.order?.status ?? null,
            providerOutcome: outcome,
          },
          actual: { paymentEventCount: 0 },
          discrepancy:
            `Provider payment ${providerId} is ${outcome} but no PaymentEvent was ever recorded. ` +
            'The webhook never arrived or never persisted — this is the "customer paid and nobody noticed" case.',
        }),
      );
    } else if (settled && link.eventCount > 0 && link.failedEventCount === link.eventCount) {
      out.push(
        discrepancy({
          type: ReconciliationType.FAILED_WEBHOOK,
          severity: 'WARN',
          reason: 'all-payment-events-failed',
          orderId: link.order?.id ?? null,
          paymentId: link.payment?.id ?? null,
          providerPaymentId: providerId,
          expected: { atLeastOneEventProcessed: true },
          actual: { eventCount: link.eventCount, failedEventCount: link.failedEventCount },
          discrepancy:
            `Every recorded PaymentEvent for provider payment ${providerId} failed verification or processing.`,
        }),
      );
    }

    if (link.payment !== null && link.order !== null) {
      // --- Internal ledger never learned the payment succeeded -----------
      if (settled && !SETTLED_PAYMENT_STATUSES.has(link.payment.status)) {
        out.push(
          discrepancy({
            type: ReconciliationType.MISSING_WEBHOOK,
            severity: 'CRITICAL',
            reason: 'internal-payment-not-settled',
            orderId: link.order.id,
            paymentId: link.payment.id,
            providerPaymentId: providerId,
            expected: { paymentStatus: PaymentStatus.PAID, orderPaidAt: 'set' },
            actual: {
              paymentStatus: link.payment.status,
              orderStatus: link.order.status,
              orderPaidAt: link.order.paidAt,
              providerOutcome: outcome,
            },
            discrepancy:
              `Provider reports ${providerId} as ${outcome} but Payment ${link.payment.id} is still ` +
              `${link.payment.status} and order ${link.order.reference} has no paidAt.`,
          }),
        );
      }

      // --- WRONG_AMOUNT ----------------------------------------------------
      const providerAmount = providerPayment.amountMinor;
      const expectedAmount = compareOrderTotals ? link.order.totalMinor : link.payment.amountMinor;
      if (providerAmount !== undefined && providerAmount !== null) {
        if (!Number.isInteger(providerAmount)) {
          out.push(
            discrepancy({
              type: ReconciliationType.WRONG_AMOUNT,
              severity: 'CRITICAL',
              reason: 'non-integer-provider-amount',
              orderId: link.order.id,
              paymentId: link.payment.id,
              providerPaymentId: providerId,
              expected: { integerMinorUnits: true },
              actual: { providerAmount, providerCurrency: providerPayment.currency ?? null },
              discrepancy:
                `Provider payment ${providerId} reported a non-integer amount (${String(providerAmount)}). ` +
                'Minor units must be whole cents; this value cannot be reconciled without guessing.',
            }),
          );
        } else if (providerAmount !== expectedAmount) {
          const delta = providerAmount - expectedAmount;
          const currency = providerPayment.currency ?? link.order.currency;
          out.push(
            discrepancy({
              type: ReconciliationType.WRONG_AMOUNT,
              severity: 'CRITICAL',
              reason: 'amount-differs',
              orderId: link.order.id,
              paymentId: link.payment.id,
              providerPaymentId: providerId,
              expected: {
                amountMinor: expectedAmount,
                currency: normalizeCurrency(currency),
                source: compareOrderTotals ? 'Order.totalMinor' : 'Payment.amountMinor',
              },
              actual: {
                providerAmountMinor: providerAmount,
                currency: normalizeCurrency(providerPayment.currency),
                paymentRowAmountMinor: link.payment.amountMinor,
                deltaMinor: delta,
                delta: formatMoney(delta, currency),
                providerNetAmountMinor: providerPayment.netAmountMinor ?? null,
                providerFeeMinor: providerPayment.feeMinor ?? null,
              },
              discrepancy:
                `Amount mismatch on ${providerId}: provider charged ${formatMoney(providerAmount, currency)} ` +
                `but the order expects ${formatMoney(expectedAmount, currency)} (delta ${formatMoney(delta, currency)}).`,
            }),
          );
        }
      }

      // --- WRONG_CURRENCY --------------------------------------------------
      if (
        providerPayment.currency !== undefined &&
        providerPayment.currency !== null &&
        providerPayment.currency !== '' &&
        !currenciesMatch(providerPayment.currency, link.order.currency)
      ) {
        out.push(
          discrepancy({
            type: ReconciliationType.WRONG_CURRENCY,
            severity: 'CRITICAL',
            reason: 'currency-differs',
            orderId: link.order.id,
            paymentId: link.payment.id,
            providerPaymentId: providerId,
            expected: { currency: normalizeCurrency(link.order.currency) },
            actual: {
              providerCurrency: normalizeCurrency(providerPayment.currency),
              paymentRowCurrency: normalizeCurrency(link.payment.currency),
            },
            discrepancy:
              `Currency mismatch on ${providerId}: provider settled ${normalizeCurrency(providerPayment.currency)} ` +
              `but order ${link.order.reference} is denominated in ${normalizeCurrency(link.order.currency)}.`,
          }),
        );
      }

      // --- REVERSED_PAYMENT ------------------------------------------------
      if (isProviderReversed(outcome)) {
        if (link.order.status === OrderStatus.COMPLETED) {
          out.push(
            discrepancy({
              type: ReconciliationType.REVERSED_PAYMENT,
              severity: 'CRITICAL',
              reason: 'order-completed-after-reversal',
              orderId: link.order.id,
              paymentId: link.payment.id,
              providerPaymentId: providerId,
              expected: {
                orderStatus: OrderStatus.REFUND_PENDING,
                paymentStatus: PaymentStatus.REFUNDED,
              },
              actual: {
                orderStatus: link.order.status,
                paymentStatus: link.payment.status,
                providerOutcome: outcome,
                refundedAmountMinor: providerPayment.refundedAmountMinor ?? null,
                currency: normalizeCurrency(providerPayment.currency),
              },
              discrepancy:
                `Provider payment ${providerId} was ${outcome.toLowerCase()} but order ` +
                `${link.order.reference} is still COMPLETED — a delivered code against reversed money.`,
            }),
          );
        } else if (!SETTLED_PAYMENT_STATUSES.has(link.payment.status)) {
          out.push(
            discrepancy({
              type: ReconciliationType.REVERSED_PAYMENT,
              severity: 'CRITICAL',
              reason: 'internal-payment-not-reversed',
              orderId: link.order.id,
              paymentId: link.payment.id,
              providerPaymentId: providerId,
              expected: { paymentStatus: PaymentStatus.REFUNDED, orderStatus: 'refund/reversal aware' },
              actual: {
                paymentStatus: link.payment.status,
                orderStatus: link.order.status,
                providerOutcome: outcome,
                refundedAmountMinor: providerPayment.refundedAmountMinor ?? null,
              },
              discrepancy:
                `Provider payment ${providerId} was ${outcome.toLowerCase()} but Payment ` +
                `${link.payment.id} is still ${link.payment.status}.`,
            }),
          );
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// DUPLICATE_PAYMENT
// ---------------------------------------------------------------------------

/**
 * Two distinct failure modes, both "the customer was charged more than once"
 * or "one charge is attached to two sales":
 *
 *  1. the same provider payment id bound to more than one order;
 *  2. one order carrying more than one settled payment (a genuine double
 *     charge, e.g. a retried checkout the webhook processed twice).
 *
 * (1) is currently impossible while `Payment.providerPaymentId` carries a
 * `@unique` index — it is kept as a defence-in-depth assertion so that relaxing
 * that index for a legitimate multi-settlement case cannot silently reintroduce
 * a cross-linked charge.
 */
export function findDuplicatePayments(payments: readonly PaymentSnapshot[]): Discrepancy[] {
  const out: Discrepancy[] = [];

  const byProviderId = new Map<string, PaymentSnapshot[]>();
  const settledByOrder = new Map<string, PaymentSnapshot[]>();

  for (const payment of payments) {
    if (payment.providerPaymentId !== null && payment.providerPaymentId !== '') {
      const bucket = byProviderId.get(payment.providerPaymentId);
      if (bucket) bucket.push(payment);
      else byProviderId.set(payment.providerPaymentId, [payment]);
    }
    if (SETTLED_PAYMENT_STATUSES.has(payment.status)) {
      const bucket = settledByOrder.get(payment.orderId);
      if (bucket) bucket.push(payment);
      else settledByOrder.set(payment.orderId, [payment]);
    }
  }

  for (const [providerPaymentId, group] of byProviderId) {
    const orderIds = [...new Set(group.map((p) => p.orderId))];
    if (orderIds.length <= 1) continue;
    out.push(
      discrepancy({
        type: ReconciliationType.DUPLICATE_PAYMENT,
        severity: 'CRITICAL',
        reason: 'provider-payment-bound-to-multiple-orders',
        orderId: orderIds[0] ?? null,
        paymentId: group[0]?.id ?? null,
        providerPaymentId,
        expected: { distinctOrderIds: 1 },
        actual: {
          distinctOrderIds: orderIds.length,
          orderIds,
          paymentIds: group.map((p) => p.id),
        },
        discrepancy:
          `Provider payment ${providerPaymentId} is bound to ${orderIds.length} different orders ` +
          `(${orderIds.join(', ')}). One charge cannot settle two sales.`,
      }),
    );
  }

  for (const [orderId, group] of settledByOrder) {
    if (group.length <= 1) continue;
    // A partial refund is a second settlement record for the SAME charge; the
    // double-charge signal is more than one DISTINCT provider payment id.
    const distinctProviderPayments = [...new Set(group.map((p) => p.providerPaymentId ?? p.id))];
    if (distinctProviderPayments.length <= 1) continue;
    const totalMinor = group.reduce((sum, p) => sum + p.amountMinor, 0);
    out.push(
      discrepancy({
        type: ReconciliationType.DUPLICATE_PAYMENT,
        severity: 'CRITICAL',
        reason: 'order-has-multiple-settled-payments',
        orderId,
        paymentId: group[0]?.id ?? null,
        expected: { settledPayments: 1 },
        actual: {
          settledPayments: distinctProviderPayments.length,
          providerPaymentIds: distinctProviderPayments,
          totalChargedMinor: totalMinor,
          currencies: [...new Set(group.map((p) => normalizeCurrency(p.currency)))],
          paymentIds: group.map((p) => p.id),
        },
        discrepancy:
          `Order ${orderId} has ${distinctProviderPayments.length} settled payments ` +
          `(${group.map((p) => formatMoney(p.amountMinor, p.currency)).join(' + ')}). Possible double charge.`,
      }),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// STUCK_ORDER
// ---------------------------------------------------------------------------

export interface StuckOrderOptions {
  now: Date;
  /** Minutes without progress before PAYMENT_VERIFIED / FULFILLMENT_PENDING / CODE_RESERVED is stuck. */
  thresholdMinutes: number;
  /**
   * Off by default. An order sitting in PAYMENT_PENDING is usually just a
   * customer who abandoned checkout, so flagging it as stuck produces noise.
   */
  includeStalePending?: boolean;
  pendingThresholdMinutes?: number;
}

export function findStuckOrders(
  orders: readonly OrderSnapshot[],
  options: StuckOrderOptions,
): Discrepancy[] {
  const { now, thresholdMinutes } = options;
  const pendingThreshold = options.pendingThresholdMinutes ?? thresholdMinutes * 6;
  const out: Discrepancy[] = [];

  for (const order of orders) {
    let idleMs: number | null = null;
    let threshold = thresholdMinutes;

    if (STUCK_ORDER_STATUSES.includes(order.status)) {
      idleMs = now.getTime() - order.updatedAt.getTime();
    } else if (options.includeStalePending === true && order.status === OrderStatus.PAYMENT_PENDING) {
      idleMs = now.getTime() - order.createdAt.getTime();
      threshold = pendingThreshold;
    }

    if (idleMs === null || idleMs <= threshold * 60_000) continue;

    const idleMinutes = Math.floor(idleMs / 60_000);
    out.push(
      discrepancy({
        type: ReconciliationType.STUCK_ORDER,
        severity: 'WARN',
        reason: 'no-progress-beyond-threshold',
        orderId: order.id,
        expected: {
          maxIdleMinutes: threshold,
          progressedBeyond: order.status,
          nextStatus: expectedNextStatus(order.status),
        },
        actual: {
          orderStatus: order.status,
          orderReference: order.reference,
          idleMinutes,
          idleSince: order.updatedAt,
          paidAt: order.paidAt,
        },
        discrepancy:
          `Order ${order.reference} has been ${order.status} for ${idleMinutes} minutes ` +
          `(threshold ${threshold}); the customer is waiting.`,
      }),
    );
  }

  return out;
}

function expectedNextStatus(status: OrderStatus): OrderStatus | null {
  switch (status) {
    case OrderStatus.PAYMENT_VERIFIED:
      return OrderStatus.FULFILLMENT_PENDING;
    case OrderStatus.FULFILLMENT_PENDING:
      return OrderStatus.CODE_RESERVED;
    case OrderStatus.CODE_RESERVED:
      return OrderStatus.CODE_DELIVERED;
    case OrderStatus.PAYMENT_PENDING:
      return OrderStatus.PAYMENT_VERIFIED;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// FULFILLMENT_MISMATCH
// ---------------------------------------------------------------------------

export interface FulfillmentMismatchInput {
  orders: readonly OrderSnapshot[];
  deliveries: readonly DeliverySnapshot[];
  codeCounts: readonly OrderCodeCount[];
}

/**
 * "Paid but not delivered" and "delivered but nothing to deliver".
 *
 * The second one matters: a Delivery row with zero assigned InventoryCode rows
 * means the customer received an email containing a code we have no record of
 * selling — either the allocation was rolled back after the send, or the send
 * went out with an empty payload.
 */
export function findFulfillmentMismatches(input: FulfillmentMismatchInput): Discrepancy[] {
  const out: Discrepancy[] = [];
  const deliveriesByOrder = new Map<string, DeliverySnapshot[]>();
  for (const delivery of input.deliveries) {
    const bucket = deliveriesByOrder.get(delivery.orderId);
    if (bucket) bucket.push(delivery);
    else deliveriesByOrder.set(delivery.orderId, [delivery]);
  }
  const countsByOrder = new Map<string, OrderCodeCount>();
  for (const count of input.codeCounts) countsByOrder.set(count.orderId, count);

  for (const order of input.orders) {
    const deliveries = deliveriesByOrder.get(order.id) ?? [];
    const counts = countsByOrder.get(order.id);
    const totalCodes = counts?.total ?? 0;

    if (order.status === OrderStatus.COMPLETED && deliveries.length === 0) {
      out.push(
        discrepancy({
          type: ReconciliationType.FULFILLMENT_MISMATCH,
          severity: 'CRITICAL',
          reason: 'completed-without-delivery',
          orderId: order.id,
          expected: { deliveryCount: { gte: 1 }, orderStatus: OrderStatus.COMPLETED },
          actual: {
            orderStatus: order.status,
            orderReference: order.reference,
            deliveryCount: 0,
            assignedCodes: totalCodes,
            completedAt: order.updatedAt,
          },
          discrepancy:
            `Order ${order.reference} is COMPLETED but has no Delivery row. The customer paid and ` +
            'was never sent anything.',
        }),
      );
    }

    if (order.status === OrderStatus.CODE_DELIVERED && deliveries.length === 0) {
      out.push(
        discrepancy({
          type: ReconciliationType.FULFILLMENT_MISMATCH,
          severity: 'WARN',
          reason: 'delivered-without-delivery-record',
          orderId: order.id,
          expected: { deliveryCount: { gte: 1 }, orderStatus: OrderStatus.CODE_DELIVERED },
          actual: { orderStatus: order.status, orderReference: order.reference, deliveryCount: 0 },
          discrepancy:
            `Order ${order.reference} is CODE_DELIVERED but no Delivery row was ever written.`,
        }),
      );
    }

    if (deliveries.length > 0 && totalCodes === 0) {
      out.push(
        discrepancy({
          type: ReconciliationType.FULFILLMENT_MISMATCH,
          severity: 'CRITICAL',
          reason: 'delivery-without-assigned-code',
          orderId: order.id,
          expected: { assignedCodes: { gte: 1, equals: order.quantity } },
          actual: {
            deliveryCount: deliveries.length,
            deliveryStatuses: deliveries.map((d) => d.status),
            assignedCodes: 0,
            orderStatus: order.status,
            orderReference: order.reference,
          },
          discrepancy:
            `Order ${order.reference} has ${deliveries.length} Delivery row(s) but zero assigned redeem ` +
            'codes. A code was sent that we have no record of allocating.',
        }),
      );
    }

    const expectsCode =
      order.status === OrderStatus.CODE_RESERVED ||
      order.status === OrderStatus.CODE_DELIVERED ||
      order.status === OrderStatus.COMPLETED;
    if (expectsCode && totalCodes === 0) {
      out.push(
        discrepancy({
          type: ReconciliationType.FULFILLMENT_MISMATCH,
          severity: 'CRITICAL',
          reason: 'order-without-assigned-code',
          orderId: order.id,
          expected: { assignedCodes: { gte: order.quantity }, orderStatus: order.status },
          actual: {
            orderStatus: order.status,
            orderReference: order.reference,
            assignedCodes: 0,
            quantity: order.quantity,
          },
          discrepancy:
            `Order ${order.reference} is ${order.status} with no redeem code assigned to it.`,
        }),
      );
    }

    if (deliveries.length > 0 && order.quantity > 0 && totalCodes > 0 && totalCodes < order.quantity) {
      out.push(
        discrepancy({
          type: ReconciliationType.FULFILLMENT_MISMATCH,
          severity: 'WARN',
          reason: 'fewer-codes-than-quantity',
          orderId: order.id,
          expected: { assignedCodes: order.quantity },
          actual: {
            assignedCodes: totalCodes,
            deliveredCodes: counts?.delivered ?? 0,
            quantity: order.quantity,
            orderStatus: order.status,
            orderReference: order.reference,
          },
          discrepancy:
            `Order ${order.reference} ordered ${order.quantity} code(s) but only ${totalCodes} are assigned.`,
        }),
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// INVENTORY_DEPLETED
// ---------------------------------------------------------------------------

/**
 * Two separate stock faults:
 *
 *  1. an ACTIVE product with nothing left — the storefront still sells a SKU
 *     that cannot be fulfilled;
 *  2. denormalised-count drift — `Product.inventoryCount` says we have stock
 *     while the InventoryCode rows say otherwise (or vice versa), which means
 *     the allocation path and the storefront disagree.
 */
export function findDepletedInventory(products: readonly ProductInventorySnapshot[]): Discrepancy[] {
  const out: Discrepancy[] = [];

  for (const product of products) {
    if (product.status !== ProductStatus.ACTIVE) continue;

    if (product.inventoryCount <= 0) {
      out.push(
        discrepancy({
          type: ReconciliationType.INVENTORY_DEPLETED,
          severity: 'WARN',
          reason: 'active-product-has-no-inventory',
          productId: product.id,
          expected: { inventoryCount: { gte: 1 }, productStatus: ProductStatus.ACTIVE },
          actual: {
            inventoryCount: product.inventoryCount,
            availableCodes: product.availableCount,
            slug: product.slug,
            productName: product.productName,
          },
          discrepancy:
            `Product ${product.slug} (${product.productName}) is ACTIVE with zero inventory. ` +
            'Customers can check out and be turned away at fulfillment.',
        }),
      );
      continue;
    }

    if (product.availableCount === 0) {
      out.push(
        discrepancy({
          type: ReconciliationType.INVENTORY_DEPLETED,
          severity: 'CRITICAL',
          reason: 'denormalised-count-drift',
          productId: product.id,
          expected: { availableCodes: { gte: 1 }, source: 'Product.inventoryCount' },
          actual: {
            inventoryCount: product.inventoryCount,
            availableCodes: product.availableCount,
            slug: product.slug,
            productName: product.productName,
          },
          discrepancy:
            `Product ${product.slug} claims ${product.inventoryCount} in stock but zero InventoryCode rows ` +
            `are ${InventoryStatus.AVAILABLE}. The storefront will oversell this SKU.`,
        }),
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Provider refunds vs the local ledger
// ---------------------------------------------------------------------------

export interface RefundComparisonInput {
  refunds: readonly RefundRecord[];
  /** Internal Refund rows, keyed by payment id. */
  refundsByPaymentId: ReadonlyMap<string, RefundSnapshot>;
  /** Internal Payment rows, keyed by provider payment id. */
  paymentsByProviderId: ReadonlyMap<string, PaymentSnapshot>;
  ordersById: ReadonlyMap<string, OrderSnapshot>;
}

/**
 * A refund that succeeded at the provider but has no local Refund row means our
 * books still show the order as earned revenue. That is a REVERSED_PAYMENT —
 * money came back and we did not write it down.
 */
export function findUnrecordedRefunds(input: RefundComparisonInput): Discrepancy[] {
  const out: Discrepancy[] = [];

  for (const refund of input.refunds) {
    if (refund.status !== 'SUCCEEDED') continue;

    const payment = input.paymentsByProviderId.get(refund.providerPaymentId);
    const local = payment ? input.refundsByPaymentId.get(payment.id) : undefined;
    const order = payment ? input.ordersById.get(payment.orderId) : undefined;

    if (payment === undefined) {
      out.push(
        discrepancy({
          type: ReconciliationType.REVERSED_PAYMENT,
          severity: 'CRITICAL',
          reason: 'provider-refund-for-unknown-payment',
          providerPaymentId: refund.providerPaymentId,
          expected: { internalPayment: 'exists' },
          actual: {
            providerRefundId: refund.providerRefundId,
            amountMinor: refund.amountMinor,
            currency: refund.currency,
            reason: refund.reason ?? null,
          },
          discrepancy:
            `Provider refund ${refund.providerRefundId ?? '(no id)'} succeeded against unknown payment ` +
            `${refund.providerPaymentId} (${formatMoney(refund.amountMinor, refund.currency)}).`,
        }),
      );
      continue;
    }

    if (local === undefined) {
      out.push(
        discrepancy({
          type: ReconciliationType.REVERSED_PAYMENT,
          severity: 'CRITICAL',
          reason: 'provider-refund-not-recorded',
          orderId: payment.orderId,
          paymentId: payment.id,
          providerPaymentId: refund.providerPaymentId,
          expected: { refundRow: 'exists', status: 'terminal' },
          actual: {
            providerRefundId: refund.providerRefundId,
            amountMinor: refund.amountMinor,
            currency: normalizeCurrency(refund.currency),
            orderStatus: order?.status ?? null,
            paymentStatus: payment.status,
            reason: refund.reason ?? null,
          },
          discrepancy:
            `Provider refund ${refund.providerRefundId ?? '(no id)'} of ` +
            `${formatMoney(refund.amountMinor, refund.currency)} on payment ${refund.providerPaymentId} ` +
            'succeeded but no local Refund row exists — the books still show this as revenue.',
        }),
      );
      continue;
    }

    if (local.status !== 'SUCCEEDED') {
      out.push(
        discrepancy({
          type: ReconciliationType.REVERSED_PAYMENT,
          severity: 'WARN',
          reason: 'local-refund-not-finalised',
          orderId: payment.orderId,
          paymentId: payment.id,
          providerPaymentId: refund.providerPaymentId,
          expected: { refundStatus: 'SUCCEEDED', orderStatus: 'refund aware' },
          actual: {
            localRefundId: local.id,
            localRefundStatus: local.status,
            providerRefundId: refund.providerRefundId,
            amountMinor: refund.amountMinor,
            orderStatus: order?.status ?? null,
          },
          discrepancy:
            `Provider refund ${refund.providerRefundId ?? '(no id)'} succeeded but local Refund ` +
            `${local.id} is still ${local.status}.`,
        }),
      );
      continue;
    }

    if (local.amountMinor !== refund.amountMinor || !currenciesMatch(local.currency, refund.currency)) {
      out.push(
        discrepancy({
          type: ReconciliationType.REVERSED_PAYMENT,
          severity: 'WARN',
          reason: 'refund-amount-drift',
          orderId: payment.orderId,
          paymentId: payment.id,
          providerPaymentId: refund.providerPaymentId,
          expected: { amountMinor: refund.amountMinor, currency: normalizeCurrency(refund.currency) },
          actual: {
            localAmountMinor: local.amountMinor,
            localCurrency: normalizeCurrency(local.currency),
            deltaMinor: refund.amountMinor - local.amountMinor,
          },
          discrepancy:
            `Refund ${refund.providerRefundId ?? '(no id)'} amount drift: provider refunded ` +
            `${formatMoney(refund.amountMinor, refund.currency)} but we recorded ` +
            `${formatMoney(local.amountMinor, local.currency)}.`,
        }),
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export function countByType(discrepancies: readonly Discrepancy[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of discrepancies) {
    const key = item.type;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function countBySeverity(discrepancies: readonly Discrepancy[]): Record<string, number> {
  const counts: Record<string, number> = { INFO: 0, WARN: 0, CRITICAL: 0 };
  for (const item of discrepancies) {
    counts[item.severity] = (counts[item.severity] ?? 0) + 1;
  }
  return counts;
}

/** Total minor units charged across a set of payment rows. Integer math only. */
export function totalChargedMinor(payments: readonly PaymentSnapshot[]): number {
  return payments.reduce((sum, payment) => sum + payment.amountMinor, 0);
}

/** True when at least one discrepancy is severe enough to page a human. */
export function hasCritical(discrepancies: readonly Discrepancy[]): boolean {
  return discrepancies.some((item) => item.severity === 'CRITICAL');
}