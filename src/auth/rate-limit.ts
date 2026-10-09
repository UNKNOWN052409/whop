/**
 * Brute-force limiting for login, MFA challenge and password re-check (spec §15).
 *
 * BACKENDS
 *   1. Upstash Redis (distributed) — used whenever `UPSTASH_REDIS_REST_URL` and
 *      `UPSTASH_REDIS_REST_TOKEN` are both set. This is the only backend that is
 *      correct behind more than one server instance.
 *   2. In-memory — the DOCUMENTED FALLBACK. It is per-process, so on a multi-
 *      instance deployment it limits to 1/N of the intended budget.
 *
 * THE FALLBACK IS NEVER SILENT. The first time this module decides to run
 * in-memory it logs a `warn` line naming the exact missing variables. That
 * single line is the difference between "we chose a weaker limiter" and "our
 * login form was brute-forceable and nobody told us". It logs once per process,
 * not once per request, because an event storm is its own outage.
 *
 * A live Redis failure ALSO degrades to memory rather than throwing: an
 * unreachable rate limiter must not become an authentication bypass, and the
 * process-local limiter is strictly better than no limiter. That transition is
 * logged too.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { authConfig } from '@/auth/config';
import { redisConfig } from '@/lib/env';
import { piiHash, sha256 } from '@/lib/ids';
import { logger } from '@/lib/logger';

export type RateLimitBackend = 'upstash' | 'memory';

export interface RateLimitResult {
  /** True when the caller is under the limit and may proceed. */
  success: boolean;
  limit: number;
  remaining: number;
  /** Unix milliseconds at which the window resets. */
  reset: number;
  retryAfterSeconds: number;
  backend: RateLimitBackend;
  /** True when we are NOT on the distributed limiter. */
  degraded: boolean;
  /** Set when the limit is exceeded. */
  reason?: 'limit' | 'redis-error';
}

/** The four rules the auth surface needs. */
export type RateLimitRule = 'login-ip' | 'login-account' | 'mfa-attempt' | 'password-recheck';

interface RuleDefinition {
  limit: number;
  /** Human name used in logs; never contains user input. */
  label: string;
}

const RULES: Readonly<Record<RateLimitRule, RuleDefinition>> = {
  'login-ip': { limit: authConfig.loginIpLimit, label: 'login per IP' },
  'login-account': { limit: authConfig.loginAccountLimit, label: 'login per account' },
  'mfa-attempt': { limit: authConfig.mfaAttemptLimit, label: 'MFA challenge attempts' },
  'password-recheck': { limit: authConfig.passwordRecheckLimit, label: 'password re-checks' },
};

// --- Redis backend (lazy) ----------------------------------------------------

let redisClient: Redis | null = null;
let redisInitFailed = false;

/**
 * Only attempts the Upstash client when both variables exist. Unconfigured is a
 * reportable state (spec §24), not an error — hence the boolean probe rather
 * than a throw.
 */
function getRedis(): Redis | null {
  if (redisInitFailed) return null;
  if (redisClient) return redisClient;
  if (!redisConfig.configured) return null;
  try {
    redisClient = new Redis({ url: redisConfig.url, token: redisConfig.token });
    return redisClient;
  } catch (error) {
    redisInitFailed = true;
    redisClient = null;
    logDegradation(
      'memory',
      'Upstash client could not be constructed: ' +
        (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}

const limiters = new Map<RateLimitRule, Ratelimit>();

function getLimiter(rule: RateLimitRule): Ratelimit | null {
  const redis = getRedis();
  if (!redis) return null;

  const cached = limiters.get(rule);
  if (cached) return cached;

  const definition = RULES[rule];
  const limiter = new Ratelimit({
    redis,
    // Sliding window: a fixed window lets an attacker burst 2x the budget
    // across the boundary, which is precisely what a login limiter must not do.
    limiter: Ratelimit.slidingWindow(definition.limit, `${authConfig.rateLimitWindowSeconds} s`),
    prefix: `auth:rl:${rule}`,
    analytics: true,
    // Fail fast rather than hanging the login form behind a slow Redis.
    timeout: 2_000,
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
  // Evict the soonest-to-expire entries. Map preserves insertion order and
  // buckets are inserted in time order, so this drops the oldest first.
  let toDrop = memoryBuckets.size - MEMORY_MAX_BUCKETS;
  for (const key of memoryBuckets.keys()) {
    if (toDrop <= 0) break;
    memoryBuckets.delete(key);
    toDrop -= 1;
  }
}

function limitInMemory(rule: RateLimitRule, identifier: string, now: number): RateLimitResult {
  const definition = RULES[rule];
  const key = `${rule}:${identifier}`;
  sweepMemory(now);

  const existing = memoryBuckets.get(key);
  const bucket =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + authConfig.rateLimitWindowSeconds * 1000 };

  bucket.count += 1;
  memoryBuckets.set(key, bucket);

  const remaining = Math.max(0, definition.limit - bucket.count);
  return {
    success: bucket.count <= definition.limit,
    limit: definition.limit,
    remaining,
    reset: bucket.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    backend: 'memory',
    degraded: true,
    reason: bucket.count <= definition.limit ? undefined : 'limit',
  };
}

// --- Degradation logging (once per process) ----------------------------------

let degradationLogged = false;
let runtimeRedisFailureLogged = false;

/**
 * Emits exactly one warning per process explaining that limiting is running
 * somewhere other than Redis, with the variables that would fix it.
 */
function logDegradation(backend: RateLimitBackend, detail: string): void {
  if (degradationLogged) return;
  degradationLogged = true;
  logger.warn(
    'AUTH RATE LIMITING DEGRADED to in-memory. Limits are per-process only; ' +
      'set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for a distributed limiter.',
    { backend, detail, limitWindowSeconds: authConfig.rateLimitWindowSeconds },
  );
}

/** Called by /api/health-adjacent surfaces so the degradation is visible, not just logged. */
export function rateLimiterStatus(): {
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

// --- Identifier hashing ------------------------------------------------------

/**
 * Identifiers (IPs, email addresses) are hashed before they become Redis keys
 * or map keys: a rate-limit key store should not double as a PII store. Falls
 * back to a bare SHA-256 when FINGERPRINT_KEY/ENCRYPTION_KEY are missing, which
 * is still stable but unkeyed.
 */
export function hashIdentifier(value: string): string {
  try {
    return piiHash(value);
  } catch {
    return sha256(value.trim().toLowerCase());
  }
}

// --- Public API --------------------------------------------------------------

/**
 * Consumes one unit of `rule` for `identifier`.
 *
 * Never throws: a rate limiter that takes the login endpoint down with it is
 * worse than one that under-limits during an outage.
 */
export async function rateLimit(rule: RateLimitRule, identifier: string): Promise<RateLimitResult> {
  const definition = RULES[rule];
  const key = hashIdentifier(identifier);
  const now = Date.now();

  const limiter = getLimiter(rule);
  if (!limiter) {
    if (!redisInitFailed) {
      logDegradation(
        'memory',
        'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set',
      );
    }
    return limitInMemory(rule, key, now);
  }

  try {
    const result = await limiter.limit(key);
    // Upstash reports `reason: "timeout"` when it gave up waiting for Redis. We
    // treat that exactly like an unreachable limiter rather than as a pass.
    const timedOut = (result as { reason?: string }).reason === 'timeout';

    if (timedOut) {
      if (!runtimeRedisFailureLogged) {
        runtimeRedisFailureLogged = true;
        logDegradation('memory', 'Upstash request timed out at runtime');
      }
      return { ...limitInMemory(rule, key, now), reason: 'redis-error' };
    }

    return {
      success: result.success,
      limit: result.limit,
      remaining: Math.max(0, result.remaining),
      reset: result.reset,
      retryAfterSeconds: Math.max(1, Math.ceil((result.reset - now) / 1000)),
      backend: 'upstash',
      degraded: false,
      reason: result.success ? undefined : 'limit',
    };
  } catch (error) {
    if (!runtimeRedisFailureLogged) {
      runtimeRedisFailureLogged = true;
      logDegradation(
        'memory',
        'Upstash request failed at runtime: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    return { ...limitInMemory(rule, key, now), reason: 'redis-error' };
  }
}

/** IP-based login limiting. `ip` may be null when no proxy headers are present. */
export async function rateLimitLoginIp(ip: string | null): Promise<RateLimitResult> {
  return rateLimit('login-ip', ip && ip.length > 0 ? ip : 'unknown-ip');
}

/** Per-account login limiting. `email` is the normalised login address. */
export async function rateLimitLoginAccount(email: string): Promise<RateLimitResult> {
  return rateLimit('login-account', email);
}

/** Per-user MFA challenge limiting. A 6-digit TOTP is only ~20 bits of entropy. */
export async function rateLimitMfaAttempt(userId: string): Promise<RateLimitResult> {
  return rateLimit('mfa-attempt', userId);
}

/** Guards the password re-check that gates MFA enrolment and MFA disable. */
export async function rateLimitPasswordRecheck(userId: string): Promise<RateLimitResult> {
  return rateLimit('password-recheck', userId);
}

/**
 * Runs every rule and returns the first refusal, or a passing result when all
 * pass. Used by the login endpoint so a caller blocked on IP is not told
 * anything about the account they targeted.
 */
export async function rateLimitAll(
  checks: ReadonlyArray<{ rule: RateLimitRule; identifier: string }>,
): Promise<{ ok: true } | { ok: false; rule: RateLimitRule; result: RateLimitResult }> {
  for (const check of checks) {
    const result = await rateLimit(check.rule, check.identifier);
    if (!result.success) return { ok: false, rule: check.rule, result };
  }
  return { ok: true };
}
