/**
 * Abuse protection for the PUBLIC, unauthenticated endpoints:
 * `POST /api/checkout`, `GET /api/payments/status`, `POST /api/payments/webhook`.
 *
 * WHY THIS EXISTS
 * Those three routes are reachable by anyone with no session. Unprotected they
 * are a cost problem and a DoS vector at the same time: an attacker (or one
 * runaway client) can create unlimited orders, burn inventory, and pin a
 * database connection per in-flight request. On Vercel every one of those
 * invocations is billed, so "unlimited" is the real threat.
 *
 * BACKENDS
 *   1. Upstash Redis (distributed) via `@upstash/ratelimit`, sliding window.
 *      The only backend that is correct behind more than one server instance,
 *      which on Vercel is the normal case.
 *   2. In-memory — the DOCUMENTED FALLBACK, used when UPSTASH is NOT
 *      CONFIGURED. It is per-process, so behind N instances the effective
 *      budget is 1/N of the configured one. It is strictly better than nothing
 *      but it is NOT the limit we intended, so the first time this module runs
 *      in-memory it emits exactly ONE `warn` per process naming the variables
 *      that would fix it. Once per process, never once per request: an event
 *      storm is its own outage.
 *
 * A LIVE Redis failure degrades to memory too rather than throwing. An
 * unreachable rate limiter must not become an availability outage, and a
 * process-local limiter is strictly better than none. That transition is
 * logged as well, also once per process.
 *
 * NEVER THROWS. Every entry point returns a verdict, because a limiter that
 * takes the payment path down with it is worse than one that under-limits
 * during an outage.
 *
 * IDENTIFIERS ARE HASHED BEFORE THEY BECOME KEYS
 * `piiHash` (keyed SHA-256) is applied by `clientIpHash()` and by the email
 * rules. A rate-limit key store must not double as a PII store, and a raw IP
 * is never stored, never logged and never returned.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

import { redisConfig } from '@/lib/env';
import { normalizeEmail, piiHash, sha256 } from '@/lib/ids';
import { logger } from '@/lib/logger';

export type RateLimitBackend = 'upstash' | 'memory';

/**
 * The verdict. `success: true` means "under the limit, proceed".
 * A refusal is a 429 with `Retry-After: retryAfterSeconds` — never a 5xx.
 */
export interface PublicRateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Unix milliseconds at which the sliding window frees up the oldest hit. */
  reset: number;
  retryAfterSeconds: number;
  /** Which limiter produced this verdict. Surfaced so degradation is visible. */
  backend: RateLimitBackend;
  /** True when we are NOT on the distributed limiter. */
  degraded: boolean;
}

/**
 * `public-rl:*` rather than `auth:rl:*`: different budget, different window,
 * different blast radius. Sharing a prefix with the auth limiter would let a
 * password-guessing run and a checkout flood spend each other's budget.
 */
export type PublicRateLimitRule =
  | 'checkout-ip'
  | 'checkout-email'
  | 'status-ip'
  | 'webhook-global';

// --- Limits ------------------------------------------------------------------

/**
 * Budgets are tuned for the storefront, not for an API client:
 *
 *   checkout-ip    a human double-clicks; a bot does not. 10/min per address.
 *   checkout-email 5/min. Buying many SKUs legitimately is a cart flow, not a
 *                  20-orders-a-minute pattern.
 *   status-ip      loose. This is a POLLING endpoint: the status page polls
 *                  while a customer waits, and customers share NAT and office
 *                  egress IPs. Too tight here means real buyers get a 429 while
 *                  waiting for their own order.
 *   webhook-global a SAFETY NET ONLY, see `limitWebhook()`. The ceiling is
 *                  deliberately far above any real event rate; it exists to
 *                  stop an unbounded flood, not to police Whop.
 *
 * Each is overridable per environment without a code change (tuning during an
 * incident should not need a deploy). A malformed value falls back to the
 * default and says so once, rather than silently disabling the limit.
 */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    logBadConfigOnce(name, raw);
    return fallback;
  }
  return parsed;
}

interface RuleDefinition {
  limit: number;
  windowSeconds: number;
  /** Static human label for logs. Never contains user input. */
  label: string;
}

const WINDOW_SECONDS = intFromEnv('PUBLIC_RATE_LIMIT_WINDOW_SECONDS', 60);

const RULES: Readonly<Record<PublicRateLimitRule, RuleDefinition>> = {
  'checkout-ip': {
    limit: intFromEnv('CHECKOUT_IP_RATE_LIMIT_PER_WINDOW', 10),
    windowSeconds: WINDOW_SECONDS,
    label: 'checkout per IP',
  },
  'checkout-email': {
    limit: intFromEnv('CHECKOUT_EMAIL_RATE_LIMIT_PER_WINDOW', 5),
    windowSeconds: WINDOW_SECONDS,
    label: 'checkout per email',
  },
  'status-ip': {
    limit: intFromEnv('STATUS_IP_RATE_LIMIT_PER_WINDOW', 60),
    windowSeconds: WINDOW_SECONDS,
    label: 'status lookup per IP',
  },
  'webhook-global': {
    limit: intFromEnv('WEBHOOK_RATE_LIMIT_PER_WINDOW', 5_000),
    windowSeconds: WINDOW_SECONDS,
    label: 'webhook safety net (global)',
  },
};

// --- Redis backend (lazy) ----------------------------------------------------

let redisClient: Redis | null = null;
let redisInitFailed = false;

/**
 * Only attempts the Upstash client when both variables exist. NOT CONFIGURED is
 * a reportable state (spec §24), not a crash — hence the probe, not a throw.
 */
function getRedis(): Redis | null {
  if (redisInitFailed) return null;
  if (redisClient) return redisClient;
  if (!redisConfig.configured) return null;
  try {
    redisClient = new Redis({
      url: redisConfig.url as string,
      token: redisConfig.token as string,
    });
    return redisClient;
  } catch (error) {
    redisInitFailed = true;
    redisClient = null;
    logDegradation(
      'Upstash client could not be constructed: ' +
        (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}

const limiters = new Map<PublicRateLimitRule, Ratelimit>();

function getLimiter(rule: PublicRateLimitRule): Ratelimit | null {
  const redis = getRedis();
  if (!redis) return null;

  const cached = limiters.get(rule);
  if (cached) return cached;

  const definition = RULES[rule];
  const limiter = new Ratelimit({
    redis,
    // Sliding window, not fixed: a fixed window lets an attacker send 2x the
    // budget across the boundary, which defeats the point of the limit.
    limiter: Ratelimit.slidingWindow(definition.limit, `${definition.windowSeconds} s`),
    prefix: `public-rl:${rule}`,
    // Off deliberately. Analytics doubles the Redis operations per request and
    // these are the highest-QPS routes in the app; the counters are not worth
    // the bill during a traffic spike.
    analytics: false,
    // Fail fast: a checkout must not queue behind a slow limiter. On timeout we
    // fall back to the in-memory bucket rather than holding the request.
    timeout: 1_500,
  });
  limiters.set(rule, limiter);
  return limiter;
}

// --- In-memory backend -------------------------------------------------------

interface MemoryBucket {
  count: number;
  resetAt: number;
}

const memoryBuckets = new Map<string, MemoryBucket>();

/** Bounds the map so an attacker cycling identifiers cannot exhaust memory. */
const MEMORY_MAX_BUCKETS = 50_000;
let memoryOpsSinceSweep = 0;

function sweepMemory(now: number): void {
  memoryOpsSinceSweep += 1;
  if (memoryOpsSinceSweep < 1_000) return;
  memoryOpsSinceSweep = 0;
  for (const [key, bucket] of memoryBuckets) {
    if (bucket.resetAt <= now) memoryBuckets.delete(key);
  }
  if (memoryBuckets.size <= MEMORY_MAX_BUCKETS) return;
  // Drop the oldest insertions first: buckets are inserted in time order and
  // Map preserves insertion order, so the head is the soonest to expire.
  let toDrop = memoryBuckets.size - MEMORY_MAX_BUCKETS;
  for (const key of memoryBuckets.keys()) {
    if (toDrop <= 0) break;
    memoryBuckets.delete(key);
    toDrop -= 1;
  }
}

function limitInMemory(
  rule: PublicRateLimitRule,
  identifier: string,
  now: number,
): PublicRateLimitResult {
  const definition = RULES[rule];
  const key = `${rule}:${identifier}`;
  sweepMemory(now);

  const existing = memoryBuckets.get(key);
  const bucket =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + definition.windowSeconds * 1000 };

  bucket.count += 1;
  memoryBuckets.set(key, bucket);

  const success = bucket.count <= definition.limit;
  return {
    success,
    limit: definition.limit,
    remaining: Math.max(0, definition.limit - bucket.count),
    reset: bucket.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    backend: 'memory',
    degraded: true,
  };
}

// --- Degradation logging (once per process) ----------------------------------

let unconfiguredLogged = false;
let runtimeFailureLogged = false;
let badConfigLogged = false;

/**
 * The one line that separates "we chose a weaker limiter" from "our public
 * endpoints were unlimited and nobody said anything". Emitted once per process.
 */
function logDegradation(detail: string): void {
  if (unconfiguredLogged) return;
  unconfiguredLogged = true;
  logger.warn(
    'PUBLIC ENDPOINT RATE LIMITING DEGRADED to in-memory. Limits are per-process only ' +
      '(behind N instances the real budget is 1/N); set UPSTASH_REDIS_REST_URL and ' +
      'UPSTASH_REDIS_REST_TOKEN for a distributed limiter.',
    { backend: 'memory', detail, rules: Object.keys(RULES) },
  );
}

function logBadConfigOnce(name: string, value: string): void {
  if (badConfigLogged) return;
  badConfigLogged = true;
  logger.warn('Ignoring a malformed public rate-limit setting; using the default', {
    setting: name,
    // The value itself is operator-supplied config, never request input.
    value: value.slice(0, 64),
  });
}

/**
 * Honesty for /api/health and for callers that want to know before they rely on
 * a limit. NOT CONFIGURED is reported as such, never as "fine".
 */
export function publicRateLimiterStatus(): {
  backend: RateLimitBackend;
  degraded: boolean;
  reason: string | null;
} {
  if (redisClient && !redisInitFailed) {
    return { backend: 'upstash', degraded: false, reason: null };
  }
  return {
    backend: 'memory',
    degraded: true,
    reason: redisInitFailed
      ? 'Upstash client failed to initialise'
      : 'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set',
  };
}

// --- Identifier extraction ----------------------------------------------------

/**
 * Client IP from the usual proxy headers, keyed-hashed. A raw address is never
 * stored, logged or returned. Falls back to an unkeyed SHA-256 if
 * FINGERPRINT_KEY / ENCRYPTION_KEY are missing: still stable, still not the
 * plaintext address, and this path must never throw on the payment route.
 */
function hashIdentifier(value: string): string {
  try {
    return piiHash(value);
  } catch {
    return sha256(value.trim().toLowerCase());
  }
}

/**
 * `undefined` when no proxy header is present (local dev, some test runners).
 * Every caller treats that as its own bucket rather than trusting the header.
 */
export function clientIpHash(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  const candidate = forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip')?.trim();
  if (!candidate || candidate.length === 0) return undefined;
  return hashIdentifier(candidate);
}

/**
 * Key for an unknown/absent client. Deliberately one shared bucket: if the
 * header is missing we cannot distinguish callers, and silently giving each one
 * a private budget would be no limit at all.
 */
function missingIdentifierKey(): string {
  return hashIdentifier('no-client-ip');
}

// --- Core --------------------------------------------------------------------

/** Consumes one unit of `rule` for an already-hashed identifier. Never throws. */
async function consume(
  rule: PublicRateLimitRule,
  identifier: string,
): Promise<PublicRateLimitResult> {
  const now = Date.now();
  const limiter = getLimiter(rule);

  if (!limiter) {
    if (!redisInitFailed) {
      logDegradation('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set');
    }
    return limitInMemory(rule, identifier, now);
  }

  try {
    const result = await limiter.limit(identifier);

    // Upstash reports `reason: 'timeout'` when it gave up waiting for Redis.
    // That is an unreachable limiter, not a pass.
    if ((result as { reason?: string }).reason === 'timeout') {
      logRuntimeFailure('Upstash request timed out at runtime');
      return limitInMemory(rule, identifier, now);
    }

    return {
      success: result.success,
      limit: result.limit,
      remaining: Math.max(0, result.remaining),
      reset: result.reset,
      retryAfterSeconds: Math.max(1, Math.ceil((result.reset - now) / 1000)),
      backend: 'upstash',
      degraded: false,
    };
  } catch (error) {
    logRuntimeFailure(
      'Upstash request failed at runtime: ' +
        (error instanceof Error ? error.message : String(error)),
    );
    return limitInMemory(rule, identifier, now);
  }
}

function logRuntimeFailure(detail: string): void {
  if (runtimeFailureLogged) return;
  runtimeFailureLogged = true;
  logDegradation(detail);
}

// --- Public API --------------------------------------------------------------

/**
 * CHECKOUT, STAGE 1 — per IP. Call this as the very first statement of the POST,
 * before the body is read, so a rejected request costs one header lookup, one
 * hash and one Redis round trip instead of a JSON parse and an order row.
 *
 * Not keying on IP alone would be bypassable (rotate addresses), which is why
 * stage 2 exists; not keying on email alone would be bypassable too (many
 * buyers behind one NAT / one office egress). Both must pass.
 */
export async function limitCheckoutIp(ipHash?: string | null): Promise<PublicRateLimitResult> {
  return consume('checkout-ip', ipHash && ipHash.length > 0 ? ipHash : missingIdentifierKey());
}

/**
 * CHECKOUT, STAGE 2 — per email, run after validation and before the first DB
 * write. `email` may be unvalidated (it is hashed before it is used, so it
 * cannot become a key or a log line verbatim), but callers should pass the
 * parsed body value.
 */
export async function limitCheckoutEmail(email: string): Promise<PublicRateLimitResult> {
  // Normalised the same way the order row is normalised, so
  // user+tag@x.com and user@x.com cannot buy two budgets.
  return consume('checkout-email', hashIdentifier(normalizeEmail(email)));
}

/**
 * The combined checkout rule: per-IP AND per-email, first refusal wins.
 *
 * `limitCheckout()` exists for callers that already hold both identifiers. The
 * route does NOT use it, because it must run the per-IP check BEFORE the body
 * has been parsed (the email does not exist yet at that point); it calls
 * `limitCheckoutIp()` then `limitCheckoutEmail()` instead, which charges each
 * bucket exactly once. Call this variant only when both values are in hand.
 *
 * When both rules pass, the result with the least remaining headroom is
 * returned — that is the one that will refuse next.
 */
export async function limitCheckout(input: {
  ipHash?: string | null;
  email?: string | null;
}): Promise<PublicRateLimitResult> {
  const checks: PublicRateLimitResult[] = [await limitCheckoutIp(input.ipHash)];
  if (input.email && input.email.length > 0) {
    checks.push(await limitCheckoutEmail(input.email));
  }

  const refused = checks.find((check) => !check.success);
  if (refused) return refused;

  return checks.reduce((tightest, check) => (check.remaining < tightest.remaining ? check : tightest));
}

/**
 * STATUS LOOKUP — deliberately loose. It is polled by the status page while a
 * customer waits for their code, and many legitimate customers share one NAT or
 * office egress address. A tight limit here produces 429s for real buyers
 * watching their own order. Per-IP only: `reference` is user-supplied and
 * cheap to vary, so keying on it would be trivially bypassed.
 */
export async function limitStatusLookup(ipHash?: string | null): Promise<PublicRateLimitResult> {
  return consume('status-ip', ipHash && ipHash.length > 0 ? ipHash : missingIdentifierKey());
}

/**
 * WEBHOOK SAFETY NET — high ceiling, single global key, NOT keyed by IP.
 *
 * Deliberately not keyed by IP: Whop delivers from rotating infrastructure, and
 * a per-IP limit would refuse legitimate retries — which is the one thing a
 * webhook route must never do. The ceiling sits far above any real event rate
 * (the default is ~83 events/second) and exists only to stop an unbounded
 * flood; the route that uses it must call this AFTER signature verification,
 * never before, so an unsigned flood is already rejected as a 400.
 */
export async function limitWebhook(): Promise<PublicRateLimitResult> {
  return consume('webhook-global', 'global');
}

/**
 * One line per rule per process when the route refuses a request, `debug`
 * afterwards. A sustained attack is exactly when you least want to amplify it
 * with a log line per request; you still want the FIRST one to be visible.
 */
const rejectionLogged = new Set<PublicRateLimitRule>();

export function noteRateLimitRejection(
  rule: PublicRateLimitRule,
  result: PublicRateLimitResult,
): void {
  const context = {
    rule,
    label: RULES[rule].label,
    limit: result.limit,
    retryAfterSeconds: result.retryAfterSeconds,
    backend: result.backend,
    degraded: result.degraded,
  };
  if (rejectionLogged.has(rule)) {
    logger.debug('Public endpoint rate limited (repeat, logged once per process)', context);
    return;
  }
  rejectionLogged.add(rule);
  logger.warn('Public endpoint rate limited', context);
}
