/**
 * Whop payment provider — the single place that talks money to Whop.
 *
 * Everything provider-specific lives here: the HTTP calls go through
 * `./client` (retries, rate limiting, error envelope), signature verification
 * through `./signature`, decimal-string money through `./money`, and webhook
 * shape through `./events`. Nothing else in the app imports `fetch` for Whop.
 *
 * RULES THIS CLASS ENFORCES:
 *
 *  - MONEY IS INTEGER MINOR UNITS. The ONLY float produced is `initial_price`
 *    on the create-checkout body, because Whop's OpenAPI types that one field
 *    as a NUMBER in major units. It is derived from an integer we already hold
 *    and is round-trip verified inside `minorToWhopPrice`.
 *  - "PRICE $3 / VALUE $1" IS NEVER INVERTED. `request.amountMinor` is the
 *    SELLING PRICE and is the only number that crosses this boundary.
 *  - NO PAN, CVV, OTP OR UPI PIN is ever accepted, stored, logged or returned.
 *    Whop's hosted page owns card data end to end; we only ever see a `pay_…`
 *    id, an amount, a currency, and a card brand + last4.
 *  - UNCONFIGURED MEANS UNCONFIGURED. `createPayment` throws a 503
 *    `PAYMENT_NOT_CONFIGURED`; there is no sandbox stub and no fake success.
 */

import type { ProviderKind } from '@prisma/client';
import {
  PAYMENT_METHOD_BINDINGS,
  PAYMENT_METHODS,
  type IntegrationStatus,
  type PaymentMethodKey,
  whopConfig,
} from '@/lib/env';
import { AppError, errors } from '@/lib/errors';
import { logger } from '@/lib/logger';
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
  WebhookVerificationResult,
} from '@/payments/types';
import { whopClient, type WhopClient } from './client';
import {
  requireWhopConfig,
  resolveWhopConfig,
  whopPaymentMethodConfiguration,
  WHOP_PROVIDER_NAME,
} from './config';
import {
  cardDescriptor,
  nextCursorFrom,
  normalizeRefundStatus,
  normalizeWhopWebhook,
  pageInfoFrom,
  paymentVerificationFromStatus,
  type WhopRefundStatus,
} from './events';
import { computeNetAndFee, minorToWhopPrice, whopMoneyToMinor } from './money';
import { verifyWhopSignature } from './signature';
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
} from './types';

/** Whop rejects `first`/`last` above 100. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

/** Longest reason we will forward to Whop; the field is an enum upstream. */
const MAX_REASON_LENGTH = 200;

/**
 * Whop's `reason` field is a CLOSED enum
 * (`duplicate|fraudulent|requested_by_customer|expired_uncaptured_charge|dispute_alert`).
 * Our callers pass free text, so it is mapped onto the enum rather than sent
 * verbatim — an unmapped string would 422 the whole refund.
 */
const REFUND_REASONS = [
  'duplicate',
  'fraudulent',
  'requested_by_customer',
  'expired_uncaptured_charge',
  'dispute_alert',
] as const;

type WhopRefundReason = (typeof REFUND_REASONS)[number];

function toWhopRefundReason(reason: string | undefined): WhopRefundReason {
  const text = (reason ?? '').toLowerCase();
  if (!text) return 'requested_by_customer';
  if (text.includes('duplicate')) return 'duplicate';
  if (text.includes('fraud') || text.includes('chargeback')) return 'fraudulent';
  if (text.includes('dispute') || text.includes('early')) return 'dispute_alert';
  if (text.includes('expire') || text.includes('uncollect')) return 'expired_uncaptured_charge';
  return 'requested_by_customer';
}

function clampPageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(Math.trunc(limit), MAX_PAGE_SIZE));
}

function isoDate(value: Date, field: string): string {
  if (Number.isNaN(value.getTime())) {
    throw errors.validation(`${field} must be a valid Date`);
  }
  return value.toISOString();
}

/**
 * Capabilities, derived from what Whop genuinely supports.
 *
 * `supportedMethods` is the intersection of `ENABLED_PAYMENT_METHODS` and
 * `PAYMENT_METHOD_BINDINGS[method].supported` — i.e. only rails that BOTH the
 * deployment enabled and Whop can actually settle. UPI, WALLET and NETBANKING
 * are declared unsupported rather than advertised and then failed at checkout.
 */
function deriveSupportedMethods(): PaymentMethodKey[] {
  return PAYMENT_METHODS.filter((method) => PAYMENT_METHOD_BINDINGS[method]?.supported === true);
}

export class WhopPaymentProvider implements PaymentProvider {
  readonly name = 'whop';

  /**
   * Getters, not snapshot fields: `whopConfig.status` reads env at access time
   * so /api/health and tests observe the current configuration. Constructing
   * the provider NEVER throws — an unconfigured Whop is a reportable state,
   * not a boot failure.
   */
  get kind(): ProviderKind {
    return whopConfig.kind;
  }

  get status(): IntegrationStatus {
    return whopConfig.status;
  }

  /**
   * Mutable by design: `refundPayment` flips `supportsRefunds` to false when
   * Whop tells us this account may not refund programmatically, so the admin
   * UI stops offering an action that cannot succeed.
   */
  private readonly capabilitiesImpl: ProviderCapabilities;

  get capabilities(): ProviderCapabilities {
    return this.capabilitiesImpl;
  }

  private readonly client: WhopClient;

  constructor(client: WhopClient = whopClient) {
    this.client = client;
    this.capabilitiesImpl = {
      supportedMethods: deriveSupportedMethods(),
      // Refunds are a POST against /refunds. Whop only guarantees the LIST
      // endpoint on every account; programmatic refunding is permission-gated,
      // so this is asserted optimistically and corrected on the first refusal.
      supportsRefunds: whopConfig.status !== 'NOT_CONFIGURED',
      supportsDisputeWebhooks: true,
      supportsListing: true,
    };
  }

  // --- Create ----------------------------------------------------------------

  async createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult> {
    // Hard rule #3: unconfigured means NOT CONFIGURED, never a stub.
    const config = requireWhopConfig();

    if (!Number.isInteger(request.amountMinor) || request.amountMinor <= 0) {
      throw errors.validation('Payment amount must be a positive integer of minor units', {
        amountMinor: request.amountMinor,
        orderReference: request.orderReference,
      });
    }
    if (!request.successUrl) {
      throw errors.validation('A post-checkout redirect URL is required');
    }

    const currency = asCurrency(request.currency);
    if (!currency) {
      throw errors.validation('A currency is required to create a payment', {
        orderReference: request.orderReference,
      });
    }

    const body = {
      account_id: config.accountId,
      plan: {
        title: request.productName,
        plan_type: 'one_time' as const,
        // THE ONE FLOAT IN THIS ADAPTER: Whop's schema types `initial_price` as
        // a number in MAJOR units. `minorToWhopPrice` converts the integer
        // minor units we hold and fails if the value does not round-trip, so a
        // currency with the wrong exponent cannot charge $0.03 for a $3 code.
        initial_price: minorToWhopPrice(request.amountMinor, currency),
        currency,
        // Without this Whop may REUSE a matching variant priced differently,
        // which silently mis-prices a cart at a different amount.
        force_create_new_plan: true,
      },
      // Copied onto the payment and echoed on the webhook — the ONLY reliable
      // link back to our order.
      metadata: { order_ref: request.orderReference },
      redirect_url: request.successUrl,
      // Explicit method list, platform defaults OFF: platform defaults can add
      // BNPL at 15%, which would destroy the margin on a $3 SKU.
      payment_method_configuration: whopPaymentMethodConfiguration(),
    };

    const response = await this.client.request<WhopCheckoutConfiguration>({
      method: 'POST',
      path: '/checkout_configurations',
      operation: 'createCheckoutConfiguration',
      body,
      idempotencyKey: request.idempotencyKey,
      errorCode: 'PAYMENT_CREATE_FAILED',
    });

    // The docs list only 200 for this endpoint and explicitly warn against
    // asserting 201, so we assert the 2xx RANGE.
    if (response.status < 200 || response.status >= 300) {
      throw new AppError(
        `Whop checkout creation returned an unexpected status (${response.status})`,
        502,
        'PAYMENT_CREATE_FAILED',
        { details: { provider: 'whop', status: response.status, orderReference: request.orderReference } },
      );
    }

    const checkout = asRecord(response.data);
    const providerCheckoutId = asString(checkout?.id);
    if (!providerCheckoutId) {
      throw new AppError('Whop returned a checkout configuration without an id', 502, 'PAYMENT_CREATE_FAILED', {
        details: { provider: 'whop', orderReference: request.orderReference },
      });
    }

    // Whop normally returns `purchase_url`; rebuild it from the id only if the
    // field is absent, and never guess a different host.
    const checkoutUrl =
      asString(checkout?.purchase_url) ?? `${config.checkoutBaseUrl}/checkout/${providerCheckoutId}`;

    logger.info('Whop checkout configuration created', {
      orderReference: request.orderReference,
      providerCheckoutId,
      amountMinor: request.amountMinor,
      currency,
    });

    return { providerCheckoutId, checkoutUrl };
  }

  // --- Read ------------------------------------------------------------------

  async getPaymentStatus(providerPaymentId: string): Promise<ProviderPaymentDetails> {
    const payment = await this.fetchPayment(providerPaymentId);
    return this.toPaymentDetails(payment);
  }

  /**
   * AUTHORITATIVE verification. This — never the browser, never the webhook
   * payload alone — is what may mark a payment PAID (spec §8).
   */
  async verifyPayment(
    providerPaymentId: string,
    expected: Money,
  ): Promise<ProviderPaymentDetails> {
    const payment = await this.fetchPayment(providerPaymentId);
    const resourceId = asString(payment.id) ?? providerPaymentId;

    const total = whopMoneyToMinor(payment.total, { field: 'payment.total', resourceId });
    if (!total) {
      throw new AppError(
        `Whop payment ${providerPaymentId} has no total amount to verify against`,
        502,
        'PAYMENT_VERIFICATION_FAILED',
        { details: { provider: 'whop', providerPaymentId } },
      );
    }

    const expectedCurrency = asCurrency(expected.currency);
    if (total.amountMinor !== expected.amountMinor) {
      throw new AppError(
        `Whop payment ${providerPaymentId} amount does not match the order`,
        409,
        'AMOUNT_MISMATCH',
        {
          details: {
            provider: 'whop',
            providerPaymentId,
            expectedAmountMinor: expected.amountMinor,
            actualAmountMinor: total.amountMinor,
            currency: total.currency,
          },
        },
      );
    }

    if (expectedCurrency && total.currency !== expectedCurrency) {
      throw new AppError(
        `Whop payment ${providerPaymentId} currency does not match the order`,
        409,
        'CURRENCY_MISMATCH',
        {
          details: {
            provider: 'whop',
            providerPaymentId,
            expectedCurrency,
            actualCurrency: total.currency,
          },
        },
      );
    }

    return this.toPaymentDetails(payment, { amountOverride: total });
  }

  // --- Webhook ---------------------------------------------------------------

  /**
   * Verifies and normalises a Whop webhook.
   *
   * ORDER OF OPERATIONS, both mandatory:
   *   1. Signature over the EXACT received bytes. The body is never
   *      re-serialised — `JSON.parse` then `JSON.stringify` changes key order
   *      and whitespace, which changes the HMAC, which would make a perfectly
   *      valid webhook fail. It is only PARSED, for reading.
   *   2. Timestamp freshness (300 s per Whop's docs), enforced inside
   *      `verifyWhopSignature` only after the bytes are proven authentic.
   *
   * `valid: true` therefore REQUIRES both. Any failure returns
   * `{ valid: false, reason }` — this method never throws, so a hostile payload
   * cannot turn into an unhandled rejection in the route handler.
   */
  verifyWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string>,
  ): WebhookVerificationResult {
    const config = resolveWhopConfig();
    if (!config) {
      logger.error('Whop webhook rejected: integration NOT CONFIGURED', {
        provider: 'whop',
        hasWebhookId: Boolean(headerValue(headers, 'webhook-id')),
      });
      // MALFORMED rather than a fabricated success: without a secret the bytes
      // cannot be authenticated at all, and every reason code would be a lie.
      return { valid: false, reason: 'MALFORMED', diagnostics: {} };
    }

    const signature = verifyWhopSignature(rawBody, headers, config.webhookSecret);
    if (!signature.ok) {
      logger.warn('Whop webhook signature verification failed', {
        provider: 'whop',
        reason: signature.reason,
        webhookId: signature.webhookId,
        timestampAgeSeconds: signature.timestampAgeSeconds,
      });
      return {
        valid: false,
        reason: signature.reason ?? 'BAD_SIGNATURE',
        ...(signature.timestampAgeSeconds !== undefined
          ? { diagnostics: { timestampAgeSeconds: signature.timestampAgeSeconds } }
          : {}),
      };
    }

    // Reading only. The bytes above were already authenticated, so this parse
    // cannot change what was verified.
    const rawText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      logger.warn('Whop webhook body is not valid JSON', { provider: 'whop', webhookId: signature.webhookId });
      return { valid: false, reason: 'MALFORMED', diagnostics: {} };
    }

    const envelope = asRecord(parsed);
    const apiVersion = asString(envelope?.api_version);
    if (apiVersion && apiVersion.toLowerCase() !== 'v1') {
      // `v2`/`v5` envelopes are NOT Standard-Webhooks signed. Accepting one on
      // a passing v1 header scheme would mean accepting an unsigned payload.
      logger.warn('Whop webhook uses an unsupported envelope version', {
        provider: 'whop',
        apiVersion,
        eventType: asString(envelope?.type),
      });
      const envelopeType = asString(envelope?.type);
      return {
        valid: false,
        reason: 'UNSUPPORTED_VERSION',
        diagnostics: { ...(envelopeType ? { eventType: envelopeType } : {}) },
      };
    }

    const normalized = normalizeWhopWebhook(parsed, {
      ...(signature.webhookId ? { fallbackEventId: signature.webhookId } : {}),
    });
    if (!normalized.ok) {
      return {
        valid: false,
        reason: 'MALFORMED',
        diagnostics: { ...(normalized.diagnostics.eventType ? { eventType: normalized.diagnostics.eventType } : {}) },
      };
    }

    // Defence in depth: the configured account must own the event. A webhook
    // from another account on a shared endpoint must not touch our orders.
    const expectedAccountId = config.accountId;
    const actualAccountId = normalized.event.providerAccountId;
    if (expectedAccountId && actualAccountId && actualAccountId !== expectedAccountId) {
      logger.error('Whop webhook account does not match the configured account', {
        provider: 'whop',
        eventId: normalized.event.providerEventId,
        eventType: normalized.event.eventType,
      });
      return {
        valid: false,
        reason: 'BAD_SIGNATURE',
        diagnostics: { eventType: normalized.event.eventType },
      };
    }

    return {
      valid: true,
      event: normalized.event,
      diagnostics: {
        eventType: normalized.event.eventType,
        ...(signature.timestampAgeSeconds !== undefined
          ? { timestampAgeSeconds: signature.timestampAgeSeconds }
          : {}),
      },
    };
  }

  // --- Refunds ---------------------------------------------------------------

  async refundPayment(request: RefundRequest): Promise<RefundResult> {
    const config = requireWhopConfig();

    if (!request.providerPaymentId) {
      throw errors.validation('A provider payment id is required to refund');
    }
    if (!Number.isInteger(request.amountMinor) || request.amountMinor <= 0) {
      throw errors.validation('Refund amount must be a positive integer of minor units', {
        amountMinor: request.amountMinor,
      });
    }
    const currency = asCurrency(request.currency);
    if (!currency) throw errors.validation('A currency is required to refund');

    const body = {
      payment_id: request.providerPaymentId,
      // Same single wire-boundary conversion as checkout creation: Whop types
      // this as a number in major units.
      amount: minorToWhopPrice(request.amountMinor, currency),
      reason: toWhopRefundReason(request.reason),
    };

    try {
      const response = await this.client.request<WhopRefund>({
        method: 'POST',
        path: '/refunds',
        operation: 'createRefund',
        body,
        idempotencyKey: request.idempotencyKey,
        errorCode: 'PROVIDER_UNAVAILABLE',
      });

      const refund = asRecord(response.data);
      const refundId = asString(refund?.id);
      if (!refundId) {
        throw new AppError('Whop returned a refund without an id', 502, 'PROVIDER_UNAVAILABLE', {
          details: { provider: 'whop', providerPaymentId: request.providerPaymentId },
        });
      }

      const amount =
        whopMoneyToMinor(refund?.amount ?? refund?.original_amount, {
          field: 'refund.amount',
          resourceId: refundId,
        }) ?? { amountMinor: request.amountMinor, currency };

      const status = normalizeRefundStatus(refund?.status);
      const failureReason =
        asString(refund?.failure_reason) ?? asString(refund?.failure_message)?.slice(0, MAX_REASON_LENGTH);

      logger.info('Whop refund issued', {
        providerRefundId: refundId,
        providerPaymentId: request.providerPaymentId,
        amountMinor: amount.amountMinor,
        currency: amount.currency,
        status,
      });

      return {
        providerRefundId: refundId,
        status,
        amountMinor: amount.amountMinor,
        currency: amount.currency,
        ...(failureReason ? { failureReason } : {}),
      };
    } catch (error) {
      if (this.isRefundPermissionFailure(error)) {
        // Programmatic refunding is permission-gated on the Whop account. Do
        // NOT fake success and do NOT keep advertising a capability the account
        // does not have: mark it unsupported and surface a clear 502.
        this.capabilitiesImpl.supportsRefunds = false;
        logger.error('Whop refused a programmatic refund; disabling supportsRefunds', {
          provider: 'whop',
          providerPaymentId: request.providerPaymentId,
          accountId: config.accountId,
        });
        throw new AppError(
          `${WHOP_PROVIDER_NAME} refunds are not available for this account. Refund manually in the Whop dashboard.`,
          502,
          'PROVIDER_UNAVAILABLE',
          {
            details: {
              provider: 'whop',
              providerPaymentId: request.providerPaymentId,
              capability: 'supportsRefunds',
            },
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  /**
   * 403 FORBIDDEN, 404 (endpoint absent on this account's API surface) and 401
   * all mean "this account may not refund through the API", not "retry later".
   * A 5xx/429 is a transient upstream condition and is NOT treated as a
   * permission failure.
   */
  private isRefundPermissionFailure(error: unknown): boolean {
    if (!(error instanceof AppError)) return false;
    if (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND' || error.code === 'PAYMENT_NOT_CONFIGURED') {
      return true;
    }
    const upstream = error.details?.upstreamStatus;
    return typeof upstream === 'number' && (upstream === 401 || upstream === 403 || upstream === 404);
  }

  // --- Listing (reconciliation) ---------------------------------------------

  async listPayments(options: {
    from: Date;
    to: Date;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: ProviderPaymentDetails[]; nextCursor?: string }> {
    const config = requireWhopConfig();
    const response = await this.client.request<WhopPage<WhopPayment>>({
      method: 'GET',
      path: '/payments',
      operation: 'listPayments',
      query: {
        account_id: config.accountId,
        mode: 'account_sales',
        created_after: isoDate(options.from, 'from'),
        created_before: isoDate(options.to, 'to'),
        order: 'created_at',
        direction: 'desc',
        first: clampPageSize(options.limit),
        ...(options.cursor ? { after: options.cursor } : {}),
      },
    });

    const page = asRecord(response.data);
    const rows = Array.isArray(page?.data) ? (page.data as WhopPayment[]) : [];
    const items = rows
      .filter((row): row is WhopPayment => Boolean(asString(asRecord(row)?.id)))
      .map((row) => this.toPaymentDetails(row));

    const nextCursor = nextCursorFrom(pageInfoFrom(page?.page_info));

    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  async listRefunds(options: {
    from: Date;
    to: Date;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: RefundRecord[]; nextCursor?: string }> {
    const config = requireWhopConfig();
    const response = await this.client.request<WhopPage<WhopRefund>>({
      method: 'GET',
      path: '/refunds',
      operation: 'listRefunds',
      query: {
        account_id: config.accountId,
        created_after: isoDate(options.from, 'from'),
        created_before: isoDate(options.to, 'to'),
        order: 'created_at',
        direction: 'desc',
        first: clampPageSize(options.limit),
        ...(options.cursor ? { after: options.cursor } : {}),
      },
    });

    const page = asRecord(response.data);
    const rows = Array.isArray(page?.data) ? (page.data as WhopRefund[]) : [];
    const items = rows
      .map((row) => this.toRefundRecord(row))
      .filter((record): record is RefundRecord => record !== undefined);

    const nextCursor = nextCursorFrom(pageInfoFrom(page?.page_info));

    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  // --- Internals -------------------------------------------------------------

  private async fetchPayment(providerPaymentId: string): Promise<WhopPayment> {
    requireWhopConfig();
    if (!providerPaymentId) {
      throw errors.validation('A provider payment id is required');
    }
    // encodeURIComponent: the id comes from a webhook payload, so it is
    // untrusted input and must not be able to escape the /payments/ path.
    const response = await this.client.request<WhopPayment>({
      method: 'GET',
      path: `/payments/${encodeURIComponent(providerPaymentId)}`,
      operation: 'getPayment',
    });
    const payment = asRecord(response.data);
    if (!payment || !asString(payment.id)) {
      throw new AppError(`Whop returned no payment for ${providerPaymentId}`, 502, 'PAYMENT_VERIFICATION_FAILED', {
        details: { provider: 'whop', providerPaymentId },
      });
    }
    return payment as WhopPayment;
  }

  /**
   * Wire payment -> domain details.
   *
   * `netAmountMinor` comes from `amount_after_fees` ("what you keep") and
   * `feeMinor` from `total - amount_after_fees`. This is the WHOLE POINT on a
   * $3 SKU: Whop's 2.7% + $0.30 is ~38c of a $3.00 sale, and a dashboard that
   * reported `total` as revenue would overstate margin by more than 10%.
   * When Whop has not populated `amount_after_fees`, both stay undefined —
   * "margin unknown", never "margin equals gross".
   */
  private toPaymentDetails(
    payment: WhopPayment,
    options: { amountOverride?: { amountMinor: number; currency: string } } = {},
  ): ProviderPaymentDetails {
    const providerPaymentId = asString(payment.id) ?? '';
    const amount =
      options.amountOverride ??
      whopMoneyToMinor(payment.total, { field: 'payment.total', resourceId: providerPaymentId });

    const net = computeNetAndFee(payment as unknown as Record<string, unknown>, {
      field: 'payment',
      resourceId: providerPaymentId,
    });

    const refunded = whopMoneyToMinor(payment.refunded_amount, {
      field: 'payment.refunded_amount',
      resourceId: providerPaymentId,
    });

    const verification = paymentVerificationFromStatus(payment);
    const card = cardDescriptor(payment);
    const metadata = asStringRecord(payment.metadata);
    const paidAt = asDate(payment.paid_at);

    // Brand + last4 ride INSIDE the PAID verification and only for a captured
    // charge: attaching them to a failed/void payment would put a card brand on
    // a record for money that never moved. Whop never returns a PAN and this
    // class has no field that could hold one.
    const status: PaymentVerification =
      verification.status === 'PAID' && card ? { ...verification, ...card } : verification;

    return {
      providerPaymentId,
      status,
      ...(amount ? { amountMinor: amount.amountMinor, currency: amount.currency } : {}),
      ...(net ? { netAmountMinor: net.net.amountMinor, feeMinor: net.feeMinor } : {}),
      ...(refunded ? { refundedAmountMinor: refunded.amountMinor } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(status.status === 'PAID' && paidAt ? { paidAt } : {}),
    };
  }

  private toRefundRecord(refund: WhopRefund): RefundRecord | undefined {
    const record = asRecord(refund);
    const providerRefundId = asString(record?.id);
    const providerPaymentId = asString(record?.payment_id);
    if (!providerRefundId || !providerPaymentId) return undefined;

    const amount = whopMoneyToMinor(record?.amount ?? record?.original_amount, {
      field: 'refund.amount',
      resourceId: providerRefundId,
    });
    const status: WhopRefundStatus = normalizeRefundStatus(record?.status);
    const createdAt = asDate(record?.created_at) ?? new Date(0);
    const reason = asString(record?.reason);

    return {
      providerRefundId,
      providerPaymentId,
      amountMinor: amount?.amountMinor ?? 0,
      currency: amount?.currency ?? 'usd',
      status,
      createdAt,
      ...(reason ? { reason } : {}),
    };
  }
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/** Fresh instance — used by tests and by anything that injects a client. */
export function createWhopPaymentProvider(client: WhopClient = whopClient): WhopPaymentProvider {
  return new WhopPaymentProvider(client);
}

/**
 * Process-wide provider. Constructing it is always safe: an unconfigured Whop
 * surfaces as `status === 'NOT_CONFIGURED'` and throws only when a method that
 * genuinely needs Whop is called.
 */
export const whopPaymentProvider: WhopPaymentProvider = new WhopPaymentProvider();