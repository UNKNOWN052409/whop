/**
 * Readiness (spec §24).
 *
 * LIVENESS vs READINESS — WHY THIS IS NOT `/api/health`
 * ---------------------------------------------------
 * `/api/health` answers "should this process be RESTARTED?". `/api/ready`
 * answers "should TRAFFIC be routed here?". They differ on purpose, and the
 * difference is the whole reason this file exists:
 *
 *   - A restart cannot fix a missing environment variable or a provider outage.
 *     So health reports `degraded` (HTTP 200) for those and keeps serving: an
 *     orchestrator that killed the process would only remove the one copy of
 *     the truth an operator needs.
 *   - Traffic SHOULD stop when this instance cannot take a payment end to end.
 *     A storefront that keeps selling when fulfilment cannot happen collects
 *     more paid orders it cannot deliver; stopping is the cheaper failure.
 *
 * So the same measurements feed two different verdicts. The measurements
 * themselves come from `../_lib/probe.ts` — `checkDatabase()` from
 * `@/db/prisma`, `integrationStatus()` from `@/lib/env`, the metric recording
 * and the no-store headers. There is exactly ONE database probe in this
 * codebase; if the two endpoints ever disagreed about whether Postgres was
 * reachable, the dashboards would be lying and nobody could tell which one.
 *
 * COST
 * ----
 * Readiness is polled far more often than liveness (seconds vs minutes), so it
 * is deliberately the cheap half: one `SELECT 1`, one `integrationStatus()`
 * evaluation, no queue-depth counts, no worker-lease scan, no alert evaluation.
 * That is why it does NOT call `collectHeartbeatReport()` — a readiness probe
 * that runs four more queries on every poll is a load generator pointed at the
 * database it is trying to protect. `/api/health` and `/api/metrics` remain
 * the places to look for backlog and worker liveness.
 *
 * SECRET SAFETY
 * -------------
 * This response is public and unauthenticated, exactly like `/api/health`, and
 * is held to the same rule: three-valued statuses (REAL / SANDBOX /
 * NOT_CONFIGURED), booleans, small integers and fixed enum strings. Nothing
 * else crosses the boundary.
 *
 * It is in fact STRICTER than `/api/health` in one respect, deliberately. The
 * database failure reason is NOT included here, only the boolean. A Prisma
 * driver message routinely quotes the host and port it tried
 * (`Can't reach database server at db-xyz.internal:5432`), and `redact.ts`
 * removes credentials but not hostnames. Health is an operator surface opened
 * on purpose and pasted into a ticket; readiness is polled by every load
 * balancer and every prober on the internet, so it must not become an oracle
 * for discovering where — or whether — the database lives. An operator who
 * needs the driver message already has `/api/health`.
 */

import { integrationStatus } from '@/lib/env';
import { jsonProbe, probeDatabase } from '../_lib/probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Hard cap on the database probe. `vercel.json` gives this route 5s; the probe
 * gets 2.5s of it so a hung TCP connect produces a fast, honest `not_ready`
 * instead of a function instance being held for the platform maximum. The
 * function is idle either way — waiting is what costs.
 */
const DATABASE_PROBE_TIMEOUT_MS = 2_500;

/**
 * Fixed, non-configurable reason codes.
 *
 * A union of literals, not free text: nothing that reaches this list can carry
 * a hostname, a DSN or a variable value, so the reasons array cannot become a
 * side channel no matter which dependency is down.
 */
const READINESS_REASONS = {
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  PAYMENT_PROVIDER_NOT_CONFIGURED: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
  QUEUE_NOT_CONFIGURED: 'QUEUE_NOT_CONFIGURED',
  ENCRYPTION_NOT_CONFIGURED: 'ENCRYPTION_NOT_CONFIGURED',
} as const;

type ReadinessReason = (typeof READINESS_REASONS)[keyof typeof READINESS_REASONS];

/**
 * WHAT MAKES AN INSTANCE NOT READY
 * =================================
 *
 * BLOCKING — traffic must stop:
 *
 *  1. `database.ok === false`
 *     `/api/checkout` writes the Order (with its price snapshot) and the
 *     Payment row in Postgres BEFORE it calls the provider. No database means
 *     every checkout 500s with no durable record of the attempt. There is
 *     nothing this instance can usefully do, and nothing a restart would fix.
 *
 *  2. `payments` is `NOT_CONFIGURED`
 *     `getPaymentProvider()` returns `null` and `/api/checkout` already answers
 *     503 `PROVIDER_NOT_CONFIGURED`. There is no substitute provider and there
 *     will not be one: a checkout that "succeeds" without a real charge is the
 *     worst failure a payment platform can have.
 *
 *  3. `queue` is `NOT_CONFIGURED`
 *     This is the correctness case, and it is different in kind from the other
 *     two. `enqueueFulfillment()` calls `assertDurableQueueConfigured()`, which
 *     throws 503 rather than running fulfillment inline — deliberately, because
 *     an inline run inside a webhook handler risks duplicate codes and
 *     duplicate charges. So with no queue a verified payment leaves the
 *     webhook having durably recorded NOTHING: no FulfillmentJob, no allocated
 *     code, and no retry. The money is taken and the customer waits forever.
 *     Taking more orders makes that worse, so readiness says no.
 *     Note what is NOT asserted: worker liveness. A `WorkerLease` is shared
 *     Postgres state across all instances, so "no worker holds a lease right
 *     now" is frequently true on a healthy deploy (the Inngest worker is a
 *     separate process) and gating on it would refuse all revenue for a
 *     condition this instance cannot fix. Backlog and worker liveness belong
 *     on `/api/health` and `/api/metrics`, where a human is watching.
 *
 *  4. `encryption` is `NOT_CONFIGURED`
 *     Redeem codes are sealed with AES-256-GCM and revealed only at send time.
 *     Without the key, delivery cannot decrypt what was allocated, so a paid
 *     customer's code is unrecoverable. `assertProductionConfig()` already
 *     refuses to boot a production instance without it, so this is the local /
 *     preview case — where it is exactly the signal a developer needs before
 *     seeding anything.
 *
 * NOT BLOCKING — reported, never hidden:
 *
 *  5. `redis` is `NOT_CONFIGURED` -> still ready.
 *     Redis backs two things here: the rate limiter and the catalog cache.
 *     BOTH already degrade to per-process memory on their own, loudly and once
 *     per process (`public-rate-limit.ts`, `catalog/cache-control.ts`). Making
 *     readiness refuse every request because a cache is missing converts an
 *     abuse-control and latency degradation into zero revenue — strictly worse
 *     than serving with weaker limits, which is the trade the code already made
 *     and documented. It is surfaced in `degraded` so the condition is
 *     impossible to miss.
 *
 *  6. `email` is `NOT_CONFIGURED` -> still ready. THE DELIBERATE ASYMMETRY.
 *     Email looks as load-bearing as the queue (it is the delivery channel),
 *     so it is worth being precise about why it is treated differently:
 *
 *       - With no QUEUE, nothing about the paid order is durable. The webhook
 *         has nowhere to put the work and no recovery path can find it.
 *       - With no EMAIL, the work IS durable. The FulfillmentJob and the
 *         Delivery row are written before the send is attempted, the code
 *         ciphertext is retained (see `delivery-service.ts` — "if the customer
 *         never receives the mail we still hold the ciphertext, so the code is
 *         recoverable"), and `recoverStalledJobs()` plus the 5-minute
 *         fulfillment-recovery cron re-drive it once the provider is set.
 *         Delivery is DELAYED, not lost.
 *
 *     So refusing traffic for an email misconfiguration would convert "recover
 *     in five minutes once configured" into "no revenue until someone notices",
 *     and would do it for the single most commonly forgotten variable in the
 *     file. In production this state is unreachable anyway:
 *     `assertProductionConfig()` fails the boot. Blocking is therefore all
 *     cost and no benefit, which is the definition of the wrong rule.
 *
 * The rule in one line: block when this instance cannot complete a paid order,
 * or cannot record that it was asked to.
 */

export async function GET(): Promise<Response> {
  const integrations = integrationStatus();
  const database = await probeDatabase(DATABASE_PROBE_TIMEOUT_MS);

  const notConfiguredPayments = integrations.payments === 'NOT_CONFIGURED';
  const notConfiguredQueue = integrations.queue === 'NOT_CONFIGURED';
  const notConfiguredEncryption = integrations.encryption === 'NOT_CONFIGURED';

  const reasons: ReadinessReason[] = [];
  if (!database.ok) reasons.push(READINESS_REASONS.DATABASE_UNAVAILABLE);
  if (notConfiguredPayments) reasons.push(READINESS_REASONS.PAYMENT_PROVIDER_NOT_CONFIGURED);
  if (notConfiguredQueue) reasons.push(READINESS_REASONS.QUEUE_NOT_CONFIGURED);
  if (notConfiguredEncryption) reasons.push(READINESS_REASONS.ENCRYPTION_NOT_CONFIGURED);

  const ready = reasons.length === 0;

  /**
   * Integrations that are missing but did not stop us serving. Reported so a
   * `ready` response is never mistaken for "everything is wired up" — that
   * claim is `/api/health`'s to make.
   */
  const degraded: string[] = [];
  if (integrations.email === 'NOT_CONFIGURED') degraded.push('email');
  if (integrations.redis === 'NOT_CONFIGURED') degraded.push('redis');

  const body = {
    status: ready ? 'ready' : 'not_ready',
    ready,
    timestamp: new Date().toISOString(),
    reasons,
    degraded,
    /**
     * Booleans and three-valued statuses only. `latencyMs` is a duration this
     * instance measured itself; there is no `error` field, by design.
     */
    checks: {
      database: {
        ok: database.ok,
        ...(database.latencyMs === undefined ? {} : { latencyMs: database.latencyMs }),
      },
      paymentProvider: { status: integrations.payments, ok: !notConfiguredPayments },
      queue: { status: integrations.queue, ok: !notConfiguredQueue },
      encryption: { status: integrations.encryption, ok: !notConfiguredEncryption },
      email: { status: integrations.email, ok: integrations.email !== 'NOT_CONFIGURED' },
      redis: { status: integrations.redis, ok: integrations.redis !== 'NOT_CONFIGURED' },
    },
  };

  // 200 only when traffic may arrive. Anything else is 503, so a load balancer
  // or Vercel's own health gate stops routing here instead of failing at
  // checkout.
  return jsonProbe(body, ready ? 200 : 503);
}