/**
 * Durable Inngest functions (spec §16, §20, §21).
 *
 * Everything here is written to be replayed. Inngest re-delivers steps after a
 * timeout, a crash, or a deploy, and it re-runs a function whose event is
 * re-sent by the provider. So the rule is the same as in
 * src/fulfillment/service.ts: every step is idempotent, and the durable state
 * that decides "did this already happen?" lives in Postgres, not in memory.
 *
 * Function inventory:
 *
 *   payment/paid          webhook says paid -> fulfill the order (durable retry
 *                         loop with backoff, then DEAD_LETTER + admin alert)
 *   fulfillment/retry     explicit requeue for one order, same policy, usable
 *                         by an operator from the admin panel
 *   inventory/reaper      hourly cron: release expired code reservations
 *   reconciliation/daily  daily cron: run the reconciliation engine
 *   reconciliation/requested  on-demand reconciliation from the admin panel
 *
 * Note on `idempotency`: it is deliberately NOT set on the fulfillment
 * functions. An idempotency key suppresses a *second run* of the same event,
 * which would also suppress a legitimate retry after a failed run — losing a
 * paid order to save one redundant database query. Concurrency limiting plus an
 * idempotent pipeline gives the same safety without that failure mode.
 */

import { NonRetriableError } from 'inngest';
import { serve as serveInngest } from 'inngest/next';

import { appConfig, inngestConfig } from '@/lib/env';
import { logger } from '@/lib/logger';
import { releaseExpiredReservations } from '@/inventory/release';
import { runReconciliation } from '@/reconcile/engine';
import {
  fulfillOrder,
  getFulfillmentJob,
  retryFulfillment,
  type FulfillOrderResult,
} from '@/fulfillment/service';
import { notifyFulfillmentFailure } from '@/fulfillment/admin-alert';
import { confirmPaymentBeforeFulfillment } from '@/payments/verify';
import { inngest } from './client';

/** Matches FulfillmentJob.maxAttempts. Eight attempts ≈ 45 minutes of backoff. */
const MAX_FULFILLMENT_ATTEMPTS = 8;
/** Backoff envelope between attempts. Full jitter, capped at 10 minutes. */
const FULFILLMENT_BACKOFF_BASE_MS = 5_000;
const FULFILLMENT_BACKOFF_MAX_MS = 10 * 60_000;

/**
 * Exponential backoff with full jitter. Integer milliseconds, no floats in any
 * money-adjacent path (this is time, not money — jitter is intentional).
 */
function backoffMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(
    FULFILLMENT_BACKOFF_MAX_MS,
    FULFILLMENT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  return Math.floor(exponential / 2 + random() * (exponential / 2));
}

/** Narrows an unknown return value to a numeric field without assuming a shape. */
function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

/** Defensive logging for values owned by other modules. */
function describe(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return { result: String(value) };
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 25);
  const out: Record<string, unknown> = {};
  for (const [key, raw] of entries) {
    if (typeof raw === 'object' && raw !== null) {
      out[key] = '[object]';
      continue;
    }
    out[key] = raw;
  }
  return out;
}

/**
 * Outcomes that end the retry loop. FULFILLMENT_FAILED is deliberately absent:
 * once an order fails terminally, retrying it automatically only burns
 * inventory and delays the human decision that actually unblocks the customer.
 */
function isTerminalOutcome(result: FulfillOrderResult): boolean {
  return (
    result.outcome === 'COMPLETED' ||
    result.outcome === 'ALREADY_FULFILLED' ||
    result.outcome === 'HELD_FOR_REVIEW' ||
    result.outcome === 'NOT_READY' ||
    result.outcome === 'FAILED'
  );
}

// ---------------------------------------------------------------------------
// payment/paid
// ---------------------------------------------------------------------------

export const paymentPaidFulfillment = inngest.createFunction(
  {
    id: 'payment/paid',
    name: 'Fulfill paid order',
    description: 'Reserves a redeem code and delivers it for a verified payment.',
    // Concurrency is keyed on the order so two redelivered webhooks for the
    // same order can never race each other into two allocations.
    concurrency: { limit: 1, key: 'event.data.orderId' },
    // Step-level retries on top of the explicit loop below. These cover
    // unexpected throws (a dead database socket, a bug); the loop covers the
    // expected failures the service reports as RETRY_SCHEDULED.
    retries: 3,
  },
  { event: 'redeem-store/payment.paid' as const },
  async ({ event, step }) => {
    const { orderId, orderReference } = event.data;

    logger.info('payment/paid received', {
      orderId,
      orderReference,
      providerEventId: event.data.providerEventId,
    });

    // --- STEP 0: authoritative provider confirmation ------------------------
    // The webhook proved the EVENT is authentic (signature) and bound it to our
    // order snapshot (amount/currency gate), but it deliberately did not call
    // the provider: a slow upstream on the request path turns into a retry
    // storm. Here, in the durable queue, a slow or failed call is simply
    // retried with backoff.
    //
    // This runs BEFORE any inventory is touched, so the spec §8 guarantee -
    // only a VERIFIED payment may release a redeem code - still holds exactly.
    // The providerPaymentId is resolved from the order so a redelivered event
    // cannot pass a different payment id through.
    const verification = await step.run('verify-payment', async () => {
      const outcome = await confirmPaymentBeforeFulfillment(orderId);
      return {
        ok: outcome.ok,
        reason: outcome.reason ?? null,
        retryable: outcome.retryable,
      };
    });

    if (!verification.ok) {
      if (!verification.retryable) {
        // Permanently unconfirmable: the provider says this is not a completed
        // charge, or the provider is NOT CONFIGURED. confirmPaymentBeforeFulfillment
        // has already escalated it to MANUAL_REVIEW with a reconciliation
        // record, so a human owns it. Retrying cannot change the answer.
        logger.error('Payment permanently unconfirmable; escalated, no inventory released', {
          orderId,
          orderReference,
          reason: verification.reason,
        });
        return {
          orderId,
          orderReference,
          outcome: 'HELD_FOR_REVIEW',
          status: 'MANUAL_REVIEW',
        };
      }

      // Transient: the provider was unreachable or had not settled yet. Throw a
      // NORMAL error so Inngest's step retry re-runs this step with backoff.
      // Swallowing this here would mean a customer paid and received nothing.
      logger.warn('Provider confirmation unavailable; will retry before any allocation', {
        orderId,
        orderReference,
        reason: verification.reason,
      });
      throw new Error(
        `Provider confirmation unavailable (${verification.reason ?? 'unknown'}). ` +
          `No inventory was released; retrying.`,
      );
    }

    for (let attempt = 1; attempt <= MAX_FULFILLMENT_ATTEMPTS; attempt += 1) {
      // A unique step id per attempt: reusing an id would return the memoized
      // result and silently skip the retry.
      const result = await step.run(`fulfill-attempt-${attempt}`, () =>
        fulfillOrder(orderId, { source: 'webhook' }),
      );

      if (isTerminalOutcome(result)) {
        if (result.outcome === 'COMPLETED') {
          logger.info('Order fulfilled from payment webhook', { orderId, attempt });
        }
        return result;
      }

      const wait = backoffMs(attempt);
      logger.warn('Fulfillment attempt did not complete; backing off', {
        orderId,
        attempt,
        maxAttempts: MAX_FULFILLMENT_ATTEMPTS,
        outcome: result.outcome,
        waitMs: wait,
      });
      await step.sleep(`backoff-after-attempt-${attempt}`, wait);
    }

    // Out of attempts inside this run: escalate. The order row still says what
    // happened; this makes sure a human is told.
    await step.run('dead-letter-escalation', async () => {
      const result = await retryFulfillment(orderId, { source: 'retry' });
      await notifyFulfillmentFailure({
        severity: 'CRITICAL',
        title: 'Fulfillment retry budget exhausted',
        reason: 'RETRY_BUDGET_EXHAUSTED',
        detail: result.error ?? `no attempt succeeded after ${MAX_FULFILLMENT_ATTEMPTS} attempts`,
        orderId,
        orderReference,
        attempts: result.attempts,
        maxAttempts: result.maxAttempts,
        jobId: result.jobId,
        jobStatus: result.deadLettered ? 'DEAD_LETTER' : 'FAILED',
      });
      return { outcome: result.outcome, attempts: result.attempts };
    });

    // Non-retriable: Inngest must stop, or the budget restarts from scratch.
    throw new NonRetriableError(
      `Fulfillment for order ${orderReference ?? orderId} exhausted ${MAX_FULFILLMENT_ATTEMPTS} attempts`,
    );
  },
);

// ---------------------------------------------------------------------------
// fulfillment/retry
// ---------------------------------------------------------------------------

export const fulfillmentRetry = inngest.createFunction(
  {
    id: 'fulfillment/retry',
    name: 'Retry fulfillment',
    description: 'Re-runs one order with exponential backoff; dead-letters after 8 attempts.',
    concurrency: { limit: 1, key: 'event.data.orderId' },
    retries: 2,
    onFailure: async ({ event, error }) => {
      const orderId = (event.data as { orderId?: string }).orderId;
      logger.error('fulfillment/retry exhausted its own retries', {
        ...(orderId === undefined ? {} : { orderId }),
        error: error.message,
      });
    },
  },
  { event: 'redeem-store/fulfillment.retry' as const },
  async ({ event, step }) => {
    const { orderId, orderReference } = event.data;

    // The job row is the source of truth for the budget, so an operator
    // requeueing an old order does not reset the counter to zero.
    const job = await step.run('load-job', async () => {
      const row = await getFulfillmentJob(orderId);
      return row
        ? { attempts: row.attempts, maxAttempts: row.maxAttempts, status: row.status }
        : null;
    });

    const alreadyExhausted = job !== null && job.attempts >= job.maxAttempts;
    const startAttempt = Math.max(1, job?.attempts ?? event.data.attempt ?? 1);

    if (alreadyExhausted) {
      logger.warn('Retry requested for a job whose budget is already spent', {
        orderId,
        attempts: job?.attempts,
        maxAttempts: job?.maxAttempts,
      });
      return { orderId, outcome: 'SKIPPED_EXHAUSTED' as const, attempts: job?.attempts ?? 0 };
    }

    for (let attempt = startAttempt; attempt < MAX_FULFILLMENT_ATTEMPTS; attempt += 1) {
      // Each iteration is a separate durable step, so a crash mid-loop resumes
      // at the next step instead of re-running completed ones.
      const result = await step.run(`retry-attempt-${attempt + 1}`, () =>
        retryFulfillment(orderId, { source: 'retry' }),
      );

      if (isTerminalOutcome(result) || result.outcome === 'ALREADY_CLAIMED') {
        if (result.outcome === 'COMPLETED' || result.outcome === 'ALREADY_FULFILLED') {
          logger.info('Retry fulfilled the order', { orderId, attempt: attempt + 1 });
          return result;
        }
        if (result.outcome === 'FAILED') return result;
        // HELD_FOR_REVIEW / NOT_READY: nothing a retry can fix.
        if (result.outcome === 'HELD_FOR_REVIEW' || result.outcome === 'NOT_READY') return result;
      }

      const wait = backoffMs(attempt);
      logger.warn('Retry attempt did not complete; backing off', {
        orderId,
        attempt: attempt + 1,
        outcome: result.outcome,
        waitMs: wait,
      });
      await step.sleep(`retry-backoff-${attempt + 1}`, wait);
    }

    await step.run('dead-letter', async () => {
      const result = await retryFulfillment(orderId, { source: 'retry' });
      await notifyFulfillmentFailure({
        severity: 'CRITICAL',
        title: 'Paid order abandoned after the full retry budget',
        reason: 'RETRY_BUDGET_EXHAUSTED',
        detail: result.error ?? 'no attempt succeeded',
        orderId,
        ...(orderReference === undefined ? {} : { orderReference }),
        attempts: result.attempts,
        maxAttempts: result.maxAttempts,
        ...(result.jobId === undefined ? {} : { jobId: result.jobId }),
        jobStatus: result.deadLettered ? 'DEAD_LETTER' : 'FAILED',
      });
      return { outcome: result.outcome, attempts: result.attempts };
    });

    throw new NonRetriableError(`Fulfillment retry budget exhausted for order ${orderId}`);
  },
);

// ---------------------------------------------------------------------------
// inventory/reaper (cron)
// ---------------------------------------------------------------------------

export const inventoryReaper = inngest.createFunction(
  {
    id: 'inventory/reaper',
    name: 'Release expired code reservations',
    description:
      'Hourly sweep returning RESERVED codes whose lease expired to AVAILABLE (spec §11/§21).',
    // Off the hour so every deployment in the world does not hit Postgres at
    // :00 simultaneously.
    retries: 3,
  },
  { cron: '7 * * * *' },
  async ({ step }) => {
    const result: unknown = await step.run('release-expired-reservations', async () => {
      const released = await releaseExpiredReservations();
      logger.info('Inventory reaper released expired reservations', describe(released));
      return released;
    });

    const released = readNumber(result, 'released');
    if (released !== undefined && released > 0) {
      logger.warn('Inventory reaper returned reservations to the pool', {
        released,
        ...describe(result),
      });
    }
    return { released: released ?? 0 };
  },
);

// ---------------------------------------------------------------------------
// reconciliation/daily (cron) + reconciliation/requested
// ---------------------------------------------------------------------------

/**
 * Runs the reconciliation engine owned by another module
 * (`@/reconcile/engine`). The engine writes ReconciliationRecord rows; this
 * function only supplies the window and reports the outcome.
 *
 * The window deliberately OVERLAPS previous runs (72h by default). A
 * forward-only cursor silently misses everything that arrived while a previous
 * run was failing — which is exactly when reconciliation matters most.
 */
async function runReconciliationWindow(lookbackHours: number): Promise<unknown> {
  const from = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const to = new Date();

  const result: unknown = await runReconciliation({ from, to });

  const discrepancies =
    readNumber(result, 'discrepancies') ??
    readNumber(result, 'mismatches') ??
    readNumber(result, 'issues') ??
    readNumber(result, 'openRecords');

  logger.info('Reconciliation run completed', {
    from: from.toISOString(),
    to: to.toISOString(),
    lookbackHours,
    ...(discrepancies === undefined ? {} : { discrepancies }),
    ...describe(result),
  });

  // A run that finds discrepancies is still a SUCCESSFUL run. The HTTP/queue
  // status reports whether the job worked, not whether the data was clean.
  return { lookbackHours, from: from.toISOString(), to: to.toISOString(), ...describe(result) };
}

export const reconciliationDaily = inngest.createFunction(
  {
    id: 'reconciliation/daily',
    name: 'Daily reconciliation',
    description: 'Compares provider-side settlements against local orders (spec §18).',
    // 03:17 UTC: off the hour, and away from the 00:00 provider batch window.
    retries: 2,
    // Never overlap two reconciliation runs — they would double-report the same
    // discrepancy and page twice.
    concurrency: { limit: 1 },
  },
  { cron: '17 3 * * *' },
  async ({ step }) =>
    step.run('run-reconciliation', () =>
      runReconciliationWindow(appConfig.reconciliationLookbackHours),
    ),
);

export const reconciliationRequested = inngest.createFunction(
  {
    id: 'reconciliation/requested',
    name: 'Reconciliation (on demand)',
    description: 'Runs reconciliation outside the daily schedule.',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { event: 'redeem-store/reconciliation.requested' as const },
  async ({ event, step }) => {
    const lookbackHours = event.data.lookbackHours ?? appConfig.reconciliationLookbackHours;
    logger.info('On-demand reconciliation requested', {
      lookbackHours,
      requestedBy: event.data.requestedBy ?? 'unknown',
    });
    return step.run('run-reconciliation', () => runReconciliationWindow(lookbackHours));
  },
);

// ---------------------------------------------------------------------------
// Serve handler
// ---------------------------------------------------------------------------

export const inngestFunctions = [
  paymentPaidFulfillment,
  fulfillmentRetry,
  inventoryReaper,
  reconciliationDaily,
  reconciliationRequested,
] as const;

/**
 * The Next.js handler. Consumed by src/app/api/inngest/route.ts as:
 *
 *   export { GET, POST, PUT } from '@/inngest/functions';
 *
 * When Inngest is NOT configured the endpoint still answers — the dev server
 * and /api/health use it for introspection — but it cannot accept work, and
 * src/fulfillment/enqueue.ts refuses to pretend otherwise.
 */
export const { GET, POST, PUT } = serveInngest({
  client: inngest,
  functions: inngestFunctions,
});

/** Re-exported so the route can build its own handler if it needs custom options. */
export const serve = serveInngest;

/** Surfaced for /api/health: the queue's own view of itself. */
export const queueStatus = {
  status: inngestConfig.status,
  functions: inngestFunctions.map((fn) => fn.id),
} as const;