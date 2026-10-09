/**
 * Worker lease (spec §18).
 *
 * Scheduled reconciliation runs must not overlap. Two concurrent runs would
 * both page the provider, both race to write the same discrepancy records, and
 * — worst of all — could interleave an escalation into MANUAL_REVIEW with an
 * order that has since moved on.
 *
 * The lease is a row in `WorkerLease`, not an in-process mutex: serverless
 * invocations are separate processes, so an in-memory flag would be worthless.
 *
 * CRASH SAFETY: every lease carries an `expiresAt`. A holder that crashes
 * mid-run never releases, so acquisition treats an expired lease as free. This
 * is a deliberate trade — a crashed holder's run is assumed dead, and the only
 * consequence is that the next scheduled run may overlap with a genuinely
 * still-running one whose lease lapsed. The TTL is therefore set well above the
 * expected run duration and renewed by a heartbeat.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '@/db/prisma';
import { logger } from '@/lib/logger';

/** Default lease name. One reconciliation runner per deployment. */
export const RECONCILIATION_LEASE_NAME = 'reconciliation';

/**
 * 15 minutes. A full 72h window against the provider can take several minutes;
 * 15 minutes leaves ample headroom while still recovering quickly from a
 * crashed holder.
 */
export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;

/** Hard ceiling on a single lease. A holder that lives this long is a bug. */
export const MAX_LEASE_TTL_MS = 60 * 60 * 1000;

export interface Lease {
  name: string;
  holderId: string;
  expiresAt: Date;
  acquiredAt: Date;
}

export type AcquireLeaseResult =
  | { ok: true; lease: Lease; /** True when we took over an expired or own lease. */ reclaimed: boolean }
  | { ok: false; reason: 'HELD_BY_OTHER'; lease: Lease | null };

export interface LeaseOptions {
  ttlMs?: number;
  /** Defaults to a per-process id: `pid-uuid`. Override in tests. */
  holderId?: string;
  now?: Date;
}

function defaultHolderId(): string {
  return `pid-${process.pid}-${randomUUID().slice(0, 8)}`;
}

function clampTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs) || ttlMs <= 0) return DEFAULT_LEASE_TTL_MS;
  return Math.min(ttlMs, MAX_LEASE_TTL_MS);
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2002';
}

function toLease(row: {
  name: string;
  holderId: string;
  expiresAt: Date;
  acquiredAt: Date;
}): Lease {
  return {
    name: row.name,
    holderId: row.holderId,
    expiresAt: row.expiresAt,
    acquiredAt: row.acquiredAt,
  };
}

async function readLease(name: string): Promise<Lease | null> {
  const row = await prisma.workerLease.findUnique({ where: { name } });
  return row ? toLease(row) : null;
}

/**
 * Attempts to take the lease.
 *
 * Three cases, in order:
 *   1. no row          -> insert and win;
 *   2. row exists but expired, or already ours -> atomic conditional update
 *      and win. The `updateMany` count is the arbiter, so two processes racing
 *      on an expired lease cannot both believe they won;
 *   3. row held and live by someone else -> lose, and report who holds it so
 *      the caller can log something actionable.
 */
export async function acquireLease(
  name: string = RECONCILIATION_LEASE_NAME,
  options: LeaseOptions = {},
): Promise<AcquireLeaseResult> {
  const holderId = options.holderId ?? defaultHolderId();
  const now = options.now ?? new Date();
  const ttlMs = clampTtl(options.ttlMs);
  const expiresAt = new Date(now.getTime() + ttlMs);

  try {
    const created = await prisma.workerLease.create({ data: { name, holderId, expiresAt } });
    logger.info('Worker lease acquired', { lease: name, holderId, ttlMs });
    return { ok: true, lease: toLease(created), reclaimed: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  // A row exists. Take it only if it has expired or is already ours.
  const reclaimed = await prisma.workerLease.updateMany({
    where: {
      name,
      OR: [{ expiresAt: { lte: now } }, { holderId }],
    },
    data: { holderId, expiresAt, acquiredAt: now },
  });

  if (reclaimed.count === 1) {
    const lease = await readLease(name);
    logger.info('Worker lease reclaimed', { lease: name, holderId, ttlMs, expiresAt: expiresAt.toISOString() });
    return {
      ok: true,
      lease: lease ?? { name, holderId, expiresAt, acquiredAt: now },
      reclaimed: true,
    };
  }

  const held = await readLease(name);
  if (held === null) {
    // The holder released between our create failure and our read. One retry
    // turns this benign race into a normal acquisition.
    try {
      const created = await prisma.workerLease.create({ data: { name, holderId, expiresAt } });
      return { ok: true, lease: toLease(created), reclaimed: false };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const current = await readLease(name);
      return { ok: false, reason: 'HELD_BY_OTHER', lease: current };
    }
  }

  return { ok: false, reason: 'HELD_BY_OTHER', lease: held };
}

/**
 * Extends a lease we still hold. Returns null when the lease was taken over
 * (expired and reclaimed by someone else) — the caller should then abandon the
 * run rather than keep writing records under a lease it no longer owns.
 */
export async function renewLease(
  lease: Lease,
  options: { ttlMs?: number; now?: Date } = {},
): Promise<Lease | null> {
  const now = options.now ?? new Date();
  const ttlMs = clampTtl(options.ttlMs);
  const expiresAt = new Date(now.getTime() + ttlMs);

  const renewed = await prisma.workerLease.updateMany({
    where: { name: lease.name, holderId: lease.holderId, expiresAt: { gt: now } },
    data: { expiresAt },
  });
  if (renewed.count !== 1) return null;

  return { ...lease, expiresAt, acquiredAt: lease.acquiredAt };
}

/** Releases a lease we hold. No-op (count 0) if it was already taken over. */
export async function releaseLease(lease: Lease): Promise<boolean> {
  const released = await prisma.workerLease.deleteMany({
    where: { name: lease.name, holderId: lease.holderId },
  });
  return released.count > 0;
}

export interface Heartbeat {
  /** Stop renewing. Called in the `finally` of a lease-protected section. */
  stop: () => void;
  /** False once a renewal has failed — the lease was taken over. */
  healthy: () => boolean;
}

/**
 * Renews the lease every `ttlMs / 3` for as long as the returned heartbeat
 * lives. The timer is unref'd so a pending heartbeat never keeps a serverless
 * invocation alive.
 */
export function startLeaseHeartbeat(
  lease: Lease,
  options: { ttlMs?: number } = {},
): Heartbeat {
  const ttlMs = clampTtl(options.ttlMs);
  const intervalMs = Math.max(5_000, Math.floor(ttlMs / 3));
  let healthy = true;

  const timer = setInterval(() => {
    void renewLease(lease, { ttlMs })
      .then((next) => {
        if (next === null) {
          healthy = false;
          logger.error('Worker lease renewal failed — lease was taken over', {
            lease: lease.name,
            holderId: lease.holderId,
          });
        }
      })
      .catch((error: unknown) => {
        healthy = false;
        logger.error('Worker lease renewal error', {
          lease: lease.name,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop: () => clearInterval(timer),
    healthy: () => healthy,
  };
}

export type WithLeaseResult<T> =
  | { ok: true; value: T; lease: Lease }
  | { ok: false; reason: 'HELD_BY_OTHER'; lease: Lease | null };

/**
 * Runs `fn` under the lease and always releases it.
 *
 * `fn` receives a `heartbeat` so a long run can stop early if it lost the
 * lease mid-flight; callers that ignore it simply run to completion.
 */
export async function withLease<T>(
  name: string,
  fn: (lease: Lease, heartbeat: Heartbeat) => Promise<T>,
  options: LeaseOptions = {},
): Promise<WithLeaseResult<T>> {
  const acquired = await acquireLease(name, options);
  if (!acquired.ok) {
    logger.warn('Skipping run — worker lease held by another holder', {
      lease: name,
      holderId: acquired.lease?.holderId ?? null,
      expiresAt: acquired.lease?.expiresAt?.toISOString() ?? null,
    });
    return { ok: false, reason: 'HELD_BY_OTHER', lease: acquired.lease };
  }

  const heartbeat = startLeaseHeartbeat(acquired.lease, { ttlMs: options.ttlMs });
  try {
    const value = await fn(acquired.lease, heartbeat);
    return { ok: true, value, lease: acquired.lease };
  } finally {
    heartbeat.stop();
    try {
      await releaseLease(acquired.lease);
    } catch (error) {
      // A failed release is not fatal: the TTL reclaims it.
      logger.warn('Failed to release worker lease — it will expire', {
        lease: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}