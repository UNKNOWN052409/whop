/**
 * Whop webhook envelope -> `VerifiedWebhookEvent`.
 *
 * This module is PURE. It performs no IO, no signature verification and no
 * config lookup; `provider.verifyWebhook` composes `./signature` (authenticity)
 * with this file (shape). Keeping that split means the normalisation can be
 * unit-tested against recorded payloads without a live Whop account.
 *
 * FOUR FACTS FROM WHOP_API_REFERENCE.md THAT SHAPE THIS FILE:
 *
 *  1. There is **no `payment.refunded` and no `payment.chargeback`**. Refunds are
 *     `refund.created` / `refund.updated`; chargebacks are `dispute.created` /
 *     `dispute.updated`; the pre-chargeback early warning is
 *     `dispute_alert.created`. A mapping built on `payment.refunded` silently
 *     drops every refund and every chargeback, and a $3 store that never learns
 *     about chargebacks will re-sell inventory that was reversed.
 *  2. The account field is `account_id` on payloads pinned to `2026-08-14+` and
 *     `company_id` on older/unpinned ones. BOTH are read, on the envelope AND on
 *     `data`, because a lookup keyed on one name alone loses orders.
 *  3. Our order reference arrives as `data.metadata.order_ref`. The
 *     `checkout_configuration_id` (`ch_...`) is the fallback correlator; it is
 *     not an order id, so it is only used when `order_ref` is absent.
 *  4. Money arrives as `{ amount: "29.99", currency, decimals }` — a DECIMAL
 *     STRING in major units. It is converted through `./money`, never via
 *     `Number()` on the string.
 *
 * NOTE ON `raw`: the full parsed payload is carried through for auditing and
 * for the recon worker. It never contains card data — Whop's hosted page owns
 * that end to end — but it is still untrusted input and must not be rendered.
 */

import type {
  ProviderPaymentDetails,
  VerifiedWebhookEvent,
} from '@/payments/types';
import { firstMoneyToMinor, whopMoneyToMinor } from './money';
import {
  asCurrency,
  asDate,
  asRecord,
  asString,
  asStringRecord,
  type WhopPageInfo,
  type WhopPayment,
  type WhopRefund,
} from './types';

/** Whop event family predicates. Names are literal strings from the SDK enum. */
export const WHOP_EVENTS = {
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_PENDING: 'payment.pending',
  PAYMENT_AUTHORIZED: 'payment.authorized',
  PAYMENT_CANCELED: 'payment.canceled',
  PAYMENT_REQUIRES_ACTION: 'payment.requires_action',
  REFUND_CREATED: 'refund.created',
  REFUND_UPDATED: 'refund.updated',
  DISPUTE_CREATED: 'dispute.created',
  DISPUTE_UPDATED: 'dispute.updated',
  DISPUTE_ALERT_CREATED: 'dispute_alert.created',
  RESOLUTION_CENTER_CASE_CREATED: 'resolution_center_case.created',
} as const;

export type WhopEventType = (typeof WHOP_EVENTS)[keyof typeof WHOP_EVENTS];

/** `refund.*` — an issued reversal. */
export function isRefundEvent(type: string): boolean {
  return type === WHOP_EVENTS.REFUND_CREATED || type === WHOP_EVENTS.REFUND_UPDATED;
}

/** `dispute.*` and `dispute_alert.*` — a chargeback or the warning before one. */
export function isDisputeEvent(type: string): boolean {
  return (
    type === WHOP_EVENTS.DISPUTE_CREATED ||
    type === WHOP_EVENTS.DISPUTE_UPDATED ||
    type === WHOP_EVENTS.DISPUTE_ALERT_CREATED
  );
}

/** `payment.*` — a payment lifecycle event. */
export function isPaymentEvent(type: string): boolean {
  return type.startsWith('payment.');
}

/**
 * Whop event type -> normalised order outcome.
 *
 * Unmapped types (membership.*, plan.*, payout.*, ...) deliberately resolve to
 * `UNKNOWN` rather than being guessed at. An unknown outcome is a no-op for the
 * order state machine; a WRONG one would move a paid order backwards.
 */
export const WHOP_EVENT_OUTCOMES: Readonly<Record<string, VerifiedWebhookEvent['outcome']>> = {
  [WHOP_EVENTS.PAYMENT_SUCCEEDED]: 'SUCCEEDED',
  [WHOP_EVENTS.PAYMENT_FAILED]: 'FAILED',
  [WHOP_EVENTS.PAYMENT_PENDING]: 'PENDING',
  [WHOP_EVENTS.PAYMENT_REQUIRES_ACTION]: 'PENDING',
  [WHOP_EVENTS.PAYMENT_CANCELED]: 'CANCELED',
  [WHOP_EVENTS.REFUND_CREATED]: 'REFUNDED',
  [WHOP_EVENTS.REFUND_UPDATED]: 'REFUNDED',
  [WHOP_EVENTS.DISPUTE_CREATED]: 'DISPUTED',
  [WHOP_EVENTS.DISPUTE_UPDATED]: 'DISPUTED',
  [WHOP_EVENTS.DISPUTE_ALERT_CREATED]: 'DISPUTED',
  [WHOP_EVENTS.RESOLUTION_CENTER_CASE_CREATED]: 'DISPUTED',
};

/** Events that represent money leaving the merchant rather than arriving. */
export function isReversalEvent(type: string): boolean {
  return isRefundEvent(type) || isDisputeEvent(type);
}

export function whopOutcomeFor(type: string): VerifiedWebhookEvent['outcome'] {
  return WHOP_EVENT_OUTCOMES[type] ?? 'UNKNOWN';
}

export interface NormalizeOptions {
  /**
   * The `webhook-id` header. Used ONLY as a fallback when the envelope omits
   * `id`; the envelope value wins when present.
   */
  fallbackEventId?: string;
}

export type NormalizeResult =
  | { ok: true; event: VerifiedWebhookEvent }
  | { ok: false; reason: 'MALFORMED'; diagnostics: { eventType?: string } };

/**
 * Reads the account id from the envelope first, then from `data`, honouring the
 * `company_id` spelling used by pre-2026-08-14 payloads.
 */
export function readWhopAccountId(
  envelope: Record<string, unknown> | undefined,
  data: Record<string, unknown> | undefined,
): string | undefined {
  return (
    asString(envelope?.account_id) ??
    asString(envelope?.company_id) ??
    asString(data?.account_id) ??
    asString(data?.company_id)
  );
}

/**
 * Our order reference for this event.
 *
 * `data.metadata.order_ref` is authoritative. `data.checkout_configuration_id`
 * is the fallback correlator for payloads where metadata was dropped (Whop
 * returns `metadata: null` without the `checkout_configuration:basic:read`
 * scope) — it is a `ch_...` id, NOT an order reference, so callers must treat a
 * hit here as "look this up", never as "this is the order".
 */
export function readWhopOrderReference(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  const metadata = asStringRecord(data.metadata);
  return asString(metadata.order_ref) ?? asString(data.checkout_configuration_id);
}

/**
 * The payment this event is about.
 *
 * A refund payload's own `id` is `rf_...`, NOT `pay_...`; a dispute payload's
 * `id` is a dispute id. The order state machine keys off the PAYMENT id, so for
 * those families the correlator is the sibling `payment_id` field. Reading
 * `data.id` unconditionally would hand `rf_…` to `GET /payments/{id}` and
 * 404.
 */
export function readWhopPaymentId(
  type: string,
  data: Record<string, unknown> | undefined,
): string | undefined {
  if (!data) return undefined;
  if (isRefundEvent(type) || isDisputeEvent(type) || type.startsWith('resolution_center_case.')) {
    return asString(data.payment_id);
  }
  return asString(data.id) ?? asString(data.payment_id);
}

/**
 * The amount this event concerns, in INTEGER minor units.
 *
 *   payment.*  -> `total` (account-facing total; excludes buyer fees)
 *   refund.*   -> `amount` (in the payment's settlement currency, nets against
 *                 the payment's `total`)
 *   dispute.*  -> `amount` when the dispute object carries money
 *
 * A missing or unparseable amount yields `undefined`; it never falls back to 0.
 * Reporting a $3 order as $0.00 would let an amount check pass on garbage.
 */
export function readWhopEventAmount(
  type: string,
  data: Record<string, unknown> | undefined,
): { amountMinor: number; currency: string } | undefined {
  if (!data) return undefined;
  const resourceId = asString(data.id) ?? asString(data.payment_id);
  const context = { field: `webhook.${type}`, ...(resourceId ? { resourceId } : {}) };

  if (isPaymentEvent(type)) {
    const total = whopMoneyToMinor(data.total, { ...context, field: 'payment.total' });
    // `subtotal` is pre-discount and pre-tax and `subtotal + tax` can differ
    // from `total` when a discount applies, so it is NOT a safe fallback for a
    // missing total. Returning undefined is the honest answer: the caller
    // re-reads the payment from the API rather than inventing an amount.
    return total;
  }

  const amount = firstMoneyToMinor(data, ['amount', 'original_amount', 'total'], context);
  if (amount) return amount;
  return undefined;
}

/**
 * Normalises a PARSED Whop webhook payload.
 *
 * Throws nothing: a payload that cannot be understood comes back as
 * `{ ok: false, reason: 'MALFORMED' }` so the caller can answer 400 without
 * risking an unhandled rejection inside the route handler.
 */
export function normalizeWhopWebhook(
  payload: unknown,
  options: NormalizeOptions = {},
): NormalizeResult {
  const envelope = asRecord(payload);
  if (!envelope) return { ok: false, reason: 'MALFORMED', diagnostics: {} };

  const type = asString(envelope.type);
  if (!type) return { ok: false, reason: 'MALFORMED', diagnostics: {} };

  const data = asRecord(envelope.data);
  const providerEventId = asString(envelope.id) ?? asString(options.fallbackEventId);
  if (!providerEventId) {
    // Without an id there is no dedup key, and Whop delivers at-least-once for
    // ~3 days. Accepting an id-less event means duplicate fulfilment.
    return { ok: false, reason: 'MALFORMED', diagnostics: { eventType: type } };
  }

  const providerPaymentId = readWhopPaymentId(type, data);
  const amount = readWhopEventAmount(type, data);
  const orderRef = readWhopOrderReference(data);
  const accountId = readWhopAccountId(envelope, data);

  const metadata: Record<string, string> = asStringRecord(data?.metadata);
  if (orderRef && metadata.order_ref === undefined) metadata.order_ref = orderRef;

  const occurredAt = asDate(envelope.timestamp);

  const event: VerifiedWebhookEvent = {
    providerEventId,
    eventType: type,
    outcome: whopOutcomeFor(type),
    raw: payload,
    ...(accountId ? { providerAccountId: accountId } : {}),
    ...(providerPaymentId ? { providerPaymentId } : {}),
    ...(amount ? { amountMinor: amount.amountMinor, currency: amount.currency } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(occurredAt ? { occurredAt } : {}),
  };

  return { ok: true, event };
}

// --- Wire object -> ProviderPaymentDetails -----------------------------------

/**
 * Whop payment `status` + `substatus` -> normalised verification status.
 *
 * The documented success check is `status === 'paid'`. Everything else is
 * mapped conservatively: a status we do not recognise becomes PENDING rather
 * than FAILED, because "FAILED" would cancel a customer's order on a shape
 * change.
 */
export function paymentVerificationFromStatus(payment: WhopPayment): ProviderPaymentDetails['status'] {
  const substatus = asString(payment.substatus)?.toLowerCase();
  const status = asString(payment.status)?.toLowerCase();

  // Reversal markers win over `status`: a `paid` payment that Whop has since
  // refunded or disputed is not a success for fulfilment purposes.
  if (substatus === 'dispute_warning' || substatus?.startsWith('dispute') || substatus?.startsWith('open_dispute')) {
    return { status: 'DISPUTED' };
  }
  if (substatus === 'refunded' || substatus === 'auto_refunded' || substatus === 'partially_refunded') {
    return { status: 'REVERSED' };
  }
  if (substatus === 'failed' || substatus === 'uncollectible') {
    return {
      status: 'FAILED',
      ...(asString(payment.decline_code) ? { code: asString(payment.decline_code) } : {}),
      ...(asString(payment.failure_message) ? { message: asString(payment.failure_message) } : {}),
    };
  }
  if (substatus === 'canceled') return { status: 'CANCELED' };
  if (substatus === 'requires_capture' || substatus === 'requires_action') {
    return { status: 'REQUIRES_ACTION' };
  }

  switch (status) {
    case 'paid': {
      // PAID carries amount + currency: "the charge landed" is not actionable
      // on its own, order reconciliation needs to know WHAT landed.
      const total = firstMoneyToMinor(payment as unknown as Record<string, unknown>, ['total'], {
        field: 'payment.total',
      });
      return {
        status: 'PAID',
        amountMinor: total?.amountMinor ?? 0,
        currency: total?.currency ?? asCurrency(payment.currency) ?? 'usd',
      };
    }
    case 'authorized':
    case 'open':
    case 'pending':
      return { status: 'PENDING' };
    case 'uncollectible':
    case 'void':
      return {
        status: 'FAILED',
        ...(asString(payment.decline_code) ? { code: asString(payment.decline_code) } : {}),
        ...(asString(payment.failure_message) ? { message: asString(payment.failure_message) } : {}),
      };
    case 'unresolved':
      return { status: 'PENDING' };
    default:
      return { status: 'PENDING' };
  }
}

/** Card brand + last4 ONLY. A PAN or CVV is never accepted, stored or returned. */
export function cardDescriptor(
  payment: WhopPayment,
): { cardBrand?: string; cardLast4?: string } | undefined {
  const card = payment.payment_instrument?.card;
  const brand = asString(card?.brand);
  const last4 = asString(card?.last4);
  if (!brand && !last4) return undefined;
  return {
    ...(brand ? { cardBrand: brand } : {}),
    ...(last4 ? { cardLast4: last4 } : {}),
  };
}

export type WhopRefundStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';

/** Whop refund `status` (pending|requires_action|succeeded|failed|canceled). */
export function normalizeRefundStatus(status: unknown): WhopRefundStatus {
  switch (asString(status)?.toLowerCase()) {
    case 'succeeded':
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    case 'canceled':
      return 'CANCELED';
    default:
      // `pending` and `requires_action` are both "not terminal, not failed".
      return 'PENDING';
  }
}

/** Relay pagination: only advance when Whop says there IS a next page. */
export function nextCursorFrom(pageInfo: WhopPageInfo | null | undefined): string | undefined {
  if (!pageInfo?.has_next_page) return undefined;
  const cursor = asString(pageInfo.end_cursor);
  return cursor ?? undefined;
}

/** Narrows an untrusted `page_info` object to the Relay shape. */
export function pageInfoFrom(value: unknown): WhopPageInfo | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const hasNext = record.has_next_page;
  const endCursor = record.end_cursor;
  return {
    ...(typeof endCursor === 'string' ? { end_cursor: endCursor } : {}),
    ...(typeof hasNext === 'boolean' ? { has_next_page: hasNext } : {}),
  };
}