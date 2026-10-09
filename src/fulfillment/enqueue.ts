/**
 * Enqueue helpers used by the webhook handler (spec §20, §21).
 *
 * The rule this module exists to enforce: IF THE DURABLE QUEUE IS NOT
 * CONFIGURED, SAY SO. It does not fall back to running fulfillment inline.
 *
 * That fallback looks harmless and is not. An inline fulfillment inside a
 * webhook handler runs inside a function with a hard timeout, so a slow email
 * provider or a contended database turns a paid order into a webhook retry
 * storm, then a duplicate-code incident, then a customer with two codes and a
 * provider with two charges. Failing loudly means the operator configures
 * Inngest; pretending the queue exists means they find out from a customer.
 */

import { AppError } from '@/lib/errors';
import { inngestConfig } from '@/lib/env';
import { logger } from '@/lib/logger';
import { inngest } from '@/inngest/client';

/** Throws a clear, actionable error when the durable queue cannot accept work. */
export function assertDurableQueueConfigured(): void {
  if (inngestConfig.configured) return;
  throw new AppError(
    'Fulfillment cannot be queued: the durable queue (Inngest) is NOT CONFIGURED. ' +
      'Set INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY (see .env.example). ' +
      'Fulfillment is deliberately NOT run inline — a webhook handler has a hard ' +
      'timeout, so an inline run would risk duplicate codes and duplicate charges.',
    503,
    'PROVIDER_UNAVAILABLE',
    {
      details: {
        integration: 'inngest',
        status: inngestConfig.status,
        missing: [
          ...(inngestConfig.eventKey ? [] : ['INNGEST_EVENT_KEY']),
          ...(inngestConfig.signingKey ? [] : ['INNGEST_SIGNING_KEY']),
        ],
      },
      retryAfterSeconds: 60,
    },
  );
}

export interface EnqueueFulfillmentInput {
  orderId: string;
  orderReference: string;
  paymentId?: string;
  providerEventId?: string;
  /** Integer minor units. Informational only — Payment is authoritative. */
  amountMinor?: number;
  currency?: string;
  /** ISO timestamp of provider-side settlement. */
  paidAt?: string;
}

export interface EnqueueResult {
  enqueued: true;
  eventName: string;
  ids: string[];
}

async function sendWithContext<T>(
  eventName: string,
  orderId: string,
  send: () => Promise<{ ids: string[] }>,
): Promise<EnqueueResult> {
  try {
    const result = await send();
    logger.info('Durable event enqueued', {
      orderId,
      eventName,
      runIds: result.ids,
    });
    return { enqueued: true, eventName, ids: result.ids };
  } catch (error) {
    // The event may or may not have been accepted. Say so rather than guessing:
    // the caller (the webhook handler) decides whether to return a 5xx, which
    // makes Whop redeliver and is safe because fulfillment is idempotent.
    throw new AppError(
      `Could not enqueue ${eventName}: ${error instanceof Error ? error.message : String(error)}`,
      502,
      'PROVIDER_UNAVAILABLE',
      {
        cause: error,
        details: { integration: 'inngest', eventName, orderId },
        retryAfterSeconds: 30,
      },
    );
  }
}

/**
 * Queue fulfillment for a verified payment.
 *
 * Call this ONLY after the webhook signature verified and the provider
 * confirmed the charge. The event carries identifiers, never a code or a card
 * field.
 */
export async function enqueueFulfillment(
  input: EnqueueFulfillmentInput,
): Promise<EnqueueResult> {
  assertDurableQueueConfigured();

  return sendWithContext('redeem-store/payment.paid', input.orderId, () =>
    inngest.send({
      name: 'redeem-store/payment.paid',
      data: {
        orderId: input.orderId,
        orderReference: input.orderReference,
        ...(input.paymentId === undefined ? {} : { paymentId: input.paymentId }),
        ...(input.providerEventId === undefined ? {} : { providerEventId: input.providerEventId }),
        ...(input.amountMinor === undefined ? {} : { amountMinor: input.amountMinor }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        ...(input.paidAt === undefined ? {} : { paidAt: input.paidAt }),
      },
    }),
  );
}

export interface EnqueueRetryInput {
  orderId: string;
  orderReference?: string;
  /** 1-based attempt number that produced this retry request. */
  attempt?: number;
  reason?: string;
}

/** Queue a durable retry for an order that failed fulfillment. */
export async function enqueueFulfillmentRetry(input: EnqueueRetryInput): Promise<EnqueueResult> {
  assertDurableQueueConfigured();

  return sendWithContext('redeem-store/fulfillment.retry', input.orderId, () =>
    inngest.send({
      name: 'redeem-store/fulfillment.retry',
      data: {
        orderId: input.orderId,
        ...(input.orderReference === undefined ? {} : { orderReference: input.orderReference }),
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
        ...(input.reason === undefined ? {} : { reason: truncateReason(input.reason) }),
      },
    }),
  );
}

export interface EnqueueReconciliationInput {
  lookbackHours?: number;
  requestedBy?: string;
}

/** Trigger an out-of-band reconciliation run (admin button, ops runbook). */
export async function enqueueReconciliation(
  input: EnqueueReconciliationInput = {},
): Promise<EnqueueResult> {
  assertDurableQueueConfigured();

  return sendWithContext('redeem-store/reconciliation.requested', input.requestedBy ?? 'operator', () =>
    inngest.send({
      name: 'redeem-store/reconciliation.requested',
      data: {
        ...(input.lookbackHours === undefined ? {} : { lookbackHours: input.lookbackHours }),
        ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
      },
    }),
  );
}

function truncateReason(reason: string): string {
  return reason.length > 300 ? `${reason.slice(0, 300)}…` : reason;
}