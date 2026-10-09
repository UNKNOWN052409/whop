/**
 * Whop webhook signature verification — the critical security boundary.
 *
 * The fixture signer in tests/helpers/whop-fixtures.ts is an INDEPENDENT
 * transcription of WHOP_API_REFERENCE.md §3, built directly on node:crypto, so
 * every assertion here compares the application against the reference rather
 * than against itself.
 *
 *   signed = `${webhook-id}.${webhook-timestamp}.${raw body}`
 *   key    = the RAW UTF-8 bytes of the whole `ws_…` secret (prefix INCLUDED,
 *            NOT base64-decoded)
 *   sig    = base64( HMAC-SHA256(key, signed) )
 *   header = `v1,` + sig
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSignedMessage, parseSignatureHeader, verifyWhopSignature } from '@/payments/whop/signature';
import { hmacSha256Base64 } from '@/lib/crypto';
import {
  FIXTURE_SECRET,
  FIXTURE_TIMESTAMP,
  FIXTURE_WEBHOOK_ID,
  FIXTURE_WRONG_SECRET,
  FIXTURE_BODY,
  buildEnvelope,
  paymentObject,
  signReference,
  signedHeaders,
  tamperedBody,
} from './helpers/whop-fixtures';

/** Ten years: isolates the signature check from the clock in the replay tests. */
const NO_TOLERANCE_LIMIT = 10 * 365 * 24 * 60 * 60;

function headersFor(body: string, options: { secret?: string; timestamp?: number } = {}) {
  const secret = options.secret ?? FIXTURE_SECRET;
  const timestamp = options.timestamp ?? FIXTURE_TIMESTAMP;
  const signature = signReference(secret, FIXTURE_WEBHOOK_ID, timestamp, body);
  return {
    'webhook-id': FIXTURE_WEBHOOK_ID,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`,
    'content-type': 'application/json',
  };
}

beforeEach(() => {
  // Freeze the clock at the fixture timestamp so the replay tests are exact
  // rather than dependent on the day the suite happens to run.
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_TIMESTAMP * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the signing algorithm itself', () => {
  it('reproduces the reference HMAC byte for byte', () => {
    const appSignature = hmacSha256Base64(
      FIXTURE_SECRET,
      buildSignedMessage(FIXTURE_WEBHOOK_ID, String(FIXTURE_TIMESTAMP), Buffer.from(FIXTURE_BODY, 'utf8')),
    );
    expect(appSignature).toBe(signReference(FIXTURE_SECRET, FIXTURE_WEBHOOK_ID, FIXTURE_TIMESTAMP, FIXTURE_BODY));
    expect(appSignature).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('signs the raw body bytes, and the fixture body is reproducible', () => {
    // Re-serialising parsed JSON changes key order/whitespace and therefore the
    // signature. buildEnvelope() is byte-identical run to run, which is what
    // makes the reference signature reproducible.
    expect(JSON.stringify(buildEnvelope())).toBe(FIXTURE_BODY);
    expect(buildSignedMessage(FIXTURE_WEBHOOK_ID, String(FIXTURE_TIMESTAMP), Buffer.from(FIXTURE_BODY, 'utf8')).length).toBe(
      `${FIXTURE_WEBHOOK_ID}.${FIXTURE_TIMESTAMP}.`.length + Buffer.byteLength(FIXTURE_BODY, 'utf8'),
    );
    // The payload really is the $3-for-$1 payment from the fixtures.
    expect(FIXTURE_BODY).toContain('"amount":"3.00"');
    expect(JSON.parse(FIXTURE_BODY)).toMatchObject({ data: { metadata: { orderReference: 'ORD-7QK2M4XB' } } });
  });
});

describe('verifyWhopSignature — valid deliveries', () => {
  it('accepts a correctly signed, fresh webhook', () => {
    const result = verifyWhopSignature(FIXTURE_BODY, headersFor(FIXTURE_BODY), FIXTURE_SECRET);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.webhookId).toBe(FIXTURE_WEBHOOK_ID);
    expect(result.timestamp).toBe(FIXTURE_TIMESTAMP);
    expect(result.timestampAgeSeconds).toBe(0);
  });

  it('accepts a Buffer body as well as a string', () => {
    const result = verifyWhopSignature(
      Buffer.from(FIXTURE_BODY, 'utf8'),
      headersFor(FIXTURE_BODY),
      FIXTURE_SECRET,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a rotated header carrying an old and a new signature', () => {
    const current = signReference(FIXTURE_SECRET, FIXTURE_WEBHOOK_ID, FIXTURE_TIMESTAMP, FIXTURE_BODY);
    const previous = signReference(FIXTURE_WRONG_SECRET, FIXTURE_WEBHOOK_ID, FIXTURE_TIMESTAMP, FIXTURE_BODY);
    const result = verifyWhopSignature(
      FIXTURE_BODY,
      { ...headersFor(FIXTURE_BODY), 'webhook-signature': `v1,${previous} v1,${current}` },
      FIXTURE_SECRET,
    );
    expect(result.ok).toBe(true);
  });

  it('uses the whole ws_ secret, prefix included, and does not base64-decode it', () => {
    const signature = signReference(FIXTURE_SECRET, FIXTURE_WEBHOOK_ID, FIXTURE_TIMESTAMP, FIXTURE_BODY);
    const headers = headersFor(FIXTURE_BODY);

    // The two classic mistakes both produce garbage keys and must fail.
    expect(verifyWhopSignature(FIXTURE_BODY, headers, FIXTURE_SECRET.slice(3), 1).ok).toBe(false);
    expect(
      verifyWhopSignature(FIXTURE_BODY, headers, Buffer.from(FIXTURE_SECRET, 'base64').toString('utf8'), 1)
        .ok,
    ).toBe(false);
    expect(signature).not.toBe(
      signReference(FIXTURE_SECRET.slice(3), FIXTURE_WEBHOOK_ID, FIXTURE_TIMESTAMP, FIXTURE_BODY),
    );
  });
});

describe('verifyWhopSignature — rejections', () => {
  it('FAILS a tampered body', () => {
    // Signed over the original body, delivered with the altered amount.
    const result = verifyWhopSignature(
      tamperedBody(),
      headersFor(FIXTURE_BODY),
      FIXTURE_SECRET,
      NO_TOLERANCE_LIMIT,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('BAD_SIGNATURE');
  });

  it('FAILS the wrong secret', () => {
    const body = JSON.stringify(buildEnvelope({ data: paymentObject({ total: { amount: '3.00', currency: 'usd' } }) }));
    const signedWithWrongSecret = headersFor(body, { secret: FIXTURE_WRONG_SECRET });
    const result = verifyWhopSignature(body, signedWithWrongSecret, FIXTURE_SECRET, NO_TOLERANCE_LIMIT);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('BAD_SIGNATURE');
  });

  it('FAILS a timestamp outside the tolerance (replay protection)', () => {
    // The signature is authentic; only the freshness window rejects it.
    const headers = headersFor(FIXTURE_BODY);
    vi.setSystemTime((FIXTURE_TIMESTAMP + 301) * 1000);
    const result = verifyWhopSignature(FIXTURE_BODY, headers, FIXTURE_SECRET);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('TIMESTAMP_OUT_OF_RANGE');
    expect(result.timestampAgeSeconds).toBe(301);

    // Far in the past is rejected too.
    vi.setSystemTime((FIXTURE_TIMESTAMP - 86_400) * 1000);
    const old = verifyWhopSignature(FIXTURE_BODY, headers, FIXTURE_SECRET);
    expect(old.ok).toBe(false);
    expect(old.reason).toBe('TIMESTAMP_OUT_OF_RANGE');
  });

  it('accepts a timestamp just inside the tolerance', () => {
    vi.setSystemTime((FIXTURE_TIMESTAMP + 299) * 1000);
    expect(verifyWhopSignature(FIXTURE_BODY, headersFor(FIXTURE_BODY), FIXTURE_SECRET).ok).toBe(true);
  });

  it('FAILS a non-v1 scheme outright', () => {
    const headers = { ...headersFor(FIXTURE_BODY), 'webhook-signature': 'v2,' + 'A'.repeat(44) };
    const result = verifyWhopSignature(FIXTURE_BODY, headers, FIXTURE_SECRET, NO_TOLERANCE_LIMIT);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('UNSUPPORTED_VERSION');

    // A rotation header that mixes v1 with v2 is rejected as a whole: accepting
    // it would mean accepting an unsigned payload.
    const mixed = {
      ...headersFor(FIXTURE_BODY),
      'webhook-signature': `v1,${signReference(FIXTURE_SECRET, FIXTURE_WEBHOOK_ID, FIXTURE_TIMESTAMP, FIXTURE_BODY)},v2,${'A'.repeat(44)}`,
    };
    expect(verifyWhopSignature(FIXTURE_BODY, mixed, FIXTURE_SECRET, NO_TOLERANCE_LIMIT).reason).toBe(
      'UNSUPPORTED_VERSION',
    );
  });

  it('FAILS missing or malformed headers', () => {
    const good = headersFor(FIXTURE_BODY);

    expect(verifyWhopSignature(FIXTURE_BODY, { ...good, 'webhook-id': '' }, FIXTURE_SECRET).reason).toBe(
      'MALFORMED',
    );
    const noSignature = { ...good } as Record<string, string>;
    delete noSignature['webhook-signature'];
    expect(verifyWhopSignature(FIXTURE_BODY, noSignature, FIXTURE_SECRET).reason).toBe('MALFORMED');
    expect(
      verifyWhopSignature(FIXTURE_BODY, { ...good, 'webhook-timestamp': '1.7e9' }, FIXTURE_SECRET).reason,
    ).toBe('MALFORMED');
    expect(
      verifyWhopSignature(FIXTURE_BODY, { ...good, 'webhook-signature': '' }, FIXTURE_SECRET).reason,
    ).toBe('MALFORMED');
    expect(verifyWhopSignature(FIXTURE_BODY, good, '').reason).toBe('MALFORMED');
  });

  it('reads headers case-insensitively', () => {
    const headers = headersFor(FIXTURE_BODY);
    const upper = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toUpperCase(), value]),
    );
    expect(verifyWhopSignature(FIXTURE_BODY, upper, FIXTURE_SECRET).ok).toBe(true);
  });
});

describe('parseSignatureHeader', () => {
  it('handles every shape Whop and standard-webhooks emit', () => {
    expect(parseSignatureHeader('v1,abc').schemes).toEqual(['v1']);
    expect(parseSignatureHeader('v1,abc v1,def').values).toEqual(['abc', 'def']);
    expect(parseSignatureHeader('v1,abc,v1,def').values).toEqual(['abc', 'def']);
    expect(parseSignatureHeader('v1,abc, v1,def').values).toEqual(['abc', 'def']);
    expect(parseSignatureHeader('abc').schemes).toEqual(['v1']);
    expect(parseSignatureHeader('v1,').malformed).toBe(true);
    expect(parseSignatureHeader('').malformed).toBe(true);
  });
});

describe('the shared fixture helper', () => {
  it('produces headers the verifier accepts', () => {
    const result = verifyWhopSignature(
      FIXTURE_BODY,
      signedHeaders({
        signature: signReference(FIXTURE_SECRET, FIXTURE_WEBHOOK_ID, FIXTURE_TIMESTAMP, FIXTURE_BODY),
      }),
      FIXTURE_SECRET,
    );
    expect(result.ok).toBe(true);
  });
});