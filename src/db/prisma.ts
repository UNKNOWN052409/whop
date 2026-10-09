import { PrismaClient, Prisma } from '@prisma/client';
import { appConfig, isProduction } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * Prisma client singleton.
 *
 * On Vercel every serverless invocation is a fresh process, so a module-level
 * global is what prevents a new connection pool per request (spec §16).
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction
      ? [
          // WARN/ERROR only in production; a dev-only 'query' log drowns real output.
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
  });

if (!isProduction) globalForPrisma.prisma = prisma;

prisma.$on('error' as never, (e: { message: string }) => {
  logger.error('Prisma error', { error: e.message });
});

export type { Prisma } from '@prisma/client';
export { PrismaClient };

/**
 * True when a database connection is expected to work. Used by tests and the
 * health endpoint so a missing DATABASE_URL reports NOT CONFIGURED instead of
 * throwing an opaque driver error.
 */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Runs a callback inside a serializable-enough transaction.
 *
 * Postgres defaults to READ COMMITTED, which is NOT sufficient for inventory
 * allocation: two concurrent readers can both observe the same AVAILABLE row.
 * Those code reservations run at REPEATABLE READ or SERIALIZABLE inside
 * `src/inventory/allocate.ts` with an explicit row lock. This helper exists for
 * the simpler multi-write operations (e.g. order + transition log).
 */
export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  return prisma.$transaction(fn, {
    maxWait: options?.maxWait ?? 5_000,
    timeout: options?.timeout ?? 15_000,
  });
}

/**
 * Retry wrapper for transient database faults (P2034 = write conflict /
 * deadlock). Inventory allocation leans on this for lock contention rather
 * than relying on a single lucky attempt.
 */
export async function withTransactionRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withTransaction(fn);
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string })?.code;
      const isTransient =
        code === 'P2034' || // Transaction failed due to write conflict
        code === 'P2028' || // Transaction API error
        code === 'P1008';    // Operation timed out

      if (!isTransient || attempt === maxAttempts) throw error;

      const backoffMs = 2 ** attempt * 50 + Math.floor(Math.random() * 100);
      logger.warn('Retrying transaction after transient conflict', {
        attempt,
        backoffMs,
        code,
      });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}

/** Health probe used by /api/health. */
export async function checkDatabase(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (!isDatabaseConfigured()) return { ok: false, error: 'DATABASE_URL is not set' };
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const runtimeInfo = {
  nodeEnv: appConfig.nodeEnv,
  isProduction,
};