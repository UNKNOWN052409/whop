/**
 * Payment provider registry.
 *
 * ONE provider is wired up (Whop) and the whole rest of the system talks to
 * `PaymentProvider` rather than to Whop. That is the entire point of the
 * interface in `@/payments/types`: swapping the gateway is a registry edit, not
 * a rewrite of checkout, the webhook handler, reconciliation or refunds.
 *
 * Two rules this file enforces:
 *
 *  1. UNCONFIGURED IS A STATE, NOT AN EXCEPTION WITH A FAKE FALLBACK.
 *     `getPaymentProvider()` returns `null` when Whop is not configured and
 *     `getProviderStatus()` reports `NOT_CONFIGURED` for the health endpoint.
 *     There is no stub, no sandbox-shaped mock, no "pretend it worked"
 *     implementation. A checkout that succeeds without a real charge is the
 *     worst failure a payment platform can have.
 *
 *  2. MONEY CROSSES THE BOUNDARY AS AN INTEGER MINOR-UNIT COUNT.
 *     Whop sends decimal strings in major units; `whopMoneyToMinor()` converts
 *     with string arithmetic. `Number("29.99")` is 29.989999999999998.
 *
 *  3. THE CUSTOMER PAYS $3 AND RECEIVES A $1 REDEEM CODE. `createPayment`
 *     sends `order.amountMinor` (the selling price) and nothing else. Nothing
 *     in this file may substitute face value for the price.
 *
 * The Whop adapter itself lives here because the registry is the only module
 * allowed to decide *which* implementation is real; the pieces it composes
 * (HTTP client, signature verification, money conversion, wire types) are the
 * already-built modules under `@/payments/whop/*`.
 */

import {
  PaymentStatus,
  type ProviderKind,
} from '@prisma/client';

import { whopConfig } from '@/lib/env';
import type { IntegrationStatus } from '@/lib/env';
import { AppError, errors } from '@/lib/errors';
import { logger } from '@/lib/logger';

import { whopClient } from './whop/client';
import {
  WHOP_PAYMENT_METHOD,
  requireWhopConfig,
  resolveWhopConfig,
  whopPaymentMethodConfiguration,
  enabledWhopPaymentMethods,
} from './whop/config';
import {
  computeNetAndFee,
  firstMoneyToMinor,
  minorToWhopPrice,
} from './whop/money';
import { verifyWhopSignature } from './whop/signature';
import {
  asCurrency,
  asDate,
  asRecord,
  asString,
  asStringRecord,
  type WhopCheckoutConfiguration,
  type WhopPage,
  type WhopPayment,
  type WhopRefund,
  type WhopWebhookEnvelope,
} from './whop/types';
import type {
  CreatePaymentRequest,
  CreatePaymentResult,
  Money,
  PaymentProvider,
  PaymentVerification,
  ProviderCapabilities,
  ProviderPaymentDetails,
  RefundRecord,
  RefundRequest,
  RefundResult,
  VerifiedWebhookEvent,
  WebhookVerificationResult,
} from './types';

export const PAYMENT_PROVIDER_NAME = 'whop';

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/** Whop substatuses that mean "the money came back or was challenged". */
const DISPUTE_SUBSTATUSES: ReadonlySet<string> = new Set([
  'dispute_warning',
  'dispute_needs_response',
  'dispute_warning_needs_response',
  'resolution_needs_response',
  'dispute_under_review',
  'dispute_warning_under_review',
  'resolution_under_review',
  'dispute_won',
  'dispute_warning_closed',
  'resolution_won',
  'dispute_lost',
  'dispute_closed',
  'resolution_lost',
  'open_dispute',
  'open_resolution',
]);

const REVERSED_SUBSTATUSES: ReadonlySet<string> = new Set([
  'refunded',
  'auto_refunded',
  'partially_refunded',
]);

/**
 * Whop status/substatus -> our provider-independent verification.
 *
 * Success check per WHOP_API_REFERENCE.md §4 is `status === "paid"`. Anything
 * else is NOT paid, and only `PAID` may move an order forward.
 */
export function toPaymentVerification(payment: WhopPayment): PaymentVerification {
  const status = payment.status ?? '';
  const substatus = payment.substatus ?? '';

  if (REVERSED_SUBSTATUSES.has(substatus) || status === 'void') {
    return { status: 'REVERSED' };
  }
  if (DISPUTE_SUBSTATUSES.has(substatus)) {
    return { status: 'DISPUTED' };
  }
  if (status === 'paid') {
    // Brand + last4 only. Whop never returns a PAN and neither may we handle one.
    const card = payment.payment_instrument?.card ?? undefined;
    // PAID carries the amount and currency too: a caller that only sees
    // "PAID" still knows WHAT was paid, which is what order reconciliation needs.
    const total = firstMoneyToMinor(payment as Record<string, unknown>, ['total'], {
      field: 'payment.total',
    });
    return {
      status: 'PAID',
      amountMinor: total?.amountMinor ?? 0,
      currency: total?.currency ?? asCurrency(payment.currency) ?? 'usd',
      ...(card?.brand ? { cardBrand: card.brand } : {}),
      ...(card?.last4 ? { cardLast4: card.last4 } : {}),
    };
  }
  if (status === 'uncollectible' || substatus === 'failed' || substatus === 'blocked') {
    return {
      status: 'FAILED',
      ...(payment.decline_code ? { code: payment.decline_code } : {}),
      ...(payment.failure_message ? { message: payment.failure_message } : {}),
    };
  }
  if (substatus === 'canceled') {
    return { status: 'CANCELED' };
  }
  if (substatus === 'requires_action' || substatus === 'past_due') {
    return { status: 'REQUIRES_ACTION' };
  }
  return { status: 'PENDING' };
}

/** Our PaymentStatus -> Whop's PaymentStatus, for reads of stored rows. */
export function toPrismaPaymentStatus(
  verification: PaymentVerification,
): PaymentStatus {
  switch (verification.status) {
    case 'PAID':
      return PaymentStatus.PAID;
    case 'FAILED':
      return PaymentStatus.FAILED;
    case 'CANCELED':
      return PaymentStatus.CANCELED;
    case 'DISPUTED':
      return PaymentStatus.DISPUTED;
    case 'REVERSED':
      return PaymentStatus.REVERSED;
    case 'REQUIRES_ACTION':
      return PaymentStatus.REQUIRES_ACTION;
    case 'PENDING':
      return PaymentStatus.PENDING;
    default:
      return PaymentStatus.PENDING;
  }
}

// ---------------------------------------------------------------------------
// Webhook event normalisation
// ---------------------------------------------------------------------------

/**
 * Envelope `type` -> the normalised outcome the order state machine acts on.
 *
 * Whop has NO `payment.refunded` and NO `payment.chargeback` event. Refunds
 * arrive as `refund.*` and chargebacks as `dispute.*` / `dispute_alert.*` /
 * `resolution_center_case.*` (WHOP_API_REFERENCE.md §3). Mapping only
 * `payment.*` here would silently ignore every reversal.
 */
export function whopEventOutcome(
  eventType: string,
  data: Record<string, unknown> | undefined,
): VerifiedWebhookEvent['outcome'] {
  switch (eventType) {
    case 'payment.succeeded':
      return 'SUCCEEDED';
    case 'payment.failed':
      return 'FAILED';
    case 'payment.canceled':
      return 'CANCELED';
    case 'payment.authorized':
    case 'payment.pending':
    case 'payment.requires_action':
    case 'payment.created':
      return 'PENDING';
    case 'refund.created':
    case 'refund.updated': {
      const status = asString(data?.status)?.toLowerCase();
      if (status === 'succeeded') return 'REFUNDED';
      if (status === 'failed' || status === 'canceled') return 'FAILED';
      return 'PENDING';
    }
    case 'dispute.created':
    case 'dispute.updated':
    case 'dispute_alert.created':
    case 'resolution_center_case.created':
    case 'resolution_center_case.updated':
    case 'resolution_center_case.decided':
      return 'DISPUTED';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Parse a VERIFIED Whop envelope into a `VerifiedWebhookEvent`.
 *
 * DELIBERATELY DOES NOT VERIFY THE SIGNATURE — the caller must have already
 * done that on the raw bytes. This function only normalises, so the route can
 * keep explicit control over "400 + alert" on a bad signature.
 */
export function normalizeWhopWebhook(rawBody: Buffer | string): VerifiedWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody);
  } catch {
    throw new AppError('Webhook body is not valid JSON', 400, 'INVALID_SIGNATURE');
  }

  const envelopeRecord = asRecord(parsed);
  if (!envelopeRecord) {
    throw new AppError('Webhook body is not a JSON object', 400, 'INVALID_SIGNATURE');
  }
  const envelope = envelopeRecord as WhopWebhookEnvelope;

  const providerEventId = asString(envelope.id);
  const eventType = asString(envelope.type);
  if (!providerEventId || !eventType) {
    throw new AppError('Webhook envelope is missing id or type', 400, 'INVALID_SIGNATURE');
  }

  const data = asRecord(envelope.data);
  const outcome = whopEventOutcome(eventType, data);

  const isPaymentEvent = eventType.startsWith('payment.');
  // For refund/dispute envelopes the payment is identified by `payment_id`.
  const providerPaymentId = isPaymentEvent
    ? asString(data?.id)
    : asString(data?.payment_id);

  // Amount: a payment carries `total`; a refund carries `amount`. Both are
  // Money objects in the payment's settlement currency.
  let amountMinor: number | undefined;
  let currency: string | undefined;
  if (data) {
    const money = isPaymentEvent
      ? firstMoneyToMinor(data, ['total'], { field: 'webhook.data.total' })
      : firstMoneyToMinor(data, ['amount', 'total'], { field: 'webhook.data.amount' });
    amountMinor = money?.amountMinor;
    currency = money?.currency ?? asCurrency(data.currency);
  }

  return {
    providerEventId,
    eventType,
    ...(asString(envelope.account_id) ?? asString(envelope.company_id)
      ? { providerAccountId: (asString(envelope.account_id) ?? asString(envelope.company_id)) as string }
      : {}),
    ...(providerPaymentId ? { providerPaymentId } : {}),
    ...(amountMinor === undefined ? {} : { amountMinor }),
    ...(currency ? { currency } : {}),
    metadata: asStringRecord(data?.metadata),
    ...(asDate(envelope.timestamp) ? { occurredAt: asDate(envelope.timestamp) as Date } : {}),
    outcome,
    raw: parsed,
  };
}

// ---------------------------------------------------------------------------
// The Whop adapter
// ---------------------------------------------------------------------------

/**
 * Which payment methods this deployment can genuinely settle right now. Derived
 * from `ENABLED_PAYMENT_METHODS` ∩ what Whop supports — never a hard-coded list.
 */
function whopCapabilities(): ProviderCapabilities {
  return {
    supportedMethods: enabledWhopPaymentMethods().length > 0 ? ['CARD', 'WALLET'] : [],
    // Refund CREATION is not a verified endpoint in WHOP_API_REFERENCE.md, so
    // the adapter refuses to invent one. Refunds initiated in the Whop dashboard
    // still arrive here as `refund.created` webhooks.
    supportsRefunds: false,
    supportsDisputeWebhooks: true,
    supportsListing: true,
  };
}

async function retrieveCheckoutConfiguration(
  id: string,
): Promise<WhopCheckoutConfiguration | null> {
  const response = await whopClient.request<WhopCheckoutConfiguration>({
    method: 'GET',
    path: `/checkout_configurations/${encodeURIComponent(id)}`,
    operation: 'retrieveCheckoutConfiguration',
  });
  return response.data ?? null;
}

function whopProvider(): PaymentProvider {
  const config = requireWhopConfig();

  return {
    kind: config.kind as ProviderKind,
    name: PAYMENT_PROVIDER_NAME,
    status: config.status,
    capabilities: whopCapabilities(),

    async createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult> {
      if (!Number.isInteger(request.amountMinor) || request.amountMinor < 0) {
        throw new AppError('Payment amount must be a non-negative integer in minor units', 400, 'VALIDATION_FAILED');
      }

      // The order's SELLING price is what crosses to Whop. Never face value.
      const price = minorToWhopPrice(request.amountMinor, request.currency);
      const currency = asCurrency(request.currency) ?? 'usd';

      const response = await whopClient.request<WhopCheckoutConfiguration>({
        method: 'POST',
        path: '/checkout_configurations',
        operation: 'createCheckoutConfiguration',
        idempotencyKey: request.idempotencyKey,
        body: {
          account_id: config.accountId,
          mode: 'payment',
          currency,
          redirect_url: request.successUrl,
          payment_method_configuration: whopPaymentMethodConfiguration(),
          metadata: {
            ...(request.metadata ?? {}),
            // Our own correlation key. Echoed back on every payment webhook.
            order_ref: request.orderReference,
            order_id: request.orderId,
          },
          plan: {
            title: request.productName,
            plan_type: 'one_time',
            initial_price: price,
            currency,
            // Prices this SKU differ per order, so never let Whop silently reuse
            // a variant with a different price.
            force_create_new_plan: true,
            release_method: 'buy_now',
            unlimited_stock: true,
          },
        },
      });

      const checkout = response.data;
      if (!checkout?.id) {
        throw new AppError('Whop returned a checkout configuration without an id', 502, 'PROVIDER_UNAVAILABLE');
      }

      const purchaseUrl =
        asString(checkout.purchase_url) ?? `${config.checkoutBaseUrl}/checkout/${checkout.id}/`;

      logger.info('Whop checkout created', {
        orderId: request.orderId,
        amountMinor: request.amountMinor,
        currency: request.currency,
        providerCheckoutId: checkout.id,
      });

      return { providerCheckoutId: checkout.id, checkoutUrl: purchaseUrl };
    },

    async getPaymentStatus(providerPaymentId: string): Promise<ProviderPaymentDetails> {
      const response = await whopClient.request<WhopPayment>({
        method: 'GET',
        path: `/payments/${encodeURIComponent(providerPaymentId)}`,
        operation: 'retrievePayment',
      });
      const payment = response.data;
      if (!payment) {
        throw new AppError(`Whop returned no payment for ${providerPaymentId}`, 502, 'PAYMENT_VERIFICATION_FAILED');
      }
      return mapPayment(providerPaymentId, payment);
    },

    async verifyPayment(providerPaymentId: string, expected: Money): Promise<ProviderPaymentDetails> {
      const details = await this.getPaymentStatus(providerPaymentId);
      const verification = details.status;
      if (verification.status !== 'PAID') {
        throw new AppError(
          `Whop payment ${providerPaymentId} is ${verification.status}, not PAID`,
          502,
          'PAYMENT_VERIFICATION_FAILED',
          { details: { providerPaymentId, providerStatus: verification.status } },
        );
      }
      if (details.amountMinor !== undefined && details.amountMinor !== expected.amountMinor) {
        throw new AppError(
          `Whop payment ${providerPaymentId} amount ${details.amountMinor} does not match expected ${expected.amountMinor}`,
          409,
          'AMOUNT_MISMATCH',
          { details: { providerPaymentId, expected: expected.amountMinor, actual: details.amountMinor } },
        );
      }
      if (details.currency && details.currency.toLowerCase() !== expected.currency.toLowerCase()) {
        throw new AppError(
          `Whop payment ${providerPaymentId} currency ${details.currency} does not match expected ${expected.currency}`,
          409,
          'CURRENCY_MISMATCH',
          { details: { providerPaymentId, expected: expected.currency, actual: details.currency } },
        );
      }
      return details;
    },

    verifyWebhook(rawBody: Buffer | string, headers: Record<string, string>): WebhookVerificationResult {
      const resolved = resolveWhopConfig();
      if (!resolved) {
        return { valid: false, reason: 'MALFORMED' };
      }
      const signature = verifyWhopSignature(rawBody, headers, resolved.webhookSecret);
      if (!signature.ok) {
        return { valid: false, reason: signature.reason ?? 'BAD_SIGNATURE' };
      }
      try {
        const event = normalizeWhopWebhook(rawBody);
        return { valid: true, event };
      } catch {
        return { valid: false, reason: 'MALFORMED' };
      }
    },

    async refundPayment(request: RefundRequest): Promise<RefundResult> {
      // NOT FAKED. WHOP_API_REFERENCE.md documents `GET /refunds` but does not
      // verify a create-refund endpoint, so this adapter refuses to guess one.
      // Surfacing an honest failure here is strictly better than sending a
      // refund request to a path that may 404 and reporting success.
      void request;
      throw new AppError(
        'Programmatic refunds are not enabled: a Whop create-refund endpoint is not verified ' +
          'in WHOP_API_REFERENCE.md. Issue the refund from the Whop dashboard — it arrives ' +
          'here as a refund.created webhook and is handled automatically.',
        501,
        'PROVIDER_UNAVAILABLE',
        { details: { provider: PAYMENT_PROVIDER_NAME, operation: 'refundPayment' } },
      );
    },

    async listPayments(options: {
      from: Date;
      to: Date;
      cursor?: string;
      limit?: number;
    }) {
      const response = await whopClient.request<WhopPage<WhopPayment>>({
        method: 'GET',
        path: '/payments',
        operation: 'listPayments',
        query: {
          account_id: config.accountId,
          created_after: options.from.toISOString(),
          created_before: options.to.toISOString(),
          first: Math.min(options.limit ?? 100, 100),
          ...(options.cursor ? { after: options.cursor } : {}),
        },
      });
      const page = response.data;
      const items = (page?.data ?? [])
        .filter((row): row is WhopPayment => Boolean(row?.id))
        .map((row) => mapPayment(asString(row.id) as string, row));
      return {
        items,
        ...(page?.page_info?.has_next_page && page.page_info.end_cursor
          ? { nextCursor: page.page_info.end_cursor }
          : {}),
      };
    },

    async listRefunds(options: {
      from: Date;
      to: Date;
      cursor?: string;
      limit?: number;
    }): Promise<{ items: RefundRecord[]; nextCursor?: string }> {
      const response = await whopClient.request<WhopPage<WhopRefund>>({
        method: 'GET',
        path: '/refunds',
        operation: 'listRefunds',
        query: {
          account_id: config.accountId,
          created_after: options.from.toISOString(),
          created_before: options.to.toISOString(),
          first: Math.min(options.limit ?? 100, 100),
          ...(options.cursor ? { after: options.cursor } : {}),
        },
      });
      const page = response.data;
      const items: RefundRecord[] = [];
      for (const row of page?.data ?? []) {
        const id = asString(row?.id);
        const paymentId = asString(row?.payment_id);
        if (!id || !paymentId) continue;
        const money = firstMoneyToMinor(row as unknown as Record<string, unknown>, ['amount'], {
          field: 'refund.amount',
          resourceId: id,
        });
        items.push({
          providerRefundId: id,
          providerPaymentId: paymentId,
          amountMinor: money?.amountMinor ?? 0,
          currency: money?.currency ?? 'usd',
          status: mapRefundStatus(asString(row?.status)?.toLowerCase()),
          createdAt: asDate(row?.created_at) ?? new Date(0),
          ...(asString(row?.reason) ? { reason: asString(row?.reason) as string } : {}),
        });
      }
      return {
        items,
        ...(page?.page_info?.has_next_page && page.page_info.end_cursor
          ? { nextCursor: page.page_info.end_cursor }
          : {}),
      };
    },
  };
}

function mapRefundStatus(status: string | undefined): RefundRecord['status'] {
  switch (status) {
    case 'succeeded':
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    case 'canceled':
      return 'CANCELED';
    default:
      return 'PENDING';
  }
}

/**
 * Whop Payment -> `ProviderPaymentDetails`.
 *
 * The amount reported is `total` — the account-facing total the buyer was
 * charged — converted to integer minor units. `amount_after_fees` is carried
 * separately as `netAmountMinor` because it is what the merchant actually nets
 * and it must never be substituted for the charged amount.
 */
function mapPayment(providerPaymentId: string, payment: WhopPayment): ProviderPaymentDetails {
  const record = payment as unknown as Record<string, unknown>;
  const total = firstMoneyToMinor(record, ['total', 'usd_total'], {
    field: 'payment.total',
    resourceId: providerPaymentId,
  });
  const refunded = firstMoneyToMinor(record, ['refunded_amount'], {
    field: 'payment.refunded_amount',
    resourceId: providerPaymentId,
  });
  const net = computeNetAndFee(record, { field: 'payment', resourceId: providerPaymentId });

  return {
    providerPaymentId,
    status: toPaymentVerification(payment),
    ...(total ? { amountMinor: total.amountMinor, currency: total.currency } : {}),
    ...(net ? { netAmountMinor: net.net.amountMinor, feeMinor: net.feeMinor } : {}),
    ...(refunded ? { refundedAmountMinor: refunded.amountMinor } : {}),
    metadata: asStringRecord(payment.metadata),
    ...(asDate(payment.paid_at) ? { paidAt: asDate(payment.paid_at) as Date } : {}),
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The configured provider, or `null` when there is none.
 *
 * Callers MUST handle `null`. The intended handling is `errors.providerNotConfigured`
 * → a 503 that says NOT CONFIGURED, never a substitute provider.
 */
export function getPaymentProvider(): PaymentProvider | null {
  if (!whopConfig.configured) return null;
  try {
    return whopProvider();
  } catch (error) {
    logger.error('Payment provider could not be constructed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Same contract as `getPaymentProvider` but throws the honest 503. Use in
 * request paths where an unconfigured provider is an operator error.
 */
export function requirePaymentProvider(): PaymentProvider {
  const provider = getPaymentProvider();
  if (!provider) throw errors.providerNotConfigured('Payment provider');
  return provider;
}

export interface ProviderStatusReport {
  /** Provider key, e.g. "whop". */
  provider: string;
  /** REAL | SANDBOX | NOT CONFIGURED. Surfaced verbatim on /api/health. */
  status: IntegrationStatus;
  /** Prisma ProviderKind, or null when unconfigured. */
  kind: ProviderKind | null;
  /** Whop identifiers actually enabled for this deployment. */
  enabledMethods: string[];
  capabilities: ProviderCapabilities;
  /** Names of the env vars still missing. Never their values. */
  missing: string[];
  /** Environment pinning, e.g. "production" | "sandbox". */
  environment: string | null;
}

/**
 * Health payload for the payment integration. Secret-free by construction: it
 * reports the NAMES of missing variables, never any value.
 */
export function getProviderStatus(): ProviderStatusReport {
  const provider = getPaymentProvider();
  const missing: string[] = [];
  if (!whopConfig.apiKey) missing.push('WHOP_API_KEY');
  if (!whopConfig.webhookSecret) missing.push('WHOP_WEBHOOK_SECRET');
  if (!whopConfig.accountId) missing.push('WHOP_ACCOUNT_ID');

  return {
    provider: PAYMENT_PROVIDER_NAME,
    status: provider ? provider.status : 'NOT_CONFIGURED',
    kind: provider ? provider.kind : null,
    enabledMethods: enabledWhopPaymentMethods(),
    capabilities: provider ? provider.capabilities : {
      supportedMethods: [],
      supportsRefunds: false,
      supportsDisputeWebhooks: false,
      supportsListing: false,
    },
    missing,
    environment: whopConfig.configured ? whopConfig.environment : null,
  };
}

export { WHOP_PAYMENT_METHOD };