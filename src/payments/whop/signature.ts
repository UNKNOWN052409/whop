/**
 * Whop webhook signature verification. THE CRITICAL FILE IN THIS ADAPTER.
 *
 * Whop implements the Standard Webhooks spec. The exact algorithm, verified
 * against Whop's own published SDK (`@whop/sdk@2.2.0/dist/esm/helpers/
 * verifyWebhook.mjs`) and the webhooks guide:
 *
 *   key        = the RAW UTF-8 BYTES OF THE ENTIRE `ws_…` secret string
 *   message    = webhook-id + "." + webhook-timestamp + "." + RAW BODY BYTES
 *   signature  = base64( HMAC-SHA256(key, message) )
 *   header     = "v1,<signature>"  (possibly several, comma- or space-separated,
 *                during secret rotation)
 *
 * THE FOUR THINGS PEOPLE GET WRONG, all handled explicitly below:
 *
 *   1. Do NOT strip the `ws_` prefix from the key. Whop's backend passes the
 *      literal secret string to OpenSSL::HMAC — prefix included. The SDK
 *      base64-*encodes* the secret only because `standard-webhooks`
 *      base64-*decodes* whatever key it is handed, and the two cancel out.
 *   2. Do NOT base64-decode the secret. `Buffer.from(secret, 'base64')` on a
 *      `ws_…` string yields garbage and every signature fails.
 *   3. Do NOT re-serialise the JSON. `JSON.parse` -> `JSON.stringify` changes
 *      key order and whitespace, which changes the bytes, which changes the
 *      HMAC. We concatenate the ORIGINAL Buffer.
 *   4. `webhook-timestamp` is Unix SECONDS, is part of the signed message, and
 *      must be within tolerance (300 s per Whop's docs) or the event is a
 *      replay.
 *
 * Also: a signature scheme other than `v1` is REJECTED outright rather than
 * ignored. `api_version: "v2"`/`"v5"` envelopes do not use Standard Webhooks
 * signatures at all, so accepting them on a `v2` header scheme would be
 * accepting an unsigned payload.
 */

import { hmacSha256Base64, verifySignatureList } from '@/lib/crypto';
import { appConfig } from '@/lib/env';

export const WHOP_SIGNATURE_SCHEME = 'v1';

export type WhopSignatureFailure =
  | 'BAD_SIGNATURE'
  | 'TIMESTAMP_OUT_OF_RANGE'
  | 'MALFORMED'
  | 'UNSUPPORTED_VERSION';

export interface WhopSignatureResult {
  ok: boolean;
  /** Populated only when ok. */
  webhookId?: string;
  /** The `webhook-timestamp` header, in Unix seconds. */
  timestamp?: number;
  /** Seconds between the signed timestamp and now (absolute). */
  timestampAgeSeconds?: number;
  /** Populated when !ok. */
  reason?: WhopSignatureFailure;
}

type HeaderBag = Record<string, string> | Headers | Iterable<[string, string]>;

/** Header names are case-insensitive; Next.js lowercases, tests may not. */
function readHeader(headers: HeaderBag, headerName: string): string | undefined {
  const wanted = headerName.toLowerCase();
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(headerName) ?? undefined;
  }
  if (Symbol.iterator in Object(headers)) {
    for (const [key, value] of headers as Iterable<[string, string]>) {
      if (key.toLowerCase() === wanted) return value;
    }
    return undefined;
  }
  const record = headers as Record<string, string>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

interface ParsedSignatureHeader {
  schemes: string[];
  values: string[];
  malformed: boolean;
}

const SCHEME_TOKEN = /^v\d+$/i;

/**
 * Parses `webhook-signature` into its (scheme, value) pairs.
 *
 * Accepts every shape Whop or standard-webhooks can emit:
 *   `v1,abc`
 *   `v1,abc v1,def`          (standard-webhooks, space separated)
 *   `v1,abc,v1,def`          (Whop docs, comma separated rotation)
 *   `v1,abc, v1,def`         (mixed, as seen during rotation)
 *   `abc`                    (bare value, implied v1)
 *
 * Whop's base64 alphabet is `A-Za-z0-9+/=` — it can never contain a comma or
 * whitespace — so splitting on both separators is unambiguous.
 */
export function parseSignatureHeader(raw: string): ParsedSignatureHeader {
  const tokens = raw.split(/[,\s]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return { schemes: [], values: [], malformed: true };

  if (!SCHEME_TOKEN.test(tokens[0] ?? '')) {
    // No scheme prefix anywhere: treat every token as a bare v1 value.
    return { schemes: tokens.map(() => WHOP_SIGNATURE_SCHEME), values: tokens, malformed: false };
  }

  const schemes: string[] = [];
  const values: string[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const scheme = tokens[index];
    const value = tokens[index + 1];
    if (scheme === undefined || value === undefined || !SCHEME_TOKEN.test(scheme)) {
      return { schemes, values, malformed: true };
    }
    schemes.push(scheme.toLowerCase());
    values.push(value);
  }
  return { schemes, values, malformed: false };
}

/**
 * The exact bytes Whop signed: `<id>.<timestamp>.` followed by the RAW body.
 *
 * Built with Buffer.concat rather than template-string interpolation so that a
 * body containing invalid UTF-8 bytes is preserved byte-for-byte. A UTF-8 round
 * trip would replace those bytes with U+FFFD and silently break the HMAC.
 */
export function buildSignedMessage(webhookId: string, timestamp: string, rawBody: Buffer): Buffer {
  const prefix = Buffer.from(`${webhookId}.${timestamp}.`, 'utf8');
  return Buffer.concat([prefix, rawBody], prefix.length + rawBody.length);
}

function toBuffer(rawBody: Buffer | string): Buffer {
  return Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Verifies a Whop webhook.
 *
 * ORDER OF CHECKS: signature first, then the timestamp window. That matches
 * standard-webhooks. It is also the safer order — `webhook-timestamp` is part of
 * the signed message, so an attacker cannot choose it freely, and validating
 * freshness only AFTER the bytes are proven authentic means the replay window
 * is never consulted on unauthenticated input.
 *
 * NEVER returns ok:true without a passing constant-time signature comparison.
 */
export function verifyWhopSignature(
  rawBody: Buffer | string,
  headers: HeaderBag,
  secret: string,
  toleranceSeconds: number = appConfig.webhookToleranceSeconds,
): WhopSignatureResult {
  if (!secret) {
    return { ok: false, reason: 'MALFORMED' };
  }

  const webhookId = readHeader(headers, 'webhook-id')?.trim();
  const timestampRaw = readHeader(headers, 'webhook-timestamp')?.trim();
  const signatureHeader = readHeader(headers, 'webhook-signature')?.trim();

  if (!webhookId || !timestampRaw || !signatureHeader) {
    return { ok: false, reason: 'MALFORMED' };
  }

  // Unix SECONDS as an integer. Reject "1.7e9", "+1786381404", " 12 34" etc.
  // rather than letting Number() coerce them into something plausible.
  if (!/^\d{1,15}$/.test(timestampRaw)) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const timestamp = Number(timestampRaw);

  const parsed = parseSignatureHeader(signatureHeader);
  if (parsed.malformed || parsed.values.length === 0) {
    return { ok: false, reason: 'MALFORMED' };
  }
  // Reject the whole header if ANY scheme is not v1. v2/v5 envelopes are not
  // Standard-Webhooks signed, so tolerating them would mean accepting an
  // unsigned payload.
  if (parsed.schemes.some((scheme) => scheme !== WHOP_SIGNATURE_SCHEME)) {
    return { ok: false, reason: 'UNSUPPORTED_VERSION' };
  }

  const expected = hmacSha256Base64(
    // The WHOLE secret, prefix included, UTF-8 encoded. See the file header.
    secret,
    buildSignedMessage(webhookId, timestampRaw, toBuffer(rawBody)),
  );

  // Constant-time comparison across every candidate, so rotation does not leak
  // which signature matched through timing.
  if (!verifySignatureList(parsed.values.join(','), expected, WHOP_SIGNATURE_SCHEME)) {
    return { ok: false, reason: 'BAD_SIGNATURE', webhookId, timestamp };
  }

  const ageSeconds = Math.abs(nowSeconds() - timestamp);
  const tolerance = Number.isFinite(toleranceSeconds) && toleranceSeconds > 0 ? toleranceSeconds : 300;
  if (ageSeconds > tolerance) {
    return {
      ok: false,
      reason: 'TIMESTAMP_OUT_OF_RANGE',
      webhookId,
      timestamp,
      timestampAgeSeconds: ageSeconds,
    };
  }

  return { ok: true, webhookId, timestamp, timestampAgeSeconds: ageSeconds };
}
