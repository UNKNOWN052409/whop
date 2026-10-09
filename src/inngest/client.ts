/**
 * Inngest client (spec §16, §21).
 *
 * Vercel has no long-lived workers, so "retry in 30 seconds" cannot be a
 * setTimeout inside a request handler — the lambda is gone before it fires.
 * Inngest is the durable execution layer: it persists each step, replays it
 * after a crash, and re-runs only what did not finish.
 *
 * Two hard rules this file encodes:
 *
 *  1. NO FAKED INTEGRATION. When INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY are
 *     unset the client is still constructed (so `serve()` keeps working and the
 *     local `inngest dev` server can introspect the functions), but every
 *     *send* throws. Callers that must not silently drop work check
 *     `inngestConfig.configured` first — see src/fulfillment/enqueue.ts.
 *
 *  2. TYPED EVENTS. `AppEvents` is the single registry of event names and
 *     payloads. A typo in an event name is a compile error, not a message that
 *     is silently never delivered.
 */

import { EventSchemas, Inngest } from 'inngest';
import { appConfig, inngestConfig } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * Payload for "the provider says this order is paid".
 *
 * Emitted by the webhook handler AFTER signature verification and an
 * authoritative provider check — never by the browser.
 *
 * `amountMinor` is integer minor units (cents). It is informational for the
 * queue; the authoritative amount lives on the Payment row.
 */
export type PaymentPaidEventData = {
  orderId: string;
  orderReference: string;
  paymentId?: string;
  /** Provider event id — the natural de-duplication key. */
  providerEventId?: string;
  amountMinor?: number;
  currency?: string;
  /** ISO timestamp of the provider-side settlement. */
  paidAt?: string;
}

/** Payload for "try this order again", used by the durable retry workflow. */
export type FulfillmentRetryEventData = {
  orderId: string;
  orderReference?: string;
  /** 1-based attempt number that produced the retry request. */
  attempt?: number;
  reason?: string;
}

/**
 * Operational alert for a human. This is what an order that exhausted its
 * attempts emits — it is deliberately NOT modeled as an Order transition,
 * because a failed fulfillment is already visible in the admin UI through
 * FulfillmentStatus.DEAD_LETTER and OrderStatus.FULFILLMENT_FAILED.
 */
export type OpsAlertEventData = {
  severity: 'CRITICAL' | 'WARNING';
  title: string;
  orderId?: string;
  orderReference?: string;
  reason: string;
  detail?: string;
  attempts?: number;
  maxAttempts?: number;
  occurredAt: string;
}

/** On-demand reconciliation trigger (admin button / ops runbook). */
export type ReconciliationRequestedEventData = {
  lookbackHours?: number;
  requestedBy?: string;
}

/**
 * The single registry of event names and payloads.
 *
 * Declared as a `type`, not an `interface`: the installed Inngest SDK constrains
 * `fromRecord<T>()` to `Record<string, NormalizedEventSchema>`, and only object
 * *type* aliases get an implicit index signature. An interface here fails the
 * constraint with "Index signature for type 'string' is missing".
 */
export type AppEvents = {
  'redeem-store/payment.paid': { data: PaymentPaidEventData };
  'redeem-store/fulfillment.retry': { data: FulfillmentRetryEventData };
  'redeem-store/reconciliation.requested': { data: ReconciliationRequestedEventData };
  'redeem-store/ops.alert': { data: OpsAlertEventData };
};

/** Convenience alias: the exact payload type of an event name. */
export type AppEventName = keyof AppEvents;

/**
 * Bridges the Inngest SDK's logger into the project's structured logger so a
 * step trace and an application trace share one format (spec §22). The second
 * Inngest argument is an object of extra fields — we keep it as `inngestCtx`.
 */
const inngestLogger = {
  debug: (...args: unknown[]) => logger.debug('inngest', { inngestArgs: args }),
  info: (...args: unknown[]) => logger.info('inngest', { inngestArgs: args }),
  warn: (...args: unknown[]) => logger.warn('inngest', { inngestArgs: args }),
  error: (...args: unknown[]) => logger.error('inngest', { inngestArgs: args }),
};

export const inngest = new Inngest({
  // Stable across deploys: changing this orphans every existing run.
  id: 'redeem-store',
  schemas: new EventSchemas().fromRecord<AppEvents>(),
  eventKey: inngestConfig.eventKey,
  // In development this points the SDK at the local `inngest dev` server.
  isDev: !appConfig.isProduction,
  // Optional override, e.g. http://127.0.0.1:8288 for the dev server. Undefined
  // means "SDK default", which is correct for Inngest Cloud.
  baseUrl: process.env.INNGEST_BASE_URL,
  logger: inngestLogger,
});

/** True when the durable queue can actually accept work right now. */
export function isDurableQueueReady(): boolean {
  return inngestConfig.configured;
}