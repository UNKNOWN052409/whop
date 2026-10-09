/**
 * Queue depth and worker liveness (spec §22, §18).
 *
 * Two questions an operator must be able to answer without a shell:
 *
 *   1. "Is work piling up?"  -> how many fulfillment jobs are still pending,
 *      and how old is the oldest one. A backlog is a customer-visible failure:
 *      they paid $3 and their $1 code has not arrived.
 *   2. "Is anything actually running?" -> a queue with depth and no live worker
 *      is a silent outage. `WorkerLease` is the durable answer: a row exists
 *      only while a holder is alive and it carries an `expiresAt`, so a crashed
 *      worker ages out instead of lying forever.
 *
 * HONESTY NOTES
 *
 *  - The Prisma client is imported lazily. Importing this module (from
 *    instrumentation, or from a route that never touches the queue) must not
 *    open a database connection.
 *  - A failed probe reports `ok: false` with a redacted reason. It never
 *    reports depth 0, because "I could not ask" and "there is no work" are
 *    very different claims and only one of them is good news.
 *  - Nothing here reads customer data: counts, ages, timestamps and internal
 *    worker identifiers only.
 */

import { logger } from '@/lib/logger';
import { queueOldestAge, recordWorkerHeartbeat, setQueueDepth } from './metrics';
import { safeDiagnostic } from './redact';

/** Job states that count as "work not finished yet". */
export const ACTIVE_FULFILLMENT_STATUSES = ['PENDING', 'RUNNING'] as const;

export interface QueueSnapshot {
  ok: boolean;
  /** PENDING + RUNNING jobs. Null when the probe failed. */
  depth: number | null;
  pending: number | null;
  running: number | null;
  /** Age of the oldest PENDING job in seconds; null when there is none. */
  oldestPendingAgeSeconds: number | null;
  error?: string;
}

export interface WorkerHeartbeatSnapshot {
  name: string;
  /** A live, unexpired lease. */
  held: boolean;
  /** `pid-<pid>-<uuid>` from lease.ts — an internal id, never a credential. */
  holderId: string | null;
  acquiredAt: string | null;
  expiresAt: string | null;
  /** Negative once the lease has expired: that is the crash signal. */
  expiresInSeconds: number | null;
}

export interface HeartbeatReport {
  ok: boolean;
  queue: QueueSnapshot;
  workers: WorkerHeartbeatSnapshot[];
  error?: string;
}

type PrismaModule = typeof import('@/db/prisma');

/**
 * Lazily resolves the Prisma client, or null when the database is not
 * configured. Null is a reportable state (spec §24), not an error to throw.
 */
async function client(): Promise<PrismaModule['prisma'] | null> {
  const mod: PrismaModule = await import('@/db/prisma');
  if (!mod.isDatabaseConfigured()) return null;
  return mod.prisma;
}

function unavailable(reason: string): QueueSnapshot {
  return {
    ok: false,
    depth: null,
    pending: null,
    running: null,
    oldestPendingAgeSeconds: null,
    error: reason,
  };
}

/**
 * Counts unfinished fulfillment work and ages the queue gauges.
 *
 * Never throws: a queue probe that fails must not turn /api/health into a 500
 * with no information, and it must not report a healthy zero backlog.
 */
export async function sampleQueueDepth(now: number = Date.now()): Promise<QueueSnapshot> {
  let db: PrismaModule['prisma'] | null;
  try {
    db = await client();
  } catch (error) {
    return unavailable(safeDiagnostic(error));
  }
  if (!db) return unavailable('DATABASE_URL is not set');

  try {
    const [pending, running, oldest] = await Promise.all([
      db.fulfillmentJob.count({ where: { status: 'PENDING' } }),
      db.fulfillmentJob.count({ where: { status: 'RUNNING' } }),
      db.fulfillmentJob.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const oldestAgeSeconds = oldest
      ? Math.max(0, Math.round((now - oldest.createdAt.getTime()) / 1000))
      : 0;

    const depth = pending + running;
    setQueueDepth(depth);
    queueOldestAge.set(oldestAgeSeconds);

    return { ok: true, depth, pending, running, oldestPendingAgeSeconds: oldestAgeSeconds };
  } catch (error) {
    logger.warn('Queue depth probe failed', { error: safeDiagnostic(error) });
    return unavailable(safeDiagnostic(error));
  }
}

/**
 * Reads every `WorkerLease` row and reports liveness.
 *
 * An expired row is reported as `held: false` with a negative
 * `expiresInSeconds` rather than being hidden — a lease that silently vanished
 * is exactly the signal this function exists to surface.
 */
export async function sampleWorkerHeartbeats(
  now: number = Date.now(),
): Promise<WorkerHeartbeatSnapshot[]> {
  let db: PrismaModule['prisma'] | null;
  try {
    db = await client();
  } catch {
    return [];
  }
  if (!db) return [];

  try {
    const rows = await db.workerLease.findMany();
    return rows.map((row) => {
      const expiresInMs = row.expiresAt.getTime() - now;
      const held = expiresInMs > 0;
      recordWorkerHeartbeat(row.name, held, now);
      return {
        name: row.name,
        held,
        holderId: row.holderId,
        acquiredAt: row.acquiredAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        expiresInSeconds: Math.round(expiresInMs / 1000),
      };
    });
  } catch (error) {
    logger.warn('Worker heartbeat probe failed', { error: safeDiagnostic(error) });
    return [];
  }
}

/**
 * One call used by /api/health and by the metrics scrape: samples the queue and
 * the worker leases, refreshes the gauges, and returns the report.
 *
 * `ok` is false when the database could not be reached at all. A reachable
 * database with an empty lease table is `ok: true` with zero workers — a queue
 * that is simply not running yet is a fact, not a probe failure.
 */
export async function collectHeartbeatReport(now: number = Date.now()): Promise<HeartbeatReport> {
  const [queue, workers] = await Promise.all([
    sampleQueueDepth(now),
    sampleWorkerHeartbeats(now),
  ]);
  return { ok: queue.ok, queue, workers };
}