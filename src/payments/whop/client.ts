/**
 * Thin typed HTTP client for the Whop API.
 *
 * Responsibilities, and nothing else:
 *   - `Authorization: Bearer` + `Api-Version-Date` on EVERY request
 *   - optional `Idempotency-Key` so a retried POST cannot double-create
 *   - hard timeout via AbortSignal
 *   - bounded retry with exponential backoff + FULL JITTER, on 5xx/429 and
 *     transport errors ONLY. Never on 400/401/403/409/422 — replaying a request
 *     that was rejected for a reason the caller must fix just burns the rate
 *     limit and hides the real error.
 *   - a client-side per-operation limiter mirroring Whop's documented
 *     "600 requests per minute per operation and API credential"
 *   - the `{ "error": { "type", "message" } }` envelope parsed into typed errors
 *
 * Deliberately NOT here: retries for non-idempotent requests, business
 * validation, or any knowledge of what a payment IS. Those belong to the
 * provider so the client stays auditable.
 */

import { AppError, type ErrorCode } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { requireWhopConfig, type ResolvedWhopConfig } from './config';
import { runWithWhopCircuit } from './circuit';
import { asRecord, asString, type WhopErrorEnvelope } from './types';

// --- Tunables (documented Whop limits, not guesses) --------------------------

/** Whop: "600 requests per minute per operation and API credential". */
export const WHOP_RATE_LIMIT_PER_MINUTE = 600;
const RATE_WINDOW_MS = 60_000;

/**
 * How long we are willing to sit in-process waiting for a rate-limit slot.
 * Kept short on purpose: the webhook route must answer 2xx inside 5 seconds.
 * Beyond this we surface PROVIDER_RATE_LIMITED and let the queue retry.
 */
const MAX_RATE_WAIT_MS = 2_000;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 200;
const BACKOFF_CEILING_MS = 5_000;
/** Upper bound on how long we will honour a server-stated Retry-After. */
const MAX_RETRY_AFTER_MS = 10_000;

/** Whop documents `Idempotency-Key` maxLength 255. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export type WhopHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type WhopQueryValue = string | number | boolean | undefined | null;

export interface WhopRequestOptions {
  method: WhopHttpMethod;
  /** Path relative to the base URL. MUST start with "/" and contain no scheme. */
  path: string;
  /**
   * Whop operation id, e.g. "createCheckoutConfiguration". Used as the
   * rate-limit bucket key (Whop's counter is keyed by operation AND credential)
   * and in logs.
   */
  operation: string;
  query?: Record<string, WhopQueryValue>;
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /**
   * Whether a failed attempt may be replayed. Defaults to true for GET/DELETE
   * and for any request carrying an Idempotency-Key. A POST with neither is
   * NEVER replayed, because the first attempt may already have created a
   * checkout configuration we cannot find again.
   */
  retryable?: boolean;
  /** Error code used when the request fails. Defaults per HTTP status. */
  errorCode?: ErrorCode;
}

export interface WhopResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

// --- Per-operation rate limiter ----------------------------------------------

interface Bucket {
  used: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Sliding-window counter, one bucket per operation.
 *
 * The window is anchored to the first request in the window rather than to the
 * clock, which slightly over-restricts at the boundary — the safe direction.
 */
function takeRateSlot(operation: string, now: number): number {
  let bucket = buckets.get(operation);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    bucket = { used: 0, windowStart: now };
    buckets.set(operation, bucket);
  }
  if (bucket.used >= WHOP_RATE_LIMIT_PER_MINUTE) {
    return Math.max(0, bucket.windowStart + RATE_WINDOW_MS - now);
  }
  bucket.used += 1;
  return 0;
}

/** Exposed for /api/health and tests; never returns secret material. */
export function whopRateLimitState(operation: string, now = Date.now()): { used: number; limit: number } {
  const bucket = buckets.get(operation);
  return {
    used: bucket && now - bucket.windowStart < RATE_WINDOW_MS ? bucket.used : 0,
    limit: WHOP_RATE_LIMIT_PER_MINUTE,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// --- Error handling ----------------------------------------------------------

interface ParsedWhopError {
  type?: string;
  message?: string;
  code?: string;
}

/** Whop errors are `{ "error": { "type", "message", "code"? } }`. */
export function parseWhopErrorEnvelope(body: string): ParsedWhopError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  const envelope = asRecord(parsed);
  if (!envelope) return {};

  const inner = asRecord(envelope.error);
  if (inner) {
    const out: ParsedWhopError = {};
    const type = asString(inner.type);
    const message = asString(inner.message);
    const code = asString(inner.code);
    if (type) out.type = type;
    if (message) out.message = message;
    if (code) out.code = code;
    return out;
  }

  const flat = asString(envelope.message);
  return flat ? { message: flat } : {};
}

/** 429 bodies say "Try again in 12 seconds."; honour the header first. */
export function retryAfterSecondsFrom(response: Response, parsed: ParsedWhopError): number | undefined {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const asDate = new Date(header);
    if (!Number.isNaN(asDate.getTime())) {
      return Math.max(0, Math.round((asDate.getTime() - Date.now()) / 1000));
    }
  }
  const match = /(?:try again|retry) in\s+(\d+)/i.exec(parsed.message ?? '');
  if (match?.[1]) return Number(match[1]);
  return undefined;
}

function defaultErrorCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 422:
      return 'VALIDATION_FAILED';
    case 401:
      // Our credential is missing, wrong, or revoked. That IS "not configured"
      // from the storefront's point of view; a fake provider would be worse.
      return 'PAYMENT_NOT_CONFIGURED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'PAYMENT_CREATE_FAILED';
    case 429:
      return 'PROVIDER_RATE_LIMITED';
    default:
      return 'PROVIDER_UNAVAILABLE';
  }
}

function defaultStatusForErrorCode(code: ErrorCode, upstream: number): number {
  switch (code) {
    case 'VALIDATION_FAILED':
      return 400;
    case 'PAYMENT_NOT_CONFIGURED':
      return 503;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'PROVIDER_RATE_LIMITED':
      return 429;
    case 'AMOUNT_MISMATCH':
    case 'CURRENCY_MISMATCH':
      return 409;
    case 'PAYMENT_VERIFICATION_FAILED':
      return 502;
    default:
      return upstream >= 400 && upstream < 600 ? upstream : 502;
  }
}

function buildApiError(args: {
  operation: string;
  status: number;
  parsed: ParsedWhopError;
  rawBody: string;
  overrideCode?: ErrorCode;
  retryAfterSeconds?: number;
}): AppError {
  const { operation, status, parsed, rawBody, overrideCode, retryAfterSeconds } = args;
  const code = overrideCode ?? defaultErrorCodeForStatus(status);
  const detail = parsed.type ?? 'unknown_error';
  const upstreamMessage = parsed.message ?? truncate(rawBody);

  // The upstream message is Whop's, not ours. It can echo request parameters
  // (e.g. a price), never card data — Whop's hosted page owns card data — but it
  // is still surfaced as a detail rather than the customer-facing message.
  return new AppError(`Whop ${operation} failed (HTTP ${status}, ${detail})`, defaultStatusForErrorCode(code, status), code, {
    details: {
      provider: 'whop',
      operation,
      upstreamStatus: status,
      upstreamErrorType: parsed.type,
      upstreamMessage,
      ...(parsed.code ? { upstreamCode: parsed.code } : {}),
    },
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}

function truncate(value: string, max = 400): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// --- Retry policy ------------------------------------------------------------

/**
 * Retry ONLY on 429 and 5xx, plus transport faults (DNS, connection reset,
 * timeout) where the request may not have been processed.
 *
 * NEVER retried: 400, 401, 403, 404, 409, 422 — Whop rejected the request for a
 * reason that will not change on its own. Replaying those is how a misconfigured
 * account turns into a rate-limit outage.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Full jitter: uniform in [0, ceiling]. Avoids retry convoys across instances. */
function backoffDelayMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    // Respect the server's stated delay; pad it so we do not land exactly on the
    // boundary, and cap it so a hostile/buggy value cannot park a request.
    return Math.min(retryAfterSeconds * 1000 + 250, MAX_RETRY_AFTER_MS);
  }
  const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CEILING_MS);
  return Math.floor(Math.random() * ceiling);
}

// --- Request plumbing --------------------------------------------------------

function buildUrl(
  config: ResolvedWhopConfig,
  path: string,
  query: Record<string, WhopQueryValue> | undefined,
): string {
  if (!path.startsWith('/')) {
    throw new AppError(`Whop path must be relative to the base URL: ${path}`, 500, 'INTERNAL_ERROR');
  }
  // Defence in depth: a caller-supplied absolute URL must never escape the
  // configured Whop host (the API key rides on every request).
  if (path.includes('://') || path.startsWith('//')) {
    throw new AppError('Whop path must not contain a scheme or host', 500, 'INTERNAL_ERROR');
  }

  const url = new URL(`${config.baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function buildHeaders(
  config: ResolvedWhopConfig,
  options: WhopRequestOptions,
  hasBody: boolean,
): Headers {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${config.apiKey}`);
  // EVERY request. Without it Whop silently serves the legacy 2025-01-01 shapes
  // where the account field is `company_id`, not `account_id`.
  headers.set('Api-Version-Date', config.apiVersionDate);
  headers.set('Accept', 'application/json');
  if (hasBody) headers.set('Content-Type', 'application/json');
  if (options.idempotencyKey) {
    headers.set('Idempotency-Key', options.idempotencyKey.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH));
  }
  return headers;
}

function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof AppError) return false;
  if (!(error instanceof Error)) return false;
  // TimeoutError / AbortError from AbortSignal, plus undici's fetch failures.
  return (
    error.name === 'TimeoutError' ||
    error.name === 'AbortError' ||
    error.name === 'TypeError' ||
    error.name === 'FetchError' ||
    error instanceof TypeError
  );
}

export interface WhopClient {
  request<T>(options: WhopRequestOptions): Promise<WhopResponse<T>>;
  /** Config resolved at call time so env changes in tests take effect. */
  config(): ResolvedWhopConfig;
}

export function createWhopClient(): WhopClient {
  return {
    config: requireWhopConfig,

    async request<T>(options: WhopRequestOptions): Promise<WhopResponse<T>> {
      const config = requireWhopConfig();
      const {
        method,
        path,
        operation,
        query,
        body,
        idempotencyKey,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        errorCode,
      } = options;

      const hasBody = body !== undefined && method !== 'GET' && method !== 'DELETE';
      const retryable =
        options.retryable ??
        (method === 'GET' || method === 'DELETE' || Boolean(idempotencyKey));
      const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 5));
      const url = buildUrl(config, path, query);
      const headers = buildHeaders(config, options, hasBody);
      const serialized = hasBody ? JSON.stringify(body) : undefined;

      const rateWait = takeRateSlot(operation, Date.now());
      if (rateWait > MAX_RATE_WAIT_MS) {
        throw new AppError(
          `Whop ${operation} rate limit budget exhausted in this process`,
          429,
          'PROVIDER_RATE_LIMITED',
          {
            details: { provider: 'whop', operation, waitMs: rateWait },
            retryAfterSeconds: Math.max(1, Math.ceil(rateWait / 1000)),
          },
        );
      }
      if (rateWait > 0) await sleep(rateWait);

      let lastError: AppError | undefined;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          // Wrapped by the circuit breaker so a Whop outage fails FAST instead
          // of pinning every function instance on a socket that will never
          // answer. The breaker hands back a signal that fires on ITS budget;
          // the existing timeout still applies via the fallback below.
          const response = await runWithWhopCircuit(operation, (breakerSignal) =>
            fetch(url, {
              method,
              headers,
              body: serialized,
              signal: breakerSignal ?? AbortSignal.timeout(timeoutMs),
              cache: 'no-store',
              // Whop is not a browser API; cookies would leak the account session.
              credentials: 'omit',
              redirect: 'manual',
            }),
          );

          const text = await response.text();

          if (!response.ok) {
            const parsed = parseWhopErrorEnvelope(text);
            const apiError = buildApiError({
              operation,
              status: response.status,
              parsed,
              rawBody: text,
              overrideCode: errorCode,
              retryAfterSeconds: retryAfterSecondsFrom(response, parsed),
            });
            if (retryable && isRetryableStatus(response.status) && attempt < maxAttempts - 1) {
              const delay = backoffDelayMs(attempt, apiError.retryAfterSeconds);
              logger.warn('Whop request failed; retrying', {
                operation,
                status: response.status,
                attempt: attempt + 1,
                delayMs: delay,
                upstreamErrorType: parsed.type,
              });
              lastError = apiError;
              await sleep(delay);
              continue;
            }
            throw apiError;
          }

          // 2xx is success for every documented Whop endpoint. Note that
          // POST /checkout_configurations returns **200**, not 201 — we assert
          // the 2xx RANGE deliberately rather than one exact code.
          if (text.trim().length === 0) {
            return { data: null as T, status: response.status, headers: response.headers };
          }
          let data: T;
          try {
            data = JSON.parse(text) as T;
          } catch (error) {
            throw new AppError(
              `Whop ${operation} returned a non-JSON 2xx response`,
              502,
              'PROVIDER_UNAVAILABLE',
              { details: { provider: 'whop', operation, status: response.status }, cause: error },
            );
          }
          return { data, status: response.status, headers: response.headers };
        } catch (error) {
          if (error instanceof AppError) {
            // A typed Whop failure. `lastError === error` means the retry loop
            // deliberately re-armed it on a previous pass; fall through to the
            // loop's exit so the accumulated error is what surfaces.
            if (lastError !== error) throw error;
            continue;
          }

          if (retryable && isRetryableTransportError(error) && attempt < maxAttempts - 1) {
            const delay = backoffDelayMs(attempt);
            logger.warn('Whop transport error; retrying', {
              operation,
              attempt: attempt + 1,
              delayMs: delay,
              error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
            await sleep(delay);
            continue;
          }

          throw new AppError(`Whop ${operation} request failed`, 502, 'PROVIDER_UNAVAILABLE', {
            details: {
              provider: 'whop',
              operation,
              error: error instanceof Error ? error.name : 'unknown',
            },
            cause: error,
          });
        }
      }

      throw (
        lastError ??
        new AppError(`Whop ${operation} exhausted retries`, 502, 'PROVIDER_UNAVAILABLE', {
          details: { provider: 'whop', operation, attempts: maxAttempts },
        })
      );
    },
  };
}

/** Process-wide client. The limiter map is module state on purpose. */
export const whopClient: WhopClient = createWhopClient();
