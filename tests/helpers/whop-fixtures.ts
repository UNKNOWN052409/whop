/**
 * Whop webhook fixtures, built by hand from WHOP_API_REFERENCE.md §3 and §4.
 *
 * THE SIGNING SCHEME (the part that is subtle, and the part this file exists to
 * pin down):
 *
 *   signed = `${webhook-id}.${webhook-timestamp}.${raw request body}`
 *   key    = the RAW UTF-8 BYTES of the whole `ws_…` secret, prefix INCLUDED
 *   sig    = base64( HMAC-SHA256(key, signed) )
 *   header = `v1,` + sig
 *
 * Three ways this is commonly got wrong, each with its own regression test:
 *   1. base64-decoding the secret before using it as the HMAC key (Whop does not;
 *      the SDK does this only to cancel out standard-webhooks' own decoding).
 *   2. stripping the `ws_` prefix.
 *   3. re-serialising the parsed JSON instead of signing the received bytes.
 *
 * `signReference` below is an INDEPENDENT implementation written straight from
 * the reference doc using node:crypto. It is the oracle: every assertion about
 * the application's own HMAC helper is made against it, so a change to
 * src/lib/crypto.ts cannot quietly redefine "correct".
 */

import { createHmac } from 'node:crypto';

// --- Test-only credentials ---------------------------------------------------
// Obviously fake, prefixed `ws_`, generated for this suite. Not a secret and not
// derived from any real account — see tests/setup.ts for why no key literal is
// committed anywhere in this repository.
export const FIXTURE_SECRET = 'ws_TESTFIXTURE_NOT_A_REAL_SECRET_0123456789abcdef';

/** A different fake secret, used to prove a wrong-secret signature is rejected. */
export const FIXTURE_WRONG_SECRET = 'ws_TESTFIXTURE_WRONG_SECRET_fedcba9876543210';

/** From the docs example: `webhook-id: msg_bQPHmO2eBnHYtWWuxAN9K3Xd`. */
export const FIXTURE_WEBHOOK_ID = 'msg_TESTFIXTURE000000000000000001';

/** Frozen Unix-seconds timestamp. Using a constant (rather than `Date.now()`)
 *  is what allows the expected signature below to be a hard-coded literal. */
export const FIXTURE_TIMESTAMP = 1786381404;

/**
 * The full Payment object for a $3 purchase of a $1 code — the markup catalog,
 * never inverted. Whop returns money as DECIMAL STRINGS in major units.
 */
export function paymentObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pay_TESTPAYMENT000000000001',
    account_id: 'biz_TESTACCOUNT00000001',
    status: 'paid',
    substatus: 'succeeded',
    total: { amount: '3.00', currency: 'usd', decimals: 2, display_decimals: 2 },
    amount_after_fees: { amount: '2.19', currency: 'usd', decimals: 2, display_decimals: 2 },
    subtotal: { amount: '3.00', currency: 'usd', decimals: 2, display_decimals: 2 },
    currency: 'usd',
    metadata: { orderReference: 'ORD-7QK2M4XB', orderId: 'order_test_00000001' },
    checkout_configuration_id: 'ch_TESTCHECKOUT0000000001',
    customer_email: 'buyer@example.com',
    payment_method_type: 'card',
    payment_instrument: {
      payment_method_type: 'card',
      display_name: 'Visa ending in 4242',
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    },
    paid_at: '2026-10-08T17:03:24.291Z',
    created_at: '2026-10-08T17:02:58.000Z',
    updated_at: '2026-10-08T17:03:24.291Z',
    ...overrides,
  };
}

/** Standard Webhooks envelope. `data` is the full Payment object for payment.*. */
export function buildEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FIXTURE_WEBHOOK_ID,
    type: 'payment.succeeded',
    api_version: 'v1',
    api_version_date: '2026-08-14',
    timestamp: '2026-10-08T17:03:24.291Z',
    account_id: 'biz_TESTACCOUNT00000001',
    data: paymentObject(),
    ...overrides,
  };
}

/**
 * The exact bytes a provider would put on the wire. Property insertion order is
 * preserved by JSON.stringify, so this is stable across runs.
 */
export const FIXTURE_BODY: string = JSON.stringify(buildEnvelope());

/**
 * KNOWN-GOOD signature: the expected value for FIXTURE_SECRET / FIXTURE_WEBHOOK_ID
 * / FIXTURE_TIMESTAMP / FIXTURE_BODY, computed once from the algorithm in
 * WHOP_API_REFERENCE.md. `tests/unit/whop-webhook.test.ts` asserts that the
 * application's HMAC helper reproduces this literal byte for byte.
 */
export const FIXTURE_SIGNATURE = '__COMPUTED__';

/** `v1,<sig>` — the documented single-entry header format. */
export const FIXTURE_SIGNATURE_HEADER = `v1,${FIXTURE_SIGNATURE}`;

/**
 * Independent reference signer, transcribed from the reference doc:
 *
 *   key  = WHOP_WEBHOOK_SECRET.encode("utf-8")   // whole string, prefix kept
 *   msg  = f"{webhook_id}.{webhook_ts}.{raw_body}"
 *   sig  = base64.b64encode(hmac.new(key, msg, sha256).digest())
 */
export function signReference(
  secret: string,
  webhookId: string,
  timestamp: number,
  rawBody: string,
): string {
  const key = Buffer.from(secret, 'utf8');
  const message = `${webhookId}.${timestamp}.${rawBody}`;
  return createHmac('sha256', key).update(message, 'utf8').digest('base64');
}

/** Headers for a valid, fresh delivery. */
export function signedHeaders(options: {
  secret?: string;
  webhookId?: string;
  timestamp?: number;
  body?: string;
  signature?: string;
  scheme?: string;
  additionalSignatures?: string[];
} = {}): Record<string, string> {
  const secret = options.secret ?? FIXTURE_SECRET;
  const webhookId = options.webhookId ?? FIXTURE_WEBHOOK_ID;
  const timestamp = options.timestamp ?? FIXTURE_TIMESTAMP;
  const body = options.body ?? FIXTURE_BODY;
  const signature =
    options.signature ?? (options.timestamp === undefined && options.body === undefined ? FIXTURE_SIGNATURE : signReference(secret, webhookId, timestamp, body));
  const scheme = options.scheme ?? 'v1';
  const extras = options.additionalSignatures ?? [];
  const headerValue = [scheme, signature, ...extras].join(',');
  return {
    'webhook-id': webhookId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': headerValue,
    'content-type': 'application/json',
  };
}

/** A body whose amount has been altered — signature must no longer match. */
export function tamperedBody(): string {
  const envelope = buildEnvelope();
  const data = envelope['data'] as Record<string, unknown>;
  const total = data['total'] as Record<string, unknown>;
  return JSON.stringify({
    ...envelope,
    data: { ...data, total: { ...total, amount: '0.01' } },
  });
}

/**
 * The same payment in a non-paid state. `status`/`substatus` are the two fields
 * that decide the normalised outcome; a webhook is not "succeeded" because the
 * event is named payment.succeeded, but because the payment says it is paid.
 */
export function pendingPaymentBody(): string {
  return JSON.stringify(
    buildEnvelope({
      type: 'payment.pending',
      data: paymentObject({ status: 'pending', substatus: 'pending', paid_at: null }),
    }),
  );
}
