/**
 * Whop wire types + defensive coercion helpers.
 *
 * The types here describe what WHOP_API_REFERENCE.md documents. They are not a
 * promise: Whop can and does add fields, so every read from a wire object goes
 * through the coercion helpers at the bottom of this file rather than a direct
 * cast. A webhook payload is untrusted input even when its signature is valid.
 */

import type { ProviderKind } from '@prisma/client';

// --- Resources ---------------------------------------------------------------

export interface WhopMoney {
  /** DECIMAL STRING in MAJOR units: "29.99". Never a number. */
  amount?: string | null;
  /** Lowercase ISO 4217. */
  currency?: string | null;
  /** Precision the charge actually runs at (2 for usd). */
  decimals?: number | null;
  /** Precision to DISPLAY (differs from `decimals` for e.g. COP). */
  display_decimals?: number | null;
}

export interface WhopCardInstrument {
  brand?: string | null;
  /** Last four only. Whop never returns a PAN and neither may we handle one. */
  last4?: string | null;
  issuer_identification_number?: string | null;
  exp_month?: number | null;
  exp_year?: number | null;
}

export interface WhopPaymentInstrument {
  payment_method_type?: string | null;
  display_name?: string | null;
  card?: WhopCardInstrument | null;
  installment_count?: number | null;
}

export type WhopPaymentStatus =
  | 'draft'
  | 'open'
  | 'authorized'
  | 'paid'
  | 'pending'
  | 'uncollectible'
  | 'unresolved'
  | 'void';

export type WhopPaymentSubstatus = string;

export interface WhopPayment {
  id?: string | null;
  /** `account_id` on the pinned (2026-08-14+) shape, `company_id` on the legacy one. */
  account_id?: string | null;
  company_id?: string | null;
  status?: WhopPaymentStatus | null;
  substatus?: WhopPaymentSubstatus | null;
  /** Account-facing total: discounts applied, tax on top, EXCLUDES buyer fees. */
  total?: WhopMoney | null;
  /** What the merchant actually keeps = total less Whop's fees. */
  amount_after_fees?: WhopMoney | null;
  subtotal?: WhopMoney | null;
  tax_amount?: WhopMoney | null;
  refunded_amount?: WhopMoney | null;
  currency?: string | null;
  /** OUR order reference rides in here (we set it on the checkout configuration). */
  metadata?: Record<string, unknown> | null;
  checkout_configuration_id?: string | null;
  plan_id?: string | null;
  product_id?: string | null;
  member_id?: string | null;
  membership_id?: string | null;
  payment_method_type?: string | null;
  payment_instrument?: WhopPaymentInstrument | null;
  decline_code?: string | null;
  failure_message?: string | null;
  refundable?: boolean | null;
  auto_refunded?: boolean | null;
  billing_reason?: string | null;
  paid_at?: string | null;
  refunded_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export type WhopRefundStatus = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';

export interface WhopRefund {
  id?: string | null;
  payment_id?: string | null;
  account_id?: string | null;
  company_id?: string | null;
  status?: WhopRefundStatus | null;
  /** In the PAYMENT's settlement currency — nets against the payment's `total`. */
  amount?: WhopMoney | null;
  /** What the processor actually moved. */
  original_amount?: WhopMoney | null;
  provider?: string | null;
  reason?: string | null;
  failure_reason?: string | null;
  failure_message?: string | null;
  provider_created_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface WhopDispute {
  id?: string | null;
  payment_id?: string | null;
  account_id?: string | null;
  company_id?: string | null;
  status?: string | null;
  /** Present on dispute objects that carry their own money fields. */
  amount?: WhopMoney | null;
  reason?: string | null;
  evidence_details_due_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface WhopResolutionCenterCase {
  id?: string | null;
  payment_id?: string | null;
  account_id?: string | null;
  company_id?: string | null;
  status?: string | null;
  /** e.g. `approved` | `denied` on `.decided`. */
  decision?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * The union of everything a Whop webhook `data` payload can be. We never assume
 * — `kind` is filled in by the mapper from the envelope's `type`, not from a
 * payload field, because a refund payload is indistinguishable from a payment
 * payload by shape alone.
 */
export type WhopEventData = WhopPayment | WhopRefund | WhopDispute | WhopResolutionCenterCase;

export interface WhopWebhookEnvelope {
  /** `msg_...` — the dedup key. Mirrors the `webhook-id` header. */
  id?: string | null;
  /** e.g. "payment.succeeded" */
  type?: string | null;
  api_version?: string | null;
  api_version_date?: string | null;
  /** ISO 8601 event time. Distinct from the `webhook-timestamp` HEADER. */
  timestamp?: string | null;
  /** `biz_...` on pinned payloads, `company_id` on unpinned/legacy ones. */
  account_id?: string | null;
  company_id?: string | null;
  data?: unknown;
  previous_attributes?: unknown;
}

/** Relay-style pagination envelope returned by every list endpoint. */
export interface WhopPageInfo {
  start_cursor?: string | null;
  end_cursor?: string | null;
  has_next_page?: boolean | null;
  has_previous_page?: boolean | null;
}

export interface WhopPage<T> {
  data?: T[] | null;
  page_info?: WhopPageInfo | null;
}

export interface WhopCheckoutConfiguration {
  /** `ch_...` */
  id: string;
  account_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  mode?: string | null;
  /** https://whop.com/checkout/ch_.../ */
  purchase_url?: string | null;
  redirect_url?: string | null;
  metadata?: Record<string, unknown> | null;
  currency?: string | null;
  plan?: Record<string, unknown> | null;
}

/** Whop's error envelope: `{ "error": { "type": ..., "message": ... } }`. */
export interface WhopErrorEnvelope {
  error?: {
    type?: string | null;
    message?: string | null;
    code?: string | null;
  };
  message?: string | null;
}

export type WhopProviderKind = Extract<ProviderKind, 'WHOP' | 'WHOP_SANDBOX'>;

// --- Defensive coercion ------------------------------------------------------

/** Narrows to a plain object. Arrays and null are rejected. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Non-empty trimmed string, or undefined. */
export function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * String map for Whop's free-form `metadata` object. Numbers and booleans are
 * stringified (Whop accepts them in practice); everything else — nested objects,
 * arrays, null — is DROPPED rather than JSON-injected into our own metadata
 * field, so a hostile payload cannot smuggle structure into the order lookup.
 */
export function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === 'string') out[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = String(raw);
    else if (typeof raw === 'boolean') out[key] = String(raw);
  }
  return out;
}

/** Valid Date, or undefined. Rejects "not a date" rather than producing NaN. */
export function asDate(value: unknown): Date | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Lowercase, trimmed currency code. Whop's wire format is lowercase ISO. */
export function asCurrency(value: unknown): string | undefined {
  const text = asString(value);
  return text ? text.toLowerCase() : undefined;
}
