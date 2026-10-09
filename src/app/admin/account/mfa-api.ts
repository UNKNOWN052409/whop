/**
 * Browser client for `POST /api/auth/mfa/enrol`.
 *
 * This module is the ONLY place in the UI that talks to the enrolment route, and
 * it is written so that the page cannot accidentally do anything the route does
 * not permit. It does not generate codes, does not derive secrets, and has no
 * fallback path: an unconfigured deployment surfaces the route's own 503 rather
 * than a fabricated success.
 *
 * CSRF
 *   The route CSRF-checks EVERY branch, including `confirm` (which needs no
 *   password). `@/auth/csrf` accepts a double-submit compare when the
 *   `rdm_csrf` cookie is present, and falls back to a strict same-origin check
 *   when it is not. So this client reads the cookie and echoes it in
 *   `x-csrf-token` when it can — the same mechanism the browser-console recovery
 *   documented in DEPLOY.md §8.4 uses — and lets the server apply the fallback
 *   otherwise. A missing cookie is NOT treated as a client-side failure: the
 *   origin check still applies, and inventing a local rejection would just be a
 *   different wrong answer.
 *
 * SECRETS
 *   `secretBase32` from the response and the plaintext recovery codes are values,
 *   not state: nothing here writes them to storage, to a query string, or to the
 *   console. They live in React state for as long as the operator is looking at
 *   them and no longer.
 */

const ENROL_URL = '/api/auth/mfa/enrol';

/** Must match `authConfig.csrfCookieName`. Duplicated, not imported: `@/auth/config`
 *  pulls `@/lib/env` and is Node-only, and this module ships to the browser. */
const CSRF_COOKIE_NAME = 'rdm_csrf';

/** Must match `CSRF_HEADER_NAME` in `@/auth/csrf`. */
const CSRF_HEADER_NAME = 'x-csrf-token';

export type EnrolAction = 'start' | 'confirm' | 'disable';

/** Request bodies, transcribed field-for-field from the route's own reads. */
export type EnrolRequestBody =
  | { action: 'start'; password: string }
  | { action: 'confirm'; code: string }
  | { action: 'disable'; password: string };

export interface EnrolStartResult {
  action: 'start';
  /** `otpauth://` URI. CONTAINS the shared secret. Shown, never logged. */
  uri: string;
  issuer: string;
  digits: number;
  periodSeconds: number;
}

export interface EnrolConfirmResult {
  action: 'confirm';
  mfaEnabled: true;
  /** Every OTHER session was dropped by the route; the caller's survives. */
  revokedOtherSessions: number;
  /** SHOWN ONCE. The server keeps bcrypt hashes and cannot return them again. */
  recoveryCodes: string[];
}

export interface EnrolDisableResult {
  action: 'disable';
  mfaEnabled: false;
  /** Includes the caller's own session — the caller is signed out by design. */
  revokedSessions: number;
}

/** Discriminated by `action`, which is also the discriminator `postEnrolment`'s
 *  overloads use to hand each caller exactly one shape. */
export type EnrolResult = EnrolStartResult | EnrolConfirmResult | EnrolDisableResult;

/**
 * A typed failure carrying the route's own `code`. The message is the route's
 * message: `jsonError` only ever forwards an `AppError`'s text, which is written
 * to be safe to show a human, and flattening it to a generic string here would
 * throw away the one distinction the server deliberately made.
 */
export class MfaEnrolError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(message: string, status: number, code: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'MfaEnrolError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** 503 is the route's "SESSION_SECRET is missing" — NOT CONFIGURED, not "try again". */
  get notConfigured(): boolean {
    return this.status === 503;
  }

  /**
   * The `confirm` branch's "start enrolment again" refusals. The grant cookie is
   * short-lived and single-purpose, so an expired or absent grant is routine and
   * the fix is always the same: re-run `start`.
   */
  get needsFreshEnrolment(): boolean {
    return this.status === 400 && this.code === 'INVALID_INPUT';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * Reads the non-httpOnly CSRF cookie. Its value is not a credential — it grants
 * nothing on its own and the session cookie is still required — but it is never
 * echoed anywhere except the header the server compares it against.
 */
function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== CSRF_COOKIE_NAME) continue;
    const value = decodeURIComponent(part.slice(separator + 1).trim());
    if (value.length > 0) return value;
  }
  return null;
}

/** POSTs one action and narrows the response. Anything unexpected is an error.
 *  Overloaded rather than generically indexed because a generic `EnrolResults[T]`
 *  return type forces each branch below to be assignable to the *intersection*
 *  of every result type, which collapses to `never`. */
export function postEnrolment(body: { action: 'start'; password: string }): Promise<EnrolStartResult>;
export function postEnrolment(body: { action: 'confirm'; code: string }): Promise<EnrolConfirmResult>;
export function postEnrolment(body: { action: 'disable'; password: string }): Promise<EnrolDisableResult>;
export async function postEnrolment(body: EnrolRequestBody): Promise<EnrolResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const csrf = readCsrfToken();
  if (csrf) headers[CSRF_HEADER_NAME] = csrf;

  let response: Response;
  try {
    response = await fetch(ENROL_URL, {
      method: 'POST',
      headers,
      // Same-origin credentials carry the session cookie; `credentials` is left
      // explicit so nobody "tidies" it into `omit` later.
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(body),
    });
  } catch {
    throw new MfaEnrolError(
      'Could not reach the enrolment service. Check your connection and try again.',
      0,
      'NETWORK',
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    payload = null;
  }
  const envelope = isRecord(payload) ? payload : {};

  if (!response.ok) {
    const retry = envelope['retryAfterSeconds'];
    throw new MfaEnrolError(
      readString(envelope, 'error') ?? `The enrolment service refused the request (${response.status}).`,
      response.status,
      readString(envelope, 'code') ?? `HTTP_${response.status}`,
      typeof retry === 'number' ? retry : undefined,
    );
  }

  const data = isRecord(envelope['data']) ? (envelope['data'] as Record<string, unknown>) : envelope;

  if (body.action === 'start') {
    const uri = readString(data, 'uri');
    if (!uri) {
      throw new MfaEnrolError(
        'The enrolment service did not return an enrolment key. Nothing was changed — try again.',
        response.status,
        'MALFORMED_RESPONSE',
      );
    }
    return {
      action: 'start',
      uri,
      issuer: readString(data, 'issuer') ?? 'Redeem Store',
      digits: readNumber(data, 'digits') ?? 6,
      periodSeconds: readNumber(data, 'periodSeconds') ?? 30,
    };
  }

  if (body.action === 'confirm') {
    return {
      action: 'confirm',
      // The route only reaches a 2xx here after flipping `mfaEnabledAt` and
      // storing the recovery hashes, so `mfaEnabled: true` is the server's word.
      mfaEnabled: true,
      revokedOtherSessions: readNumber(data, 'revokedOtherSessions') ?? 0,
      recoveryCodes: readStringArray(data, 'recoveryCodes'),
    };
  }

  return {
    action: 'disable',
    mfaEnabled: false,
    revokedSessions: readNumber(data, 'revokedSessions') ?? 0,
  };
}

// ---------------------------------------------------------------------------
// otpauth URI parsing — manual-entry path
// ---------------------------------------------------------------------------

/**
 * No QR-code dependency exists in this repo and none is added: a second-party
 * encoder would put a secret-holding payload through code that has no business
 * seeing one. Instead the `otpauth://` URI is decomposed so the operator can
 * type the base32 setup key by hand — every mainstream authenticator app has a
 * "enter setup key" path, and that is what this is for.
 */
export interface EnrolUriParts {
  /** The base32 setup key. A long-lived credential: shown once, never stored. */
  secretBase32: string;
  issuer: string | null;
  label: string | null;
  digits: number | null;
  period: number | null;
}

/** Returns null for anything that is not a usable `otpauth://` enrolment URI. */
export function readEnrolUri(uri: string): EnrolUriParts | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'otpauth:') return null;

  const secret = parsed.searchParams.get('secret');
  if (!secret || secret.trim().length === 0) return null;

  const digits = parsed.searchParams.get('digits');
  const period = parsed.searchParams.get('period');

  // `otpauth` mints `<issuer>:<account>` in the path, percent-encoded (the colon
  // survives, `encodeURIComponent` does not escape it). `URL.pathname` stays
  // encoded, so it is decoded here rather than shown as `owner%40example.com`.
  const rawPath = parsed.pathname.replace(/^\/+/, '');
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    // A malformed escape is not a reason to drop the whole enrolment; the
    // secret and the query parameters are still readable below.
  }
  const colon = decodedPath.indexOf(':');
  const label = colon === -1 ? decodedPath : decodedPath.slice(colon + 1);

  return {
    secretBase32: secret.trim(),
    issuer: parsed.searchParams.get('issuer') ?? (colon === -1 ? null : decodedPath.slice(0, colon)),
    label: label || null,
    digits: digits && /^\d+$/.test(digits) ? Number.parseInt(digits, 10) : null,
    period: period && /^\d+$/.test(period) ? Number.parseInt(period, 10) : null,
  };
}

/**
 * Groups a base32 key in fours purely so a human can transcribe it off a screen
 * without losing their place. Apps strip the spaces themselves; if one does not,
 * the user can copy the ungrouped form instead.
 */
export function formatSecretForTyping(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, '$1 ').trim();
}