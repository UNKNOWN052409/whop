/**
 * Provider-independent payment abstraction (spec §6).
 *
 * Every provider-specific concern — HTTP shape, signature scheme, field names
 * — lives behind this interface. The fulfillment pipeline depends only on these
 * types, so adding Stripe or another gateway later means adding one adapter
 * and one env var, not touching inventory, email, or orders.
 *
 * SECURITY: no interface here accepts or returns a PAN, CVV, UPI PIN, OTP, or
 * bank credential. The provider's own hosted/tokenized checkout owns card data
 * end to end; this server only ever sees an opaque provider id, an amount, and
 * a currency.
 */

import type { ProviderKind } from '@prisma/client';
import type { IntegrationStatus, PaymentMethodKey } from '@/lib/env';

// --- Value objects ----------------------------------------------------------

/** Integer minor units. Never a float. */
export type Amount = number;

export interface Money {
  amountMinor: Amount;
  currency: string;
}

export interface CustomerDetails {
  email: string;
  name?: string;
  /** Never a raw IP is stored; callers pass a hash. */
  ipHash?: string;
  userAgent?: string;
}

export interface CreatePaymentRequest {
  orderId: string;
  orderReference: string;
  amountMinor: Amount;
  currency: string;
  customer: CustomerDetails;
  productName: string;
  quantity: number;
  /** Where Whop sends the buyer after a successful checkout. */
  successUrl: string;
  cancelUrl: string;
  /** Forwarded to the provider and echoed back on the webhook. */
  metadata?: Record<string, string>;
  /**
   * Idempotency key. Two requests with the same key must produce ONE payment.
   * Payment creation is a spec §20 idempotent operation.
   */
  idempotencyKey: string;
}

export interface CreatePaymentResult {
  /** Provider's hosted checkout id, e.g. Whop `ch_...`. */
  providerCheckoutId: string;
  /** Where to redirect the customer. */
  checkoutUrl: string;
  expiresAt?: Date;
}

export type PaymentVerification =
  | { status: 'PAID'; amountMinor: Amount; currency: string; paidAt?: Date; cardBrand?: string; cardLast4?: string }
  | { status: 'PENDING' | 'REQUIRES_ACTION' }
  | { status: 'FAILED'; code?: string; message?: string }
  | { status: 'CANCELED' }
  | { status: 'DISPUTED' | 'REVERSED' };

export interface ProviderPaymentDetails {
  providerPaymentId: string;
  status: PaymentVerification;
  amountMinor?: Amount;
  currency?: string;
  /** What the merchant actually nets after Whop's fees. Drives real margin. */
  netAmountMinor?: Amount;
  feeMinor?: Amount;
  refundedAmountMinor?: Amount;
  metadata?: Record<string, string>;
  paidAt?: Date;
}

export interface VerifiedWebhookEvent {
  /** Provider event id (`msg_...` for Whop). Used as the dedup key. */
  providerEventId: string;
  eventType: string;
  providerAccountId?: string;
  providerPaymentId?: string;
  amountMinor?: Amount;
  currency?: string;
  metadata?: Record<string, string>;
  occurredAt?: Date;
  /** Normalised outcome the order state machine can act on. */
  outcome: 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'CANCELED' | 'REFUNDED' | 'DISPUTED' | 'UNKNOWN';
  raw: unknown;
}

export interface WebhookVerificationResult {
  valid: boolean;
  /** Populated only when `valid` is true. */
  event?: VerifiedWebhookEvent;
  reason?: 'BAD_SIGNATURE' | 'TIMESTAMP_OUT_OF_RANGE' | 'MALFORMED' | 'UNSUPPORTED_VERSION';
  /** Populated for observability on rejection; never logged at info level. */
  diagnostics?: { eventType?: string; timestampAgeSeconds?: number };
}

export interface RefundRequest {
  providerPaymentId: string;
  amountMinor: Amount;
  currency: string;
  reason?: string;
  idempotencyKey: string;
}

export interface RefundResult {
  providerRefundId: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  amountMinor: Amount;
  currency: string;
  failureReason?: string;
}

export interface ProviderCapabilities {
  /** Payment methods this provider can actually settle right now. */
  supportedMethods: PaymentMethodKey[];
  /** Whether refunds are programmatically supported (some are manual only). */
  supportsRefunds: boolean;
  supportsDisputeWebhooks: boolean;
  /** Whether the provider can be queried for reconciliation. */
  supportsListing: boolean;
}

// --- The interface ----------------------------------------------------------

export interface PaymentProvider {
  readonly kind: ProviderKind;
  readonly name: string;

  /** REAL | SANDBOX | NOT_CONFIGURED — surfaced on /api/health (spec §24). */
  readonly status: IntegrationStatus;

  /** What this provider can genuinely do. Drives the UI, never hard-coded. */
  readonly capabilities: ProviderCapabilities;

  /**
   * Throws AppError('PAYMENT_NOT_CONFIGURED') when unconfigured. Callers must
   * not substitute a fake implementation.
   */
  createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult>;

  /**
   * Authoritative status check against the provider's own API. This — not the
   * browser — is the only thing that may mark a payment PAID (spec §8).
   */
  getPaymentStatus(providerPaymentId: string): Promise<ProviderPaymentDetails>;

  /**
   * Server-to-server confirmation. Called after verifyWebhook() succeeds, to
   * confirm amount, currency and status directly with the provider.
   */
  verifyPayment(providerPaymentId: string, expected: Money): Promise<ProviderPaymentDetails>;

  /**
   * Cryptographically verifies a webhook and normalises it. MUST operate on the
   * RAW request body bytes — re-serialised JSON changes the signature.
   */
  verifyWebhook(rawBody: Buffer | string, headers: Record<string, string>): WebhookVerificationResult;

  refundPayment(request: RefundRequest): Promise<RefundResult>;

  /** Reconciliation source: payments in a time window. */
  listPayments(options: {
    from: Date;
    to: Date;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: ProviderPaymentDetails[]; nextCursor?: string }>;

  /** Reconciliation source: refunds in a time window. */
  listRefunds(options: {
    from: Date;
    to: Date;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: RefundRecord[]; nextCursor?: string }>;
}

export interface RefundRecord {
  providerRefundId: string;
  providerPaymentId: string;
  amountMinor: Amount;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  createdAt: Date;
  reason?: string;
}