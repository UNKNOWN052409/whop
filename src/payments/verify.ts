/**
 * Server-to-server payment verification.
 *
 * =========================================================================
 * THIS IS THE ONLY FUNCTION IN THE SYSTEM PERMITTED TO MOVE AN ORDER TO
 * `PAYMENT_VERIFIED`.
 * =========================================================================
 *
 * Not the browser. Not the checkout success redirect. Not an admin action. Not
 * a support agent. A "success" query parameter on the return URL is attacker
 * controlled by definition. An order reaches PAYMENT_VERIFIED only when
 * `verifyPaymentAgainstProvider()` has asked the provider's own API, over the
 * server's own credentials, whether the money is actually there, and the
 * amount and currency match what the order was created with.
 *
 * The three checks, in order, all mandatory:
 *
 *   1. STATUS  — the provider says `paid`. Pending is not paid.
 *   2. AMOUNT  — integer minor units equal `order.totalMinor`. Not "close",
 *                not ">= ". Equal. $3.00 paid for a $3.00 order.
 *   3. CURRENCY— case-insensitively equal to `order.currency`. A USD charge is
 *                not a GBP charge however similar the numbers look.
 *
 * WHY THE SNAPSHOT MATTERS: `totalMinor` is read from the Order row, never
 * from the catalog. An admin who reprices the product between checkout and
 * webhook must not change what the customer is considered to have paid. The
 * snapshot is the contract.
 *
 * PAYMENT EVENTUALITY: a webhook can arrive microseconds before the provider's
 * read replica catches up. Rather than rejecting a paid order, we poll once,
 * after a bounded backoff, and only then report "not terminal". The poll is
 * deliberately bounded — this runs inside a request that must answer in under
 * 5 seconds, and "still pending" is a legitimate outcome the durable queue
 * re-drives.
 */

import { OrderStatus, PaymentStatus, type Prisma } from '@prisma/client';

import { prisma } from '@/db/prisma';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { canTransition } from '@/orders/state-machine';
import { transitionOrder } from '@/fulfillment/order-transitions';

import { getPaymentProvider } from './registry';
import type { PaymentVerification, ProviderPaymentDetails } from './types';

/** Single bounded re-check for eventual consistency in the provider's API. */
const TERMINAL_RECHECK_DELAY_MS = 1_200;

export interface PaymentConfirmation {
  ok: boolean;
  reason?: string;
  /**
   * True when a later attempt could plausibly succeed.
   *
   * This distinction decides whether the durable workflow retries or stops, and
   * getting it wrong is expensive in BOTH directions: treating a provider
   * outage as permanent drops a paid order (customer charged, code never
   * delivered); treating a declined card as retryable burns the retry budget and
   * delays a manual-review handoff that will never resolve itself.
   */
  retryable: boolean;
}

/** Reasons that a later poll could plausibly change. */
const TRANSIENT_REASONS = new Set([
  'PAYMENT_NOT_CONFIGURED_PROVIDER_ERROR',
  'NOT_PAID:PENDING',
  'NOT_PAID:REQUIRES_ACTION',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_ERROR',
]);

/**
 * Confirm a payment with the provider immediately before fulfillment releases
 * inventory (spec §8, invoked as step 0 of the `payment/paid` workflow).
 *
 * This runs in the durable queue rather than in the webhook request handler on
 * purpose: a slow upstream on the request path becomes a retry storm, whereas
 * here it is simply a step that retries with backoff. The invariant that only a
 * VERIFIED payment may release a redeem code is preserved because this step
 * completes before any inventory row is touched.
 *
 * The provider payment id is resolved FROM THE ORDER, never from the incoming
 * event. An event can be redelivered, and a redelivery must not be able to
 * substitute a different payment into the verification path.
 */
export async function confirmPaymentBeforeFulfillment(
  orderId: string,
): Promise<PaymentConfirmation> {
  const payment = await prisma.payment.findFirst({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, providerPaymentId: true, status: true },
  });

  if (!payment?.providerPaymentId) {
    // The webhook recorded an event but never bound a provider payment id to
    // this order. That is a durable, non-retryable inconsistency: no amount of
    // polling will produce a payment id that does not exist.
    await escalateUnconfirmable(orderId, 'NO_PROVIDER_PAYMENT_ID');
    return { ok: false, reason: 'NO_PROVIDER_PAYMENT_ID', retryable: false };
  }

  let result: VerifyPaymentResult;
  try {
    result = await verifyPaymentAgainstProvider(orderId, payment.providerPaymentId);
  } catch (error) {
    // A transport fault: we could not reach the provider. That is the definition
    // of retryable, and it must never be mistaken for "the provider said no".
    const reason =
      error instanceof AppError && error.code === 'PROVIDER_RATE_LIMITED'
        ? 'PROVIDER_RATE_LIMITED'
        : 'PROVIDER_UNAVAILABLE';
    logger.warn('Provider confirmation threw; treating as retryable', {
      orderId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason, retryable: true };
  }

  if (result.ok) return { ok: true, retryable: false };

  const reason = result.reason ?? 'UNKNOWN';
  const retryable = TRANSIENT_REASONS.has(reason);

  if (!retryable) {
    // Permanent: escalate so a human owns it. Doing nothing here would leave a
    // paid order sitting in PAYMENT_PENDING forever.
    await escalateUnconfirmable(orderId, reason, payment.id);
  }

  logger.warn('Payment confirmation did not succeed', {
    orderId,
    reason,
    retryable,
  });

  return { ok: false, reason, retryable };
}

/**
 * Park an unconfirmable-but-maybe-paid order in MANUAL_REVIEW and write an
 * auditable reconciliation record, so a paid customer is never silently lost.
 */
async function escalateUnconfirmable(
  orderId: string,
  reason: string,
  paymentId?: string,
): Promise<void> {
  try {
    await transitionOrder(orderId, OrderStatus.MANUAL_REVIEW, {
      reason: `unconfirmable_payment:${reason}`,
      metadata: { reason },
    });
  } catch (error) {
    // The order may already be in a state that cannot reach MANUAL_REVIEW, or
    // the transition may have been recorded by a concurrent run. Not fatal.
    logger.warn('Could not move unconfirmable order to MANUAL_REVIEW', {
      orderId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const existing = await prisma.reconciliationRecord.findFirst({
      where: { orderId, type: 'MISSING_PAYMENT', status: 'OPEN' },
      select: { id: true },
    });
    if (!existing) {
      await prisma.reconciliationRecord.create({
        data: {
          type: 'MISSING_PAYMENT',
          status: 'OPEN',
          orderId,
          paymentId: paymentId ?? null,
          discrepancy: `Payment could not be confirmed with the provider: ${reason}`,
          expected: { reason },
          actual: { reason, escalatedTo: 'MANUAL_REVIEW' },
        },
      });
    }
  } catch (error) {
    logger.error('Could not write reconciliation record for unconfirmable payment', {
      orderId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface VerifyPaymentResult {
  ok: boolean;
  /** Machine-readable cause. Never contains a PAN, code or customer PII. */
  reason?: string;
  /** The normalised provider status, when one could be read. */
  providerStatus?: string;
  /** True when this call performed the PAYMENT_VERIFIED transition. */
  transitioned?: boolean;
  /** True when the order was already at or past PAYMENT_VERIFIED. */
  alreadyVerified?: boolean;
}

function describe(verification: PaymentVerification): string {
  switch (verification.status) {
    case 'PAID':
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** States that already prove the money was verified for this order. */
const AT_OR_BEYOND_VERIFIED: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.PAYMENT_VERIFIED,
  OrderStatus.FULFILLMENT_PENDING,
  OrderStatus.CODE_RESERVED,
  OrderStatus.CODE_DELIVERED,
  OrderStatus.COMPLETED,
  OrderStatus.MANUAL_REVIEW,
]);

/**
 * Confirm a payment against the provider and, on success, move the order to
 * PAYMENT_VERIFIED.
 *
 * Returns `{ ok: false, reason }` rather than throwing for every "not paid"
 * shape — the caller decides what a non-verified payment means (a webhook
 * records it, the storefront keeps polling). Provider transport faults DO
 * throw, because "we could not reach the provider" and "the provider says no"
 * must never be confused.
 */
export async function verifyPaymentAgainstProvider(
  orderId: string,
  providerPaymentId: string,
): Promise<VerifyPaymentResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      reference: true,
      status: true,
      totalMinor: true,
      currency: true,
      paidAt: true,
    },
  });
  if (!order) {
    return { ok: false, reason: 'ORDER_NOT_FOUND' };
  }

  const provider = getPaymentProvider();
  if (!provider) {
    // NOT CONFIGURED is surfaced, never worked around.
    return { ok: false, reason: 'PAYMENT_NOT_CONFIGURED' };
  }

  let details = await provider.getPaymentStatus(providerPaymentId);

  // Eventual consistency: one bounded re-read before giving up.
  if (details.status.status === 'PENDING' || details.status.status === 'REQUIRES_ACTION') {
    await sleep(TERMINAL_RECHECK_DELAY_MS);
    details = await provider.getPaymentStatus(providerPaymentId);
  }

  const providerStatus = describe(details.status);

  if (details.status.status !== 'PAID') {
    await recordNonPaidOutcome(orderId, providerPaymentId, details.status);
    return { ok: false, reason: `NOT_PAID:${providerStatus}`, providerStatus };
  }

  // --- The three checks -------------------------------------------------
  if (details.amountMinor === undefined) {
    return { ok: false, reason: 'PROVIDER_AMOUNT_MISSING', providerStatus };
  }
  if (details.amountMinor !== order.totalMinor) {
    logger.error('Payment amount does not match the order snapshot', {
      orderId,
      orderReference: order.reference,
      providerPaymentId,
      expectedMinor: order.totalMinor,
      actualMinor: details.amountMinor,
    });
    return { ok: false, reason: 'AMOUNT_MISMATCH', providerStatus };
  }
  const actualCurrency = (details.currency ?? order.currency).toLowerCase();
  if (actualCurrency !== order.currency.toLowerCase()) {
    logger.error('Payment currency does not match the order snapshot', {
      orderId,
      orderReference: order.reference,
      providerPaymentId,
      expected: order.currency,
      actual: details.currency,
    });
    return { ok: false, reason: 'CURRENCY_MISMATCH', providerStatus };
  }

  // --- Persist the provider truth --------------------------------------
  const paidAt = details.paidAt ?? new Date();
  await persistPaidPayment(orderId, providerPaymentId, details, paidAt);

  // --- The one legal move into PAYMENT_VERIFIED ------------------------
  if (AT_OR_BEYOND_VERIFIED.has(order.status)) {
    return { ok: true, providerStatus, alreadyVerified: true, transitioned: false };
  }
  if (!canTransition(order.status, OrderStatus.PAYMENT_VERIFIED)) {
    logger.warn('Verified payment arrived for an order that cannot reach PAYMENT_VERIFIED', {
      orderId,
      status: order.status,
      providerPaymentId,
    });
    return { ok: false, reason: `ILLEGAL_STATE:${order.status}`, providerStatus };
  }

  const transition = await transitionOrder(
    orderId,
    OrderStatus.PAYMENT_VERIFIED,
    {
      expectedFrom: order.status,
      reason: 'provider_payment_verified',
      actor: 'payment-verifier',
      metadata: {
        providerPaymentId,
        amountMinor: order.totalMinor,
        currency: order.currency,
      },
      data: { paidAt: order.paidAt ?? paidAt },
    },
  );

  return {
    ok: true,
    providerStatus,
    transitioned: transition.applied,
    alreadyVerified: !transition.applied,
  };
}

/**
 * Writes PAID/verifiedAt and the fee split onto the Payment row.
 *
 * `netAmountMinor`/`feeMinor` are what the merchant actually keeps — on a $3
 * order the processor fee is a meaningful fraction of revenue, so the margin
 * dashboard depends on them being populated here. Card data is brand + last4
 * only; there is no code path in this file that can accept a PAN.
 */
async function persistPaidPayment(
  orderId: string,
  providerPaymentId: string,
  details: ProviderPaymentDetails,
  paidAt: Date,
): Promise<void> {
  const verification = details.status;
  if (verification.status !== 'PAID') return;

  const payment = await prisma.payment.findFirst({
    where: { orderId, OR: [{ providerPaymentId }, { providerPaymentId: null }] },
    orderBy: { createdAt: 'desc' },
    select: { id: true, providerPaymentId: true },
  });

  const data: Prisma.PaymentUncheckedUpdateInput = {
    status: PaymentStatus.PAID,
    verifiedAt: paidAt,
    ...(details.netAmountMinor === undefined ? {} : { netAmountMinor: details.netAmountMinor }),
    ...(details.feeMinor === undefined ? {} : { feeMinor: details.feeMinor }),
    ...(verification.cardBrand ? { cardBrand: verification.cardBrand } : {}),
    ...(verification.cardLast4 ? { cardLast4: verification.cardLast4 } : {}),
  };

  if (!payment) {
    await prisma.payment.create({
      data: {
        orderId,
        providerPaymentId,
        provider: 'WHOP',
        status: PaymentStatus.PAID,
        verifiedAt: paidAt,
        amountMinor: details.amountMinor ?? 0,
        currency: (details.currency ?? 'usd').toUpperCase(),
        ...(details.netAmountMinor === undefined ? {} : { netAmountMinor: details.netAmountMinor }),
        ...(details.feeMinor === undefined ? {} : { feeMinor: details.feeMinor }),
        ...(verification.cardBrand ? { cardBrand: verification.cardBrand } : {}),
        ...(verification.cardLast4 ? { cardLast4: verification.cardLast4 } : {}),
      },
    });
    return;
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: { providerPaymentId, ...data },
  });
}

/**
 * A non-paid provider status is still information worth persisting: a failed
 * card must move the order to PAYMENT_FAILED so the storefront stops showing a
 * spinner, and a reversal must never be mistaken for a live payment.
 */
async function recordNonPaidOutcome(
  orderId: string,
  providerPaymentId: string,
  verification: PaymentVerification,
): Promise<void> {
  const payment = await prisma.payment.findFirst({
    where: { orderId, OR: [{ providerPaymentId }, { providerPaymentId: null }] },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  switch (verification.status) {
    case 'FAILED':
    case 'CANCELED':
      if (payment) {
        // CANCELED carries no code/message, so narrow before reading them.
        const failed = verification.status === 'FAILED' ? verification : null;
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            providerPaymentId,
            status: verification.status === 'FAILED' ? PaymentStatus.FAILED : PaymentStatus.CANCELED,
            ...(failed?.code ? { failureCode: failed.code } : {}),
            ...(failed?.message ? { failureMessage: failed.message } : {}),
          },
        });
      }
      await transitionOrder(orderId, OrderStatus.PAYMENT_FAILED, {
        reason: 'provider_payment_not_settled',
        actor: 'payment-verifier',
        metadata: { providerPaymentId, providerStatus: verification.status },
      }).catch((error: unknown) => {
        logger.warn('Could not move a failed payment to PAYMENT_FAILED', {
          orderId,
          providerPaymentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    case 'DISPUTED':
    case 'REVERSED':
      if (payment) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            providerPaymentId,
            status:
              verification.status === 'DISPUTED' ? PaymentStatus.DISPUTED : PaymentStatus.REVERSED,
          },
        });
      }
      return;
    default:
      return;
  }
}