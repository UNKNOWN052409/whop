/**
 * Catalog cache control (spec §16).
 *
 * The storefront catalog is read-heavy and changes rarely, so reads are cached
 * behind a short TTL. Two tiers, chosen at construction:
 *
 *   REDIS  — UPSTASH_REDIS_REST_URL/TOKEN present. Shared across instances.
 *   MEMORY — Redis NOT_CONFIGURED. Per-process only.
 *
 * Degrading to MEMORY is EXPLICIT: `catalogCacheStatus()` reports NOT_CONFIGURED
 * for /api/health and a warning is logged once per process. It is never a
 * silent no-op, and it never fakes a cache hit — every layer is optional and
 * every failure falls through to a real database read.
 *
 * Invalidation is version-based rather than pattern-based: bumping a version
 * integer orphans every previously written key instantly, which is a single
 * atomic write instead of a SCAN over the keyspace. Orphaned keys expire on
 * their own TTL.
 */

import { Redis } from '@upstash/redis';
import { redisConfig, type IntegrationStatus } from '@/lib/env';
import { logger } from '@/lib/logger';
import { sha256, stableStringify } from '@/lib/ids';

export type CatalogCacheTier = 'MEMORY' | 'REDIS';

const KEY_NAMESPACE = 'catalog:v1';
const VERSION_KEY = `${KEY_NAMESPACE}:version`;

/** Storefront staleness budget. Short enough to be unnoticeable, long enough to matter. */
export const DEFAULT_CATALOG_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 3_600;

export function catalogTtlSeconds(): number {
  const raw = process.env.CATALOG_CACHE_TTL_SECONDS;
  if (!raw || !/^\d+$/.test(raw.trim())) return DEFAULT_CATALOG_TTL_SECONDS;
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_CATALOG_TTL_SECONDS;
  return Math.min(parsed, MAX_TTL_SECONDS);
}

export interface CatalogCacheStats {
  tier: CatalogCacheTier;
  /** In-process counters. Not a substitute for a real metrics backend. */
  entries: number;
  hits: number;
  misses: number;
  writes: number;
  invalidations: number;
  redisErrors: number;
}

export interface CatalogCache {
  readonly tier: CatalogCacheTier;
  /** IntegrationStatus for the backing store: REAL or NOT_CONFIGURED. */
  readonly status: IntegrationStatus;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  invalidate(): Promise<void>;
  stats(): CatalogCacheStats;
}

// ---------------------------------------------------------------------------
// Memory tier
// ---------------------------------------------------------------------------

interface MemoryEntry {
  value: unknown;
  expiresAt: number;
}

interface MemoryState {
  entries: Map<string, MemoryEntry>;
  version: number;
  hits: number;
  misses: number;
  writes: number;
  invalidations: number;
  redisErrors: number;
}

function newMemoryState(): MemoryState {
  return {
    entries: new Map(),
    version: 1,
    hits: 0,
    misses: 0,
    writes: 0,
    invalidations: 0,
    redisErrors: 0,
  };
}

/** Module-level so a dev-mode module reload does not silently drop the cache. */
const globalForCache = globalThis as unknown as { catalogMemoryState?: MemoryState };
const memoryState: MemoryState = globalForCache.catalogMemoryState ?? newMemoryState();
globalForCache.catalogMemoryState = memoryState;

function pruneMemory(now: number): void {
  for (const [key, entry] of memoryState.entries) {
    if (entry.expiresAt <= now) memoryState.entries.delete(key);
  }
}

function memoryVersionedKey(key: string): string {
  return `${KEY_NAMESPACE}:m${memoryState.version}:${key}`;
}

// ---------------------------------------------------------------------------
// Cache construction
// ---------------------------------------------------------------------------

let cachedInstance: CatalogCache | null = null;
let warnedAboutDegradation = false;

function createMemoryCache(): CatalogCache {
  const ttlSeconds = catalogTtlSeconds();
  return {
    tier: 'MEMORY',
    status: 'NOT_CONFIGURED',
    async get<T>(key: string): Promise<T | null> {
      const now = Date.now();
      pruneMemory(now);
      const entry = memoryState.entries.get(memoryVersionedKey(key));
      if (!entry) {
        memoryState.misses += 1;
        return null;
      }
      if (entry.expiresAt <= now) {
        memoryState.entries.delete(memoryVersionedKey(key));
        memoryState.misses += 1;
        return null;
      }
      memoryState.hits += 1;
      return entry.value as T;
    },
    async set<T>(key: string, value: T): Promise<void> {
      memoryState.entries.set(memoryVersionedKey(key), {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      memoryState.writes += 1;
    },
    async invalidate(): Promise<void> {
      memoryState.version += 1;
      memoryState.entries.clear();
      memoryState.invalidations += 1;
    },
    stats(): CatalogCacheStats {
      pruneMemory(Date.now());
      return {
        tier: 'MEMORY',
        entries: memoryState.entries.size,
        hits: memoryState.hits,
        misses: memoryState.misses,
        writes: memoryState.writes,
        invalidations: memoryState.invalidations,
        redisErrors: memoryState.redisErrors,
      };
    },
  };
}

function createRedisCache(client: Redis, redisBackedMemory: CatalogCache): CatalogCache {
  const ttlSeconds = catalogTtlSeconds();

  /**
   * The shared version. Read on every operation so an invalidation in one
   * instance is visible in all of them immediately.
   */
  async function redisVersion(): Promise<number> {
    const raw = await client.get<number | string>(VERSION_KEY);
    if (raw === null || raw === undefined) {
      await client.set(VERSION_KEY, 1);
      return 1;
    }
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  }

  function noteRedisFailure(operation: string, error: unknown): void {
    memoryState.redisErrors += 1;
    logger.warn('Catalog cache: Redis operation failed, falling back to database read', {
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    tier: 'REDIS',
    status: 'REAL',
    async get<T>(key: string): Promise<T | null> {
      try {
        const version = await redisVersion();
        const value = await client.get<T>(`${KEY_NAMESPACE}:r${version}:${key}`);
        if (value === null || value === undefined) {
          // Not in the shared cache; the process-local copy may still be warm.
          return redisBackedMemory.get<T>(key);
        }
        return value;
      } catch (error) {
        noteRedisFailure('get', error);
        return redisBackedMemory.get<T>(key);
      }
    },
    async set<T>(key: string, value: T): Promise<void> {
      try {
        const version = await redisVersion();
        await client.set(`${KEY_NAMESPACE}:r${version}:${key}`, value, { ex: ttlSeconds });
      } catch (error) {
        noteRedisFailure('set', error);
      }
      // Always keep a local copy: it keeps the storefront warm if Redis blips.
      await redisBackedMemory.set<T>(key, value);
    },
    async invalidate(): Promise<void> {
      try {
        await client.incr(VERSION_KEY);
      } catch (error) {
        noteRedisFailure('invalidate', error);
      }
      await redisBackedMemory.invalidate();
    },
    stats(): CatalogCacheStats {
      return redisBackedMemory.stats();
    },
  };
}

/**
 * The process-wide catalog cache. Redis-backed when configured, memory-only
 * (with one explicit warning) when not. Never throws: an unusable cache is a
 * performance problem, not an outage.
 */
export function catalogCache(): CatalogCache {
  if (cachedInstance) return cachedInstance;

  const memory = createMemoryCache();

  if (!redisConfig.configured) {
    if (!warnedAboutDegradation) {
      warnedAboutDegradation = true;
      logger.warn(
        'Catalog cache running in MEMORY-ONLY mode: UPSTASH_REDIS_REST_URL/TOKEN is NOT_CONFIGURED. ' +
          'Each serverless instance keeps its own short-lived copy, so catalog reads may be staler ' +
          'on some instances than others until the TTL expires.',
        { tier: 'MEMORY', ttlSeconds: catalogTtlSeconds() },
      );
    }
    cachedInstance = memory;
    return cachedInstance;
  }

  // redisConfig.configured is true, so url and token are both present.
  const client = new Redis({ url: redisConfig.url, token: redisConfig.token });
  cachedInstance = createRedisCache(client, memory);
  return cachedInstance;
}

/**
 * Cache health for /api/health and the admin panel. `status` is the backing
 * store's integration status; `tier` is what is actually running.
 */
export function catalogCacheStatus(): {
  tier: CatalogCacheTier;
  store: IntegrationStatus;
  ttlSeconds: number;
  degraded: boolean;
} {
  const cache = catalogCache();
  return {
    tier: cache.tier,
    store: cache.status,
    ttlSeconds: catalogTtlSeconds(),
    degraded: cache.tier === 'MEMORY',
  };
}

/**
 * Drops every cached catalog read. Call after ANY write that changes what the
 * storefront shows: product create/update/archive, pricing changes, and every
 * inventory transition that moves `inventoryCount`.
 *
 * Fire-and-forget safe: it swallows its own failures so it can be called from
 * inside a transaction without holding row locks over a network round trip.
 */
export function invalidateCatalogCache(): void {
  void catalogCache()
    .invalidate()
    .catch((error: unknown) => {
      logger.warn('Catalog cache invalidation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

/** Stable signature for a list query, so equivalent filters share a key. */
export function listCacheSignature(filters: unknown): string {
  return sha256(stableStringify(filters ?? {})).slice(0, 32);
}

export function productListCacheKey(filters: unknown): string {
  return `list:${listCacheSignature(filters)}`;
}

export function productByIdCacheKey(id: string): string {
  return `product:${id}`;
}

export function productBySlugCacheKey(slug: string): string {
  return `slug:${slug}`;
}

/** Test/admin helper: forget the process-local memory tier immediately. */
export function resetCatalogCacheForTests(): void {
  memoryState.entries.clear();
  memoryState.version += 1;
  memoryState.hits = 0;
  memoryState.misses = 0;
  memoryState.writes = 0;
  memoryState.invalidations = 0;
  memoryState.redisErrors = 0;
  cachedInstance = null;
  warnedAboutDegradation = false;
}