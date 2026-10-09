/**
 * Database helpers for the gated integration suites.
 *
 * EVERY suite that touches Postgres goes through `describeWithDatabase`, which
 * is `describe.skipIf(!process.env.TEST_DATABASE_URL)`. In an environment with
 * no database the suite is skipped — it does not error, and it does not silently
 * "pass" a weaker assertion.
 *
 * `resetDatabase` truncates every table in the public schema. It refuses to run
 * unless DATABASE_URL is exactly TEST_DATABASE_URL, so a stray export can never
 * point the truncation at a real database.
 */

import type { PrismaClient } from '@prisma/client';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

/** True only when the developer opted in to database-backed tests. */
export const HAS_TEST_DATABASE = TEST_DATABASE_URL.length > 0;

/** Database-backed suites must be wrapped in this. */
export const describeWithDatabase = describe.skipIf(!HAS_TEST_DATABASE);

/**
 * Imported lazily so a pure unit suite never constructs a PrismaClient (and
 * therefore never opens a connection pool it has no intention of using).
 */
export async function getPrisma(): Promise<PrismaClient> {
  const { prisma } = await import('@/db/prisma');
  return prisma;
}

/**
 * Empties every application table, leaving schema and migrations intact.
 * Discovered from pg_tables rather than hard-coded so a schema change owned by
 * another workstream cannot leave a stale row behind to poison the next test.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  if (process.env.DATABASE_URL !== TEST_DATABASE_URL) {
    throw new Error(
      'Refusing to truncate: DATABASE_URL is not TEST_DATABASE_URL. ' +
        'Integration tests may only run against a dedicated test database.',
    );
  }
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'",
  );
  if (tables.length === 0) return;
  const quoted = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}

export async function disconnectDatabase(prisma: PrismaClient | null): Promise<void> {
  if (!prisma) return;
  await prisma.$disconnect().catch(() => undefined);
}
