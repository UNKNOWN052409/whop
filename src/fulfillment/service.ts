/**
 * Fulfillment pipeline (spec §11) and crash recovery (spec §21).
 *
 * THE INVARIANT THIS FILE EXISTS TO KEEP: for any one order, however many
 * times it runs, it allocates EXACTLY ONE code set and sends EXACTLY ONE email.
 *
 * A paid customer who gets no code is a refund, a bad review and eventually a
 * chargeback, so correctness here is revenue, not tidiness. Four mechanisms
 * carry that guarantee, and each one is needed:
 *
 *  1. A unique FulfillmentJob per order (`@@unique([orderId])`) as the ledger.
 *  2. A compare-and-set CLAIM on that job. Only one worker can move a job from
 *     PENDING to RUNNING, so two workers cannot both allocate.
 *  3. The claim is a LEASE, not a lock. A worker that crashes holding the lease
 *     leaves the job RUNNING forever; `recoverStalledJobs()` reclaims jobs whose
 *     lease has aged past the threshold, and the reclaim is itself atomic.
 *  4. Every individual step is written to be replay-safe: allocation is keyed
 *     by orderId, the Delivery row is unique per order, and the email send
 *     carries a stable idempotency key. So even when a crash lands between two
 *     steps, re-running converges instead of duplicating.
 *
 * Money is never computed here — prices are snapshotted on the Order at
 * creation. Amounts are integer minor units end to end.
 *
 * Secrets: no plaintext redeem code is read, decrypted or logged in this file.
 * The delivery service owns decryption; this layer only moves identifiers.
 */

import {
  EmailStatus,
  FulfillmentStatus,
  InventoryStatus,
  OrderStatus,
  PaymentStatus,
  type FulfillmentJob,
  type Order,
} from '@prisma/client';
import { prisma } from '@/db/prisma';
import { queueDelivery } from '@/email/delivery-service';
import { backoffDelayMs } from '@/email/types';
import { reserveCodes } from '@/inventory';
import { AppError, errors, isAppError, type ErrorCode } from '@/lib/errors';
import { logger, timed } from '@/lib/logger';
import { canTransition, isTerminal, shouldHoldForRisk } from '@/orders/state-machine';
import { transitionOrder } from './order-transitions';
import { notifyFulfillmentFailure } from './admin-alert';

// --- Tunables (non-secret; env overrides are optional) ------------------------

/** Matches FulfillmentJob.maxAttempts in the schema. */
const DEFAULT_MAX_ATTEMPTS = 8;
/** How long a claim is considered alive before recovery may steal it. */
const DEFAULT_STALE_JOB_SECONDS = 300;
/** Code reservation TTL handed to the inventory allocator. */
const DEFAULT_RESERVATION_TTL_SECONDS = 30 * 60;
/** Batch size for one recovery sweep. */
const DEFAULT_RECOVERY_LIMIT = 50;
/** Manual-review holds are re-scanned hourly instead of every sweep. */
const HELD_REVIEW_RECHECK_MS = 60 * 60 * 1000;
/** Retry backoff envelope: 5s → 30m, full jitter. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 30 * 60_000;

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function staleJobSeconds(): number {
  return intFromEnv('FULFILLMENT_STALE_JOB_SECONDS', DEFAULT_STALE_JOB_SECONDS, 30, 3_600);
}

function reservationTtlSeconds(): number {
  return intFromEnv('INVENTORY_RESERVATION_TTL_SECONDS', DEFAULT_RESERVATION_TTL_SECONDS, 60, 86_400);
}

// --- Result types ------------------------------------------------------------

export type FulfillmentSource = 'webhook' | 'retry' | 'recovery' | 'manual' | 'cron';

export type FulfillOutcome =
  /** Fulfillment ran to completion on this call. */
  | 'COMPLETED'
  /** Already terminal — nothing was done, and that is the success case. */
  | 'ALREADY_FULFILLED'
  /** Spec §17: order is parked in MANUAL_REVIEW. No inventory moves. */
  | 'HELD_FOR_REVIEW'
  /** Order is not in a payable-verified state. Nothing to do, not an error. */
  | 'NOT_READY'
  /** Another worker holds a live lease on this job. */
  | 'ALREADY_CLAIMED'
  /** Failed transiently; a retry is scheduled on the job row. */
  | 'RETRY_SCHEDULED'
  /** Unrecoverable, or the retry budget is spent. FULFILLMENT_FAILED. */
  | 'FAILED';

export interface FulfillOrderResult {
  orderId: string;
  jobId?: string;
  orderReference: string;
  outcome: FulfillOutcome;
  status: OrderStatus;
  attempts: number;
  maxAttempts: number;
  /** ISO timestamp, set when outcome is RETRY_SCHEDULED. */
  retryAt?: string;
  /** True when another attempt is worthwhile. */
  retryable?: boolean;
  /** True once the retry budget is spent and the job is DEAD_LETTER. */
  deadLettered?: boolean;
  error?: string;
}

export interface FulfillOrderOptions {
  /** Re-enter the pipeline from FULFILLMENT_FAILED (legal per the table). */
  retry?: boolean;
  /** Where the call came from — used in logs and the audit trail. */
  source?: FulfillmentSource;
  /**
   * Escalate to a DEAD_LETTER + admin alert when the retry budget is spent.
   * The retry workflow owns this; a single attempt does not page anyone.
   */
  deadLetter?: boolean;
  /** Ignore a live lease (recovery only). Still safe: every step is replayed. */
  force?: boolean;
}

export interface RecoverStalledJobsOptions {
  /** Lease age before a job may be reclaimed. Default 5 minutes. */
  staleAfterSeconds?: number;
  /** Maximum jobs processed in one sweep. */
  limit?: number;
}

export interface RecoverStalledJobsResult {
  scanned: number;
  recovered: number;
  completed: number;
  retried: number;
  failed: number;
  deadLettered: number;
  heldForReview: number;
  skipped: number;
  thresholdSeconds: number;
}

// --- Internal helpers --------------------------------------------------------

const TERMINAL_JOB_STATUSES: readonly FulfillmentStatus[] = [
  FulfillmentStatus.SUCCEEDED,
  FulfillmentStatus.FAILED,
  FulfillmentStatus.DEAD_LETTER,
];

/**
 * Inventory states that mean "this order holds the code". Anything else
 * (AVAILABLE, REVOKED) means the reservation was released and must be
 * re-acquired before delivery.
 */
const HELD_CODE_STATUSES: readonly InventoryStatus[] = [
  InventoryStatus.RESERVED,
  InventoryStatus.ASSIGNED,
  InventoryStatus.DELIVERED,
];

const DELIVERY_REJECTED_STATUSES: readonly EmailStatus[] = [
  EmailStatus.FAILED,
  EmailStatus.SUPPRESSED,
];

/** Order states from which the pipeline may (re)run. */
function isFulfillable(status: OrderStatus): boolean {
  return (
    status === OrderStatus.PAYMENT_VERIFIED ||
    status === OrderStatus.FULFILLMENT_PENDING ||
    status === OrderStatus.CODE_RESERVED ||
    status === OrderStatus.CODE_DELIVERED
  );
}

/**
 * Failures a later attempt can plausibly fix. Everything else (bad config,
 * illegal transition, tampered signature) needs a human, so it dead-letters
 * immediately instead of burning the retry budget.
 */
const NON_RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'EMAIL_NOT_CONFIGURED',
  'INVALID_STATE_TRANSITION',
  'INVALID_INPUT',
  'VALIDATION_FAILED',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'INVALID_SIGNATURE',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
]);

export function isRetryableFulfillmentError(error: unknown): boolean {
  if (isAppError(error)) return !NON_RETRYABLE_CODES.has(error.code);
  // Unknown faults are treated as transient: re-running is cheap and
  // idempotent, whereas dropping a paid order's code is not recoverable.
  return true;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function truncate(value: string, max = 500): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

type OrderForFulfillment = Order & {
  product: { id: string; productName: string; currency: string };
};

async function loadOrder(orderId: string): Promise<OrderForFulfillment> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { product: { select: { id: true, productName: true, currency: true } } },
  });
  if (!order) throw errors.notFound('Order');
  return order;
}

async function readOrderStatus(orderId: string): Promise<OrderStatus> {
  const row = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!row) throw errors.notFound('Order');
  return row.status;
}

/** Upsert the per-order ledger row. A terminal job is never reset here. */
async function loadOrCreateJob(orderId: string): Promise<FulfillmentJob> {
  return prisma.fulfillmentJob.upsert({
    where: { orderId },
    create: {
      orderId,
      status: FulfillmentStatus.PENDING,
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      nextAttemptAt: new Date(),
    },
    update: {},
  });
}

export async function getFulfillmentJob(orderId: string): Promise<FulfillmentJob | null> {
  return prisma.fulfillmentJob.findUnique({ where: { orderId } });
}

interface ClaimResult {
  claimed: boolean;
  attempts: number;
  maxAttempts: number;
}

/**
 * Compare-and-set claim.
 *
 * A PENDING job past its nextAttemptAt can be claimed outright. A RUNNING job
 * can only be claimed once its lease has aged out (`updatedAt < cutoff`), which
 * is what makes this a lease rather than a lock: a slow-but-alive worker keeps
 * its claim, a crashed one loses it to recovery.
 *
 * Terminal jobs are never claimable — that is the exactly-once guarantee at the
 * ledger level, independent of anything Inngest does.
 */
async function claimJob(job: FulfillmentJob, options: FulfillOrderOptions): Promise<ClaimResult> {
  const now = new Date();
  const leaseCutoff = new Date(now.getTime() - staleJobSeconds() * 1_000);

  const claimed = await prisma.fulfillmentJob.updateMany({
    where: {
      id: job.id,
      OR: [
        { status: FulfillmentStatus.PENDING, nextAttemptAt: { lte: now } },
        { status: FulfillmentStatus.RUNNING, updatedAt: { lte: leaseCutoff } },
      ],
    },
    data: {
      status: FulfillmentStatus.RUNNING,
      attempts: { increment: 1 },
      startedAt: job.startedAt ?? now,
      lastError: null,
    },
  });

  if (claimed.count === 0) return { claimed: false, attempts: job.attempts, maxAttempts: job.maxAttempts };

  const fresh = await prisma.fulfillmentJob.findUnique({ where: { id: job.id } });
  const attempts = fresh?.attempts ?? job.attempts + 1;
  const maxAttempts = fresh?.maxAttempts ?? job.maxAttempts;

  logger.info('Fulfillment job claimed', {
    orderId: job.orderId,
    jobId: job.id,
    attempts,
    maxAttempts,
    forced: options.force === true,
    source: options.source ?? 'manual',
  });

  return { claimed: true, attempts, maxAttempts };
}

/**
 * Ensure this order holds `quantity` codes, reserving more only if needed.
 *
 * `InventoryCode.orderId` is unique, so the allocator is naturally idempotent
 * per order; this wrapper makes the intent explicit and verifies the outcome
 * against the database rather than trusting the allocator's return value.
 */
async function ensureCodesReserved(
  order: OrderForFulfillment,
  jobId: string,
): Promise<{ codeIds: string[] }> {
  const existing = await prisma.inventoryCode.findMany({
    where: { orderId: order.id },
    select: { id: true, status: true },
  });
  const held = existing.filter((code) => HELD_CODE_STATUSES.includes(code.status));
  if (held.length >= order.quantity) {
    return { codeIds: held.map((code) => code.id) };
  }

  logger.info('Reserving redeem codes for order', {
    orderId: order.id,
    jobId,
    productId: order.productId,
    quantity: order.quantity,
    alreadyHeld: held.length,
  });

  await reserveCodes({
    productId: order.productId,
    quantity: order.quantity,
    orderId: order.id,
    ttlSeconds: reservationTtlSeconds(),
  });

  const after = await prisma.inventoryCode.findMany({
    where: { orderId: order.id },
    select: { id: true, status: true },
  });
  const stillHeld = after.filter((code) => HELD_CODE_STATUSES.includes(code.status));

  if (stillHeld.length < order.quantity) {
    throw errors.insufficientInventory(order.productId);
  }

  return { codeIds: stillHeld.map((code) => code.id) };
}

/** First payment that actually settled, for Delivery.paymentId and refunds. */
async function findPaidPaymentId(orderId: string): Promise<string | undefined> {
  const payment = await prisma.payment.findFirst({
    where: { orderId, status: { in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return payment?.id;
}

/**
 * Hand the code to the delivery service — exactly once.
 *
 * `Delivery` is unique per order, so the second call is a no-op at the storage
 * layer. We then read the row back instead of trusting the return value: the
 * database is the source of truth for whether the customer has an email.
 *
 * SENT/DELIVERED and QUEUED both mean "the delivery service owns it now"; the
 * rest of the SENT → DELIVERED/FAILED lifecycle is tracked there. FAILED and
 * SUPPRESSED are surfaced as a retryable error so the retry workflow can try
 * again — a code that never reaches the customer is not a fulfilled order.
 */
async function deliverCode(order: OrderForFulfillment, job: FulfillmentJob): Promise<void> {
  const paymentId = await findPaidPaymentId(order.id);

  await queueDelivery({
    orderId: order.id,
    fulfillmentJobId: job.id,
    paymentId: paymentId ?? null,
    // The recipient is read from the order snapshot inside queueDelivery, never
    // passed in by the caller, so no code path can redirect a code to another
    // address.
  });

  const delivery = await prisma.delivery.findUnique({
    where: { orderId: order.id },
    select: { id: true, status: true, lastError: true, providerMessageId: true, sentAt: true },
  });

  if (!delivery) {
    throw new AppError('Delivery was not persisted by the delivery service', 502, 'EMAIL_SEND_FAILED', {
      details: { orderId: order.id },
      retryAfterSeconds: 30,
    });
  }

  if (DELIVERY_REJECTED_STATUSES.includes(delivery.status)) {
    throw new AppError(
      `Delivery is ${delivery.status}: ${delivery.lastError ?? 'no detail provided'}`,
      502,
      'EMAIL_SEND_FAILED',
      { details: { orderId: order.id, deliveryStatus: delivery.status }, retryAfterSeconds: 60 },
    );
  }

  logger.info('Code handed to delivery service', {
    orderId: order.id,
    jobId: job.id,
    deliveryId: delivery.id,
    deliveryStatus: delivery.status,
    hasProviderMessageId: Boolean(delivery.providerMessageId),
  });
}

async function settleJobSucceeded(jobId: string, now = new Date()): Promise<void> {
  await prisma.fulfillmentJob.updateMany({
    where: { id: jobId, status: { not: FulfillmentStatus.DEAD_LETTER } },
    data: {
      status: FulfillmentStatus.SUCCEEDED,
      completedAt: now,
      nextAttemptAt: now,
      lastError: null,
    },
  });
}

interface FailureContext {
  order: OrderForFulfillment;
  jobId: string;
  attempts: number;
  maxAttempts: number;
  error: unknown;
  options: FulfillOrderOptions;
}

/**
 * Bookkeeping for a failed attempt: schedule a retry, or give up loudly.
 *
 * A failure is never swallowed silently — the job row records the error, and a
 * dead letter notifies a human. Crucially, this does NOT release inventory:
 * an order that failed mid-pipeline may still be retried, and releasing the
 * code would sell the same code twice (spec §17).
 */
async function handleFailure(ctx: FailureContext): Promise<FulfillOrderResult> {
  const { order, jobId, attempts, maxAttempts, error, options } = ctx;
  const message = errorMessage(error);
  const retryable = isRetryableFulfillmentError(error);
  const exhausted = attempts >= maxAttempts;
  const status = await readOrderStatus(order.id).catch(() => order.status);

  // Never touch an order a human is looking at (spec §17).
  if (shouldHoldForRisk(status)) {
    logger.warn('Fulfillment failure ignored while order is in MANUAL_REVIEW', {
      orderId: order.id,
      jobId,
      error: truncate(message),
    });
    return {
      orderId: order.id,
      jobId,
      orderReference: order.reference,
      outcome: 'HELD_FOR_REVIEW',
      status,
      attempts,
      maxAttempts,
      error: truncate(message),
    };
  }

  if (retryable && !exhausted) {
    const retryAt = new Date(Date.now() + backoffDelayMs(attempts, RETRY_BASE_MS, RETRY_MAX_MS));
    await prisma.fulfillmentJob.updateMany({
      where: { id: jobId, status: { notIn: [...TERMINAL_JOB_STATUSES] } },
      data: {
        status: FulfillmentStatus.PENDING,
        nextAttemptAt: retryAt,
        lastError: truncate(message),
      },
    });

    logger.warn('Fulfillment attempt failed; retry scheduled', {
      orderId: order.id,
      jobId,
      attempts,
      maxAttempts,
      retryAt: retryAt.toISOString(),
      error: truncate(message),
    });

    return {
      orderId: order.id,
      jobId,
      orderReference: order.reference,
      outcome: 'RETRY_SCHEDULED',
      status,
      attempts,
      maxAttempts,
      retryAt: retryAt.toISOString(),
      retryable: true,
      error: truncate(message),
    };
  }

  const deadLettered = retryable && exhausted && options.deadLetter === true;

  await prisma.fulfillmentJob.updateMany({
    where: { id: jobId, status: { notIn: [...TERMINAL_JOB_STATUSES] } },
    data: {
      status: deadLettered ? FulfillmentStatus.DEAD_LETTER : FulfillmentStatus.FAILED,
      nextAttemptAt: new Date(),
      lastError: truncate(message),
    },
  });

  // Only legal from states where fulfillment genuinely failed; the compare-and-set
  // leaves orders in REVIEW/CANCELLED/REFUNDED untouched.
  await transitionOrder(
    order.id,
    OrderStatus.FULFILLMENT_FAILED,
    {
      expectedFrom: [
        OrderStatus.PAYMENT_VERIFIED,
        OrderStatus.FULFILLMENT_PENDING,
        OrderStatus.CODE_RESERVED,
        OrderStatus.CODE_DELIVERED,
      ],
      reason: deadLettered
        ? `fulfillment dead-lettered after ${attempts} attempts: ${truncate(message, 200)}`
        : `fulfillment failed (${retryable ? 'retry budget exhausted' : 'permanent error'}): ${truncate(message, 200)}`,
      actor: `fulfillment:${options.source ?? 'manual'}`,
      metadata: {
        jobId,
        attempts,
        maxAttempts,
        retryable,
        deadLettered,
        // No codes, no card data, no secrets — an error message and counters.
        error: truncate(message, 500),
      },
    },
  ).catch((transitionError) => {
    logger.error('Could not move order to FULFILLMENT_FAILED', {
      orderId: order.id,
      jobId,
      error: errorMessage(transitionError),
    });
  });

  const alert = await notifyFulfillmentFailure({
    severity: 'CRITICAL',
    title: deadLettered ? 'Paid order abandoned by the fulfillment worker' : 'Fulfillment failed for a paid order',
    reason: isAppError(error) ? error.code : 'UNEXPECTED_ERROR',
    detail: truncate(message, 800),
    orderId: order.id,
    orderReference: order.reference,
    productName: order.productName,
    // Integer minor units. The customer paid a premium over face value, and
    // the alert renders "Price X / Value Y" — never the other way round.
    amountMinor: order.totalMinor,
    faceValueMinor: order.faceValueMinor,
    currency: order.currency,
    customerEmail: order.customerEmail,
    jobId,
    attempts,
    maxAttempts,
    jobStatus: deadLettered ? FulfillmentStatus.DEAD_LETTER : FulfillmentStatus.FAILED,
  });

  logger.error('Fulfillment failed terminally', {
    orderId: order.id,
    jobId,
    attempts,
    maxAttempts,
    deadLettered,
    retryable,
    alertStatus: alert.status,
    alertChannel: alert.channel,
    error: truncate(message),
  });

  return {
    orderId: order.id,
    jobId,
    orderReference: order.reference,
    outcome: 'FAILED',
    status,
    attempts,
    maxAttempts,
    retryable: false,
    deadLettered,
    error: truncate(message),
  };
}

// --- Public API --------------------------------------------------------------

/**
 * Run the pipeline for one order. Safe to call any number of times, from any
 * number of concurrent workers, for the same order.
 *
 * Resolution (rather than throwing) is deliberate for expected failures: the
 * caller decides whether to sleep and retry, dead-letter, or stop. Genuine
 * programming errors (order not found) still throw.
 */
export async function fulfillOrder(
  orderId: string,
  options: FulfillOrderOptions = {},
): Promise<FulfillOrderResult> {
  return timed('fulfillOrder', () => runFulfillment(orderId, options), {
    orderId,
    source: options.source ?? 'manual',
  });
}

async function runFulfillment(
  orderId: string,
  options: FulfillOrderOptions,
): Promise<FulfillOrderResult> {
  const order = await loadOrder(orderId);

  // --- HARD GATE: no inventory without a verified payment --------------------
  // Spec §8: "Only a VERIFIED payment can trigger digital-code delivery."
  //
  // This is the last line of defence for that rule. Every legitimate caller
  // already verified (the webhook enqueues, and the payment/paid workflow runs
  // confirmPaymentBeforeFulfillment as step 0), so reaching here with an
  // unverified order means a bug or a direct call. It MUST fail loudly rather
  // than fall through: below, an order that is not PAYMENT_VERIFIED matches no
  // progress branch, and silently returning would leave a PAID order stuck
  // with nobody alerted.
  const VERIFIED_OR_BEYOND: ReadonlySet<OrderStatus> = new Set([
    OrderStatus.PAYMENT_VERIFIED,
    OrderStatus.FULFILLMENT_PENDING,
    OrderStatus.CODE_RESERVED,
    OrderStatus.CODE_DELIVERED,
    OrderStatus.COMPLETED,
  ]);

  if (!VERIFIED_OR_BEYOND.has(order.status)) {
    logger.error('REFUSING to fulfill an order whose payment is not verified', {
      orderId,
      orderReference: order.reference,
      status: order.status,
      source: options.source ?? 'manual',
    });
    throw errors.criticalFulfillment(
      'Refusing to release inventory for an order whose payment is not verified',
      { orderId, orderReference: order.reference, status: order.status },
    );
  }

  // Spec §17: a high-risk order parks in MANUAL_REVIEW. It must neither gain
  // inventory nor lose it — an operator decides. This check comes before the
  // ledger entirely so a held order cannot even be claimed.
  if (shouldHoldForRisk(order.status)) {
    logger.warn('Fulfillment skipped: order is in MANUAL_REVIEW', {
      orderId: order.id,
      orderReference: order.reference,
      status: order.status,
      source: options.source ?? 'manual',
    });
    const heldJob = await getFulfillmentJob(order.id);
    return {
      orderId: order.id,
      ...(heldJob ? { jobId: heldJob.id } : {}),
      orderReference: order.reference,
      outcome: 'HELD_FOR_REVIEW',
      status: order.status,
      attempts: heldJob?.attempts ?? 0,
      maxAttempts: heldJob?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    };
  }

  let status = order.status;

  // An order that already finished must never be touched again — this is the
  // exactly-once guarantee for a redelivered webhook arriving an hour later.
  if (isTerminal(status) || status === OrderStatus.CODE_DELIVERED || status === OrderStatus.COMPLETED) {
    const existingJob = await getFulfillmentJob(order.id);
    if (existingJob && existingJob.status !== FulfillmentStatus.SUCCEEDED) {
      await settleJobSucceeded(existingJob.id);
    }
    logger.info('Fulfillment skipped: order already delivered', {
      orderId: order.id,
      orderReference: order.reference,
      status,
    });
    return {
      orderId: order.id,
      ...(existingJob ? { jobId: existingJob.id } : {}),
      orderReference: order.reference,
      outcome: 'ALREADY_FULFILLED',
      status,
      attempts: existingJob?.attempts ?? 0,
      maxAttempts: existingJob?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    };
  }

  const job = await loadOrCreateJob(orderId);

  if (job.status === FulfillmentStatus.SUCCEEDED) {
    return {
      orderId: order.id,
      jobId: job.id,
      orderReference: order.reference,
      outcome: 'ALREADY_FULFILLED',
      status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    };
  }

  if (job.status === FulfillmentStatus.DEAD_LETTER && options.retry !== true) {
    logger.warn('Fulfillment skipped: job is DEAD_LETTER and no explicit retry was requested', {
      orderId: order.id,
      jobId: job.id,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    });
    return {
      orderId: order.id,
      jobId: job.id,
      orderReference: order.reference,
      outcome: 'ALREADY_FULFILLED',
      status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      error: 'Job is DEAD_LETTER; an operator or an explicit retry must requeue it.',
    };
  }

  // Re-entering from FULFILLMENT_FAILED is legal and is how a retry resumes.
  if (status === OrderStatus.FULFILLMENT_FAILED) {
    if (options.retry !== true) {
      logger.warn('Fulfillment skipped: order is FULFILLMENT_FAILED without an explicit retry', {
        orderId: order.id,
        jobId: job.id,
      });
      return {
        orderId: order.id,
        jobId: job.id,
        orderReference: order.reference,
        outcome: 'NOT_READY',
        status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
      };
    }
    const resumed = await transitionOrder(order.id, OrderStatus.FULFILLMENT_PENDING, {
      expectedFrom: OrderStatus.FULFILLMENT_FAILED,
      reason: 'fulfillment retry requested',
      actor: `fulfillment:${options.source ?? 'manual'}`,
    });
    status = resumed.applied ? OrderStatus.FULFILLMENT_PENDING : await readOrderStatus(order.id);
  }

  if (!isFulfillable(status)) {
    logger.warn('Fulfillment skipped: order is not in a fulfillable state', {
      orderId: order.id,
      orderReference: order.reference,
      status,
      source: options.source ?? 'manual',
    });
    return {
      orderId: order.id,
      jobId: job.id,
      orderReference: order.reference,
      outcome: 'NOT_READY',
      status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    };
  }

  const claim = await claimJob(job, options);
  if (!claim.claimed) {
    logger.info('Fulfillment skipped: job is already claimed by a live worker', {
      orderId: order.id,
      jobId: job.id,
      attempts: claim.attempts,
      maxAttempts: claim.maxAttempts,
    });
    return {
      orderId: order.id,
      jobId: job.id,
      orderReference: order.reference,
      outcome: 'ALREADY_CLAIMED',
      status,
      attempts: claim.attempts,
      maxAttempts: claim.maxAttempts,
      retryable: true,
    };
  }

  try {
    // --- PAYMENT_VERIFIED -> FULFILLMENT_PENDING -----------------------------
    if (status === OrderStatus.PAYMENT_VERIFIED) {
      const started = await transitionOrder(order.id, OrderStatus.FULFILLMENT_PENDING, {
        expectedFrom: OrderStatus.PAYMENT_VERIFIED,
        reason: 'fulfillment started for a verified payment',
        actor: `fulfillment:${options.source ?? 'manual'}`,
        metadata: { jobId: job.id },
      });
      status = started.applied ? OrderStatus.FULFILLMENT_PENDING : await readOrderStatus(order.id);
    }

    // --- allocation (exactly once) ------------------------------------------
    const { codeIds } = await ensureCodesReserved(order, job.id);

    // Ledger flag: set once, never cleared. Recovery sees it and knows the
    // reservation already happened.
    await prisma.fulfillmentJob.updateMany({
      where: { id: job.id, inventoryAllocatedAt: null },
      data: { inventoryAllocatedAt: new Date() },
    });

    // --- FULFILLMENT_PENDING -> CODE_RESERVED -------------------------------
    if (canTransition(status, OrderStatus.CODE_RESERVED)) {
      const reserved = await transitionOrder(order.id, OrderStatus.CODE_RESERVED, {
        expectedFrom: status,
        reason: `reserved ${codeIds.length} redeem code(s)`,
        actor: `fulfillment:${options.source ?? 'manual'}`,
        metadata: { jobId: job.id, codeCount: codeIds.length },
      });
      status = reserved.applied ? OrderStatus.CODE_RESERVED : await readOrderStatus(order.id);
    }

    if (status !== OrderStatus.CODE_RESERVED && status !== OrderStatus.CODE_DELIVERED) {
      throw errors.criticalFulfillment(
        `Order left the fulfillment path at ${status}; refusing to deliver`,
        { orderId: order.id, jobId: job.id, status },
      );
    }

    // --- delivery (exactly one email) ---------------------------------------
    await deliverCode(order, job);

    // --- CODE_RESERVED -> CODE_DELIVERED ------------------------------------
    if (canTransition(status, OrderStatus.CODE_DELIVERED)) {
      const delivered = await transitionOrder(order.id, OrderStatus.CODE_DELIVERED, {
        expectedFrom: status,
        reason: 'redeem code handed to the delivery service',
        actor: `fulfillment:${options.source ?? 'manual'}`,
        metadata: { jobId: job.id, deliveryJobId: job.id },
      });
      status = delivered.applied ? OrderStatus.CODE_DELIVERED : await readOrderStatus(order.id);
    }

    // --- CODE_DELIVERED -> COMPLETED ----------------------------------------
    if (canTransition(status, OrderStatus.COMPLETED)) {
      await transitionOrder(order.id, OrderStatus.COMPLETED, {
        expectedFrom: OrderStatus.CODE_DELIVERED,
        reason: 'fulfillment complete',
        actor: `fulfillment:${options.source ?? 'manual'}`,
        data: { completedAt: new Date() },
        metadata: { jobId: job.id },
      });
    }

    await settleJobSucceeded(job.id);

    logger.info('Fulfillment complete', {
      orderId: order.id,
      jobId: job.id,
      attempts: claim.attempts,
      codes: codeIds.length,
      source: options.source ?? 'manual',
    });

    return {
      orderId: order.id,
      jobId: job.id,
      orderReference: order.reference,
      outcome: 'COMPLETED',
      status: OrderStatus.COMPLETED,
      attempts: claim.attempts,
      maxAttempts: claim.maxAttempts,
    };
  } catch (error) {
    return handleFailure({
      order,
      jobId: job.id,
      attempts: claim.attempts,
      maxAttempts: claim.maxAttempts,
      error,
      options,
    });
  }
}

/**
 * Crash recovery (spec §21): a paid order must never be lost because a worker
 * died between reserving a code and sending the email.
 *
 * Finds non-terminal jobs whose lease has aged past the threshold, resets them
 * to PENDING and re-runs them. Safe to run on every instance at once: the reset
 * is a compare-and-set and the re-run re-claims the job atomically.
 *
 * Jobs that have already spent their retry budget are dead-lettered here rather
 * than looped forever — that is the difference between an alert and a support
 * ticket that never closes.
 */
export async function recoverStalledJobs(
  options: RecoverStalledJobsOptions = {},
): Promise<RecoverStalledJobsResult> {
  const thresholdSeconds = options.staleAfterSeconds ?? staleJobSeconds();
  const limit = options.limit ?? DEFAULT_RECOVERY_LIMIT;
  const now = new Date();
  const cutoff = new Date(now.getTime() - thresholdSeconds * 1_000);

  const stalled = await prisma.fulfillmentJob.findMany({
    where: {
      status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.RUNNING] },
      updatedAt: { lt: cutoff },
      nextAttemptAt: { lte: now },
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    select: { id: true, orderId: true, status: true, attempts: true, maxAttempts: true, lastError: true },
  });

  const summary: RecoverStalledJobsResult = {
    scanned: stalled.length,
    recovered: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    deadLettered: 0,
    heldForReview: 0,
    skipped: 0,
    thresholdSeconds,
  };

  for (const job of stalled) {
    if (job.attempts >= job.maxAttempts) {
      const deadLettered = await prisma.fulfillmentJob.updateMany({
        where: { id: job.id, status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.RUNNING] } },
        data: {
          status: FulfillmentStatus.DEAD_LETTER,
          nextAttemptAt: now,
          lastError: `Recovery gave up: ${job.attempts} of ${job.maxAttempts} attempts already used`,
        },
      });
      if (deadLettered.count === 0) {
        summary.skipped += 1;
        continue;
      }

      const order = await loadOrder(job.orderId).catch(() => null);
      if (order) {
        await transitionOrder(
          order.id,
          OrderStatus.FULFILLMENT_FAILED,
          {
            expectedFrom: [
              OrderStatus.PAYMENT_VERIFIED,
              OrderStatus.FULFILLMENT_PENDING,
              OrderStatus.CODE_RESERVED,
              OrderStatus.CODE_DELIVERED,
            ],
            reason: 'fulfillment retry budget exhausted during crash recovery',
            actor: 'fulfillment:recovery',
          },
        ).catch(() => undefined);

        await notifyFulfillmentFailure({
          severity: 'CRITICAL',
          title: 'Paid order abandoned: fulfillment retry budget exhausted',
          reason: 'RETRY_BUDGET_EXHAUSTED',
          detail: truncate(job.lastError ?? 'no error recorded', 800),
          orderId: order.id,
          orderReference: order.reference,
          productName: order.productName,
          amountMinor: order.totalMinor,
          faceValueMinor: order.faceValueMinor,
          currency: order.currency,
          customerEmail: order.customerEmail,
          jobId: job.id,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          jobStatus: FulfillmentStatus.DEAD_LETTER,
        });
      }

      summary.deadLettered += 1;
      continue;
    }

    // Reset to PENDING so the atomic claim in runFulfillment() can take it.
    // Without this, a job stuck in RUNNING by a crashed worker would keep a
    // lease forever and only a manual DB edit would revive it.
    const reset = await prisma.fulfillmentJob.updateMany({
      where: { id: job.id, status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.RUNNING] } },
      data: {
        status: FulfillmentStatus.PENDING,
        nextAttemptAt: now,
        lastError: `Recovered stale ${job.status} job older than ${thresholdSeconds}s`,
      },
    });
    if (reset.count === 0) {
      summary.skipped += 1;
      continue;
    }

    summary.recovered += 1;

    const result = await fulfillOrder(job.orderId, { source: 'recovery', retry: true }).catch(
      (error) => {
        logger.error('Recovery re-run threw', {
          orderId: job.orderId,
          jobId: job.id,
          error: errorMessage(error),
        });
        return null;
      },
    );

    if (result === null) {
      summary.failed += 1;
      continue;
    }

    switch (result.outcome) {
      case 'COMPLETED':
      case 'ALREADY_FULFILLED':
        summary.completed += 1;
        break;
      case 'RETRY_SCHEDULED':
      case 'ALREADY_CLAIMED':
        summary.retried += 1;
        break;
      case 'HELD_FOR_REVIEW':
        summary.heldForReview += 1;
        // Back the job off so a held order is not re-scanned every sweep.
        await prisma.fulfillmentJob.updateMany({
          where: { id: job.id, status: { notIn: [...TERMINAL_JOB_STATUSES] } },
          data: { nextAttemptAt: new Date(Date.now() + HELD_REVIEW_RECHECK_MS) },
        });
        break;
      case 'FAILED':
        summary.failed += 1;
        break;
      default:
        summary.skipped += 1;
        break;
    }
  }

  if (summary.recovered > 0 || summary.deadLettered > 0) {
    logger.warn('Fulfillment recovery sweep finished with work done', {
      ...summary,
    });
  }

  return summary;
}

/**
 * Scheduled retry entry point. Re-runs one order with the dead-letter flag set,
 * so exhausting the budget pages a human instead of looping. Used by the
 * `fulfillment/retry` Inngest function and by admin requeue actions.
 */
export async function retryFulfillment(
  orderId: string,
  options: FulfillOrderOptions = {},
): Promise<FulfillOrderResult> {
  return fulfillOrder(orderId, {
    ...options,
    source: options.source ?? 'retry',
    retry: true,
    deadLetter: true,
  });
}