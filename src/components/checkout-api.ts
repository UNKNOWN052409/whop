/**
 * Browser-side API client for checkout and order status.
 *
 * Deliberately defensive about response shapes: this module is the only place
 * that talks to the checkout API, and it accepts either a flat response or one
 * nested under `data`. It NEVER reads, stores or returns any field that could
 * hold a redeem code — the browser has no use for one and must not hold one.
 */

export interface CheckoutRequest {
  productId: string;
  quantity: number;
  email: string;
  paymentMethod: string;
}

export interface CheckoutSuccess {
  checkoutUrl: string;
  reference?: string;
  orderId?: string;
}

export class CheckoutApiError extends Error {
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(message: string, code = 'UNKNOWN', retryAfterSeconds?: number) {
    super(message);
    this.name = 'CheckoutApiError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** POST /api/checkout -> the provider's hosted checkout URL. */
export async function createCheckout(request: CheckoutRequest): Promise<CheckoutSuccess> {
  let response: Response;
  try {
    response = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    throw new CheckoutApiError('Could not reach the checkout service. Please try again.', 'NETWORK');
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const body = isRecord(payload) ? payload : {};
    const message =
      readString(body, 'error') ?? readString(body, 'message') ?? `Checkout failed (${response.status})`;
    const retry = body['retryAfterSeconds'];
    throw new CheckoutApiError(
      message,
      readString(body, 'code') ?? `HTTP_${response.status}`,
      typeof retry === 'number' ? retry : undefined,
    );
  }

  const body = isRecord(payload) ? payload : {};
  const nested = isRecord(body['data']) ? (body['data'] as Record<string, unknown>) : body;
  const checkoutUrl = readString(nested, 'checkoutUrl') ?? readString(nested, 'url');

  if (!checkoutUrl) {
    throw new CheckoutApiError(
      'The checkout service did not return a payment link. Please try again.',
      'MALFORMED_RESPONSE',
    );
  }

  return {
    checkoutUrl,
    reference: readString(nested, 'reference') ?? readString(nested, 'orderReference'),
    orderId: readString(nested, 'orderId'),
  };
}

/**
 * Customer-visible order phases. Derived from the order/payment status the
 * server reports; never from anything the browser asserts about itself.
 */
export type OrderPhase =
  | 'PROCESSING'
  | 'PAID'
  | 'DELIVERED'
  | 'FAILED'
  | 'CANCELED'
  | 'REVERSED'
  | 'REVIEW';

export interface OrderStatusResult {
  phase: OrderPhase;
  /** Raw status string, shown so support can quote it. Never a code. */
  statusLabel: string;
  found: boolean;
}

const DELIVERED = new Set(['CODE_DELIVERED', 'COMPLETED', 'DELIVERED', 'SENT']);
const PAID = new Set(['PAID', 'PAYMENT_VERIFIED', 'AUTHORIZED', 'PAYMENT_SUCCEEDED', 'SUCCEEDED']);
const PROCESSING = new Set([
  'CREATED',
  'PAYMENT_PENDING',
  'PENDING',
  'REQUIRES_ACTION',
  'PAYMENT_PROCESSING',
  'FULFILLMENT_PENDING',
  'CODE_RESERVED',
  'PROCESSING',
]);
const FAILED = new Set(['FAILED', 'PAYMENT_FAILED', 'FULFILLMENT_FAILED']);
const CANCELED = new Set(['CANCELLED', 'CANCELED', 'PAYMENT_EXPIRED', 'EXPIRED']);
const REVERSED = new Set(['REVERSED', 'PAYMENT_REVERSED', 'REFUNDED', 'REFUND_PENDING']);
const REVIEW = new Set(['MANUAL_REVIEW', 'UNDER_REVIEW']);

function toPhase(raw: string): OrderPhase | null {
  const status = raw.trim().toUpperCase();
  if (DELIVERED.has(status)) return 'DELIVERED';
  if (PAID.has(status)) return 'PAID';
  if (PROCESSING.has(status)) return 'PROCESSING';
  if (FAILED.has(status)) return 'FAILED';
  if (CANCELED.has(status)) return 'CANCELED';
  if (REVERSED.has(status)) return 'REVERSED';
  if (REVIEW.has(status)) return 'REVIEW';
  return null;
}

/**
 * GET /api/payments/status?reference=...
 *
 * Reads only status-shaped fields. Any code-like field in the response is
 * ignored by construction: this function returns a phase and a label, and
 * nothing else can reach the DOM.
 */
export async function fetchOrderStatus(reference: string): Promise<OrderStatusResult> {
  const response = await fetch(`/api/payments/status?reference=${encodeURIComponent(reference)}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });

  if (response.status === 404) {
    return { phase: 'PROCESSING', statusLabel: 'NOT_FOUND', found: false };
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const body = isRecord(payload) ? payload : {};
    throw new CheckoutApiError(
      readString(body, 'error') ?? `Status check failed (${response.status})`,
      readString(body, 'code') ?? `HTTP_${response.status}`,
    );
  }

  const body = isRecord(payload) ? payload : {};
  const nested = isRecord(body['data']) ? (body['data'] as Record<string, unknown>) : body;

  const candidates = [
    readString(nested, 'status'),
    readString(nested, 'orderStatus'),
    readString(nested, 'paymentStatus'),
    readString(nested, 'state'),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const phase = toPhase(candidate);
    if (phase) return { phase, statusLabel: candidate, found: true };
  }

  return { phase: 'PROCESSING', statusLabel: 'UNKNOWN', found: true };
}