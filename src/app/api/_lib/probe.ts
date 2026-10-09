/**
 * Shared probe plumbing for `/api/health` and `/api/ready`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Liveness and readiness are different questions asked of the same
 * dependencies, so they must ask them with the SAME primitives. Two copies of
 * `checkDatabase()`, two copies of the integration-key list and two copies of
 * the no-store headers would drift, and the drift would show up as the two
 * endpoints disagreeing about whether the database is reachable — which is
 * precisely the bug an operator cannot debug from a dashboard.
 *
 * What is deliberately NOT here: the decision logic. Whether an unreachable
 * dependency means `degraded` (health) or `not_ready` (readiness) is a policy
 * question and each route answers its own, because the two answers differ for
 * good reasons. Only the measurement is shared.
 *
 * SECRET SAFETY
 * -------------
 * This module touches no secret and no raw credential. `checkDatabase()` is
 * the one place a driver message can enter, and it is handed back as an opaque
 * `error: string` for the caller to pass through `redact.ts` — never returned
 * raw from here.
 */

import { checkDatabase } from '@/db/prisma';
import { integrationStatus } from '@/lib/env';
import { recordDatabaseProbe } from '@/observability/metrics';

/**
 * Health is a live probe and readiness is a routing decision. Neither is ever
 * a cached document, so both answer with the same headers.
 */
export const NO_STORE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

/**
 * Keys of `integrationStatus()` that carry a status (i.e. are not a list).
 *
 * `paymentMethods` is deliberately excluded: it is a `PaymentMethodKey[]`, not
 * an `IntegrationStatus`, so it can never be `NOT_CONFIGURED`.
 */
export const INTEGRATION_KEYS = ['payments', 'email', 'redis', 'queue', 'encryption'] as const;

export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

export type IntegrationSnapshot = ReturnType<typeof integrationStatus>;

/** Every integration currently reporting `NOT_CONFIGURED`, in a stable order. */
export function notConfiguredIntegrations(
  integrations: IntegrationSnapshot,
): IntegrationKey[] {
  return INTEGRATION_KEYS.filter((key) => integrations[key] === 'NOT_CONFIGURED');
}

export interface DatabaseProbeResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * The database probe, plus the metric recording that must accompany it.
 *
 * `timeoutMs` is optional and is used only by readiness, which runs on a much
 * tighter loop than health and cannot afford to sit on a socket. The race does
 * not CANCEL the in-flight query — Prisma has no portable abort for
 * `$queryRaw` — it only stops waiting for it. The orphaned promise is still
 * awaited internally by `Promise.race`, so its eventual rejection is handled
 * rather than becoming an unhandled rejection.
 */
export async function probeDatabase(timeoutMs?: number): Promise<DatabaseProbeResult> {
  const started = Date.now();
  const pending = checkDatabase();

  let result: DatabaseProbeResult;
  if (timeoutMs === undefined) {
    result = await pending;
  } else {
    const timedOut = Symbol('database probe timed out');
    const outcome = await Promise.race([
      pending,
      new Promise<typeof timedOut>((resolve) => {
        const timer = setTimeout(() => resolve(timedOut), timeoutMs);
        // Do not hold the event loop open for a deadline we no longer need.
        timer.unref?.();
      }),
    ]);
    result =
      outcome === timedOut
        ? {
            ok: false,
            latencyMs: Date.now() - started,
            error: `database probe did not answer within ${timeoutMs}ms`,
          }
        : (outcome as DatabaseProbeResult);
  }

  // Recorded exactly once, by exactly one function, so `database_up` cannot
  // disagree between the two endpoints.
  recordDatabaseProbe(result.ok, result.latencyMs);
  return result;
}

/** JSON with the no-store headers attached. `JSON.stringify(body, null, 2)`. */
export function jsonProbe(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...NO_STORE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}