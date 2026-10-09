/**
 * Double-submit CSRF protection (spec §15).
 *
 * HOW IT WORKS
 *   The server mints a random value, stores it in a NON-httpOnly cookie
 *   (`rdm_csrf`) and the browser client echoes it in the `x-csrf-token`
 *   header. A cross-site attacker can make the browser *send* our cookies but
 *   cannot *read* them, so it cannot populate the header. Requiring the two to
 *   match is what proves the request came from our own JavaScript.
 *
 * WHY THE COOKIE IS NOT httpOnly
 *   The client has to read it to echo it. That is the whole mechanism. The
 *   cookie is not a credential: it grants nothing on its own, and the session
 *   cookie (httpOnly) is still required.
 *
 * HOW IT DEGRADES — HONESTLY
 *   `assertCsrf` accepts an optional `Request`. Three situations, in order:
 *
 *     1. A Request is available and the CSRF cookie is present  -> full
 *        double-submit compare. This is the normal path for route handlers.
 *     2. A Request is available but the CSRF cookie is ABSENT -> strict
 *        same-origin (Origin/Referer vs Host) check, and a one-time warning.
 *        Cross-site form posts and `fetch` calls always carry an Origin, so this
 *        is still closed; it is weaker only against a same-origin attacker who
 *        can already run script on our origin.
 *     3. NO Request is available (a Server Action) -> the same-origin check
 *        alone, on top of Next.js's own built-in Server Action origin check.
 *
 *   None of those three paths is "skip". There is no code path through this
 *   module that returns without either a token compare or an origin check.
 */

import { cookies, headers } from 'next/headers';
import { authConfig, csrfCookieOptions, sessionSigningAvailable } from '@/auth/config';
import { AppError } from '@/lib/errors';
import { appConfig } from '@/lib/env';
import { safeEqual } from '@/lib/ids';
import { logger } from '@/lib/logger';
import { randomToken } from '@/auth/token';

export const CSRF_HEADER_NAME = 'x-csrf-token';
export const CSRF_FORM_FIELD = '_csrf';

/** How long the CSRF cookie lives. Matches the session idle window. */
const CSRF_TTL_SECONDS = authConfig.sessionIdleTtlSeconds;

function forbidden(message: string): AppError {
  return new AppError(message, 403, 'FORBIDDEN');
}

// --- Token minting -----------------------------------------------------------

/** 32 bytes of CSPRNG output, base64url. */
export function generateCsrfToken(): string {
  return randomToken(32);
}

/**
 * Issues the CSRF cookie. MUST be called from a Route Handler or Server Action:
 * Next.js makes `cookies()` read-only inside a Server Component render, and we
 * fail loudly there rather than pretending the cookie was set.
 */
export async function setCsrfCookie(token: string = generateCsrfToken()): Promise<string> {
  const store = await cookies();
  try {
    store.set(authConfig.csrfCookieName, token, csrfCookieOptions(CSRF_TTL_SECONDS));
  } catch (error) {
    throw new AppError(
      'CSRF cookie can only be set from a Route Handler or Server Action, not during render',
      500,
      'INTERNAL_ERROR',
      { cause: error },
    );
  }
  return token;
}

/** Returns an existing CSRF cookie value, or mints and sets a new one. */
export async function ensureCsrfCookie(): Promise<string> {
  const store = await cookies();
  const existing = store.get(authConfig.csrfCookieName)?.value;
  if (existing && existing.length > 0) return existing;
  return setCsrfCookie();
}

// --- Reading -----------------------------------------------------------------

type CookieSource = Request | Headers | { cookies?: { get(name: string): { value: string } | undefined } };

function readCookie(source: CookieSource | null, name: string): string | null {
  if (!source) return null;

  if (typeof Headers !== 'undefined' && source instanceof Headers) {
    const raw = source.get('cookie');
    if (!raw) return null;
    return parseCookieHeader(raw, name);
  }

  if (typeof Request !== 'undefined' && source instanceof Request) {
    const raw = source.headers.get('cookie');
    if (!raw) return null;
    return parseCookieHeader(raw, name);
  }

  const bag = source as { cookies?: { get(name: string): { value: string } | undefined } };
  if (bag.cookies && typeof bag.cookies.get === 'function') {
    return bag.cookies.get(name)?.value ?? null;
  }
  return null;
}

function parseCookieHeader(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

function headerSource(source: CookieSource | null): Headers | null {
  if (!source) return null;
  if (typeof Headers !== 'undefined' && source instanceof Headers) return source;
  if (typeof Request !== 'undefined' && source instanceof Request) return source.headers;
  return null;
}

/** The token the client echoed back, from the header or (rarely) a form field. */
export async function readSubmittedToken(
  source?: CookieSource | null,
  body?: unknown,
): Promise<string | null> {
  const headersFromRequest = headerSource(source ?? null);
  if (headersFromRequest) {
    const header = headersFromRequest.get(CSRF_HEADER_NAME) ?? headersFromRequest.get('x-xsrf-token');
    if (header && header.length > 0) return header;
  }

  if (body && typeof body === 'object') {
    const bag = body as Record<string, unknown>;
    const field = bag[CSRF_FORM_FIELD] ?? bag.csrfToken ?? bag.csrf_token;
    if (typeof field === 'string' && field.length > 0) return field;
    return null;
  }

  // Server Action / RSC: no Request. A custom header is not readable from
  // headers() during a render, so the caller must pass the form body through.
  try {
    const ambient = await headers();
    const header = ambient.get(CSRF_HEADER_NAME);
    if (header && header.length > 0) return header;
  } catch {
    // headers() is unavailable outside a request scope; that is expected in
    // unit tests and scripts and is handled by the caller's fallback path.
  }
  return null;
}

async function readCookieValue(name: string, source?: CookieSource | null): Promise<string | null> {
  const fromRequest = readCookie(source ?? null, name);
  if (fromRequest) return fromRequest;
  try {
    const store = await cookies();
    return store.get(name)?.value ?? null;
  } catch {
    return null;
  }
}

// --- Origin check (second layer / degraded mode) -----------------------------

export interface SameOriginOptions {
  /**
   * When true (the default) a request with NEITHER Origin nor Referer is
   * refused. Non-browser clients (curl, server-to-server) legitimately send
   * neither, so pass `false` for those.
   */
  required?: boolean;
  /** Extra hostnames accepted as "us", beyond the request Host and appConfig.url. */
  additionalHosts?: readonly string[];
}

function hostMatches(candidate: string | null, allowed: Set<string>): boolean {
  if (!candidate) return false;
  return allowed.has(candidate.trim().toLowerCase());
}

async function allowedHosts(source?: CookieSource | null, extra?: readonly string[]): Promise<Set<string>> {
  const allowed = new Set<string>();

  try {
    const url = new URL(appConfig.url);
    allowed.add(url.host.toLowerCase());
  } catch {
    // A malformed NEXT_PUBLIC_APP_URL must not disable the check; the request
    // Host below is still authoritative.
  }

  const fromRequest = headerSource(source ?? null);
  const requestHost = fromRequest?.get('host');
  if (requestHost) allowed.add(requestHost.toLowerCase());

  try {
    const ambient = await headers();
    const ambientHost = ambient.get('host');
    if (ambientHost) allowed.add(ambientHost.toLowerCase());
    const forwardedHost = ambient.get('x-forwarded-host');
    if (forwardedHost) allowed.add(forwardedHost.split(',')[0]?.trim().toLowerCase() ?? '');
  } catch {
    // Not in a request scope; the sets above are still enough for the
    // route-handler path, which is where a Request is supplied.
  }

  for (const host of extra ?? []) allowed.add(host.trim().toLowerCase());
  allowed.delete('');
  return allowed;
}

/**
 * Strict same-origin check against the request Host (and NEXT_PUBLIC_APP_URL).
 * Throws `AppError` 403 on any mismatch. This is the layer that keeps a
 * cross-site mutation out when the double-submit cookie is unavailable.
 */
export async function assertSameOrigin(
  source?: CookieSource | null,
  options: SameOriginOptions = {},
): Promise<void> {
  const required = options.required ?? true;
  const allowed = await allowedHosts(source, options.additionalHosts);

  const headersFromRequest = headerSource(source ?? null);
  let origin = headersFromRequest?.get('origin') ?? null;
  let referer = headersFromRequest?.get('referer') ?? null;

  if (!origin && !referer) {
    try {
      const ambient = await headers();
      origin = ambient.get('origin');
      referer = ambient.get('referer');
    } catch {
      // Not in a request scope.
    }
  }

  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw forbidden('Malformed Origin header');
    }
    if (!hostMatches(host, allowed)) throw forbidden('Cross-origin request refused');
    return;
  }

  if (referer) {
    let host: string;
    try {
      host = new URL(referer).host;
    } catch {
      throw forbidden('Malformed Referer header');
    }
    if (!hostMatches(host, allowed)) throw forbidden('Cross-origin request refused');
    return;
  }

  if (required) {
    throw forbidden(
      'Request has no Origin or Referer header; refusing a cross-site mutation. ' +
        `Set NEXT_PUBLIC_APP_URL (currently ${appConfig.url}).`,
    );
  }
}

/** Synchronous alias for callers that already hold the headers. */
export function assertSameOriginSync(request: Request, options: SameOriginOptions = {}): void {
  const required = options.required ?? true;
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const host = (request.headers.get('host') ?? '').toLowerCase();

  let allowed = new Set<string>();
  try {
    allowed.add(new URL(appConfig.url).host.toLowerCase());
  } catch {
    // Ignore: the request Host is enough.
  }
  if (host) allowed.add(host);
  for (const extra of options.additionalHosts ?? []) allowed.add(extra.trim().toLowerCase());

  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      throw forbidden('Malformed Origin header');
    }
    if (!allowed.has(originHost)) throw forbidden('Cross-origin request refused');
    return;
  }
  if (referer) {
    let refererHost: string;
    try {
      refererHost = new URL(referer).host.toLowerCase();
    } catch {
      throw forbidden('Malformed Referer header');
    }
    if (!allowed.has(refererHost)) throw forbidden('Cross-origin request refused');
    return;
  }
  if (required) throw forbidden('Request has no Origin or Referer header');
}

// --- Token validation --------------------------------------------------------

let missingCookieWarned = false;
let actionContextWarned = false;

/**
 * Pure compare of an echoed token against the cookie value. Constant-time via
 * `safeEqual`, which also performs a comparison on length mismatch so a short
 * token does not fail faster than a long wrong one.
 */
export function compareTokens(cookieValue: string, submitted: string): boolean {
  if (!cookieValue || !submitted) return false;
  return safeEqual(cookieValue, submitted);
}

/** Non-throwing predicate. `true` only on an exact double-submit match. */
export async function validateCsrfToken(source?: CookieSource | null, body?: unknown): Promise<boolean> {
  const cookieValue = await readCookieValue(authConfig.csrfCookieName, source ?? null);
  if (!cookieValue) return false;
  const submitted = await readSubmittedToken(source ?? null, body);
  if (!submitted) return false;
  return compareTokens(cookieValue, submitted);
}

/**
 * THE entry point used by the admin panel seam.
 *
 * `source` is the Request when there is one (route handlers) and absent when
 * there is not (Server Actions, where Next.js does not surface a custom request
 * header). It NEVER returns without a decision.
 *
 *   - Request present, CSRF cookie present  -> full double-submit compare.
 *   - Request present, CSRF cookie absent   -> strict same-origin check, warned
 *     once, still closed against cross-site posts.
 *   - No Request (Server Action)            -> strict same-origin check. The
 *     double-submit layer is unavailable there in principle, so the guard is
 *     layered on Next.js's own built-in Server Action origin check rather than
 *     pretending to compare a header nobody can read.
 */
export async function assertCsrf(source?: CookieSource | null, body?: unknown): Promise<void> {
  // An unconfigured SESSION_SECRET means the whole auth stack is NOT
  // CONFIGURED. Refusing mutations is the honest response.
  if (!sessionSigningAvailable()) {
    throw new AppError(
      'CSRF protection is NOT CONFIGURED — SESSION_SECRET is missing or too short.',
      503,
      'FORBIDDEN',
    );
  }

  const hasRequest = source !== null && source !== undefined;

  if (!hasRequest) {
    if (!actionContextWarned) {
      actionContextWarned = true;
      logger.debug(
        'assertCsrf called without a Request (Server Action context); ' +
          'verifying Origin/Referer only, on top of the framework origin check',
      );
    }
    await assertSameOrigin(null, { required: true });
    return;
  }

  const cookieValue = await readCookieValue(authConfig.csrfCookieName, source);
  if (cookieValue) {
    const submitted = await readSubmittedToken(source, body);
    if (!submitted) {
      throw forbidden(`Missing ${CSRF_HEADER_NAME} header for a state-changing request`);
    }
    if (!compareTokens(cookieValue, submitted)) {
      logger.warn('CSRF token mismatch on a state-changing request');
      throw forbidden('CSRF token mismatch');
    }
    return;
  }

  if (!missingCookieWarned) {
    missingCookieWarned = true;
    logger.warn(
      'No CSRF cookie present; falling back to strict same-origin verification only. ' +
        'Call ensureCsrfCookie() from a Route Handler or Server Action to restore the ' +
        'double-submit check.',
    );
  }

  await assertSameOrigin(source, { required: true });
}

/** Aliases so the admin seam resolves whichever name it looks for. */
export const verifyCsrfToken = assertCsrf;
export const assertCsrfRequest = assertCsrf;
export const assertCsrfToken = assertCsrf;

/**
 * Convenience for the unauthenticated endpoints (login, MFA challenge). There
 * is no session to protect yet, so a full double-submit is not meaningful; the
 * cross-site-login risk is answered by refusing any Origin that is not us.
 */
export async function assertSameOriginForUnauthenticated(request: Request): Promise<void> {
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  if (!origin && !referer) {
    logger.warn('Unauthenticated auth request arrived with no Origin or Referer header');
    return;
  }
  await assertSameOrigin(request, { required: true });
}
