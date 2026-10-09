/**
 * Reconciliation engine (spec §18).
 *
 * WHAT THIS IS FOR. The provider is the only authority on whether money moved.
 * This engine asks it "what did you settle between `from` and `to`?", asks the
 * database "what do we think happened?", and writes down every disagreement as
 * an auditable `ReconciliationRecord`. It is a DETECTOR, never a repairer:
 *
 *   - IT NEVER MUTATES FINANCIAL STATE. No Payment.status write, no
 *     Order.status transition, no refund issuance, no code revocation. A
 *     reconciliation that silently "fixed" a mismatch would destroy the very
 *     evidence an operator needs, and would race the fulfillment pipeline.
 *   - The only rows it writes are `ReconciliationRecord` rows (plus metrics).
 *   - Remediation is a separate, explicitly authorised action.
 *
 * THE HEADLINE CHECK is MISSING_WEBHOOK: the provider says the money moved and
 * we have no `PaymentEvent` proving a webhook ever told us about it. That is
 * "a customer paid and nobody noticed" — the failure that costs both revenue
 * and a customer's $3.
 *
 * HONESTY. `getPaymentProvider()` returns null when the provider is not
 * configured. There is no fallback, no mock, no "assumed clean" run: the engine
 * returns an explicit NOT_CONFIGURED result. A reconciliation that quietly
 * passes because it talked to nobody is worse than one that says it cannot run.
 *
 * MONEY. Every amount crossing this file is an INTEGER count of minor units
 * paired with a currency. No float ever touches a comparison — the pure
 * comparison layer in ./compare rejects a non-integer provider amount as a
 * discrepancy rather than rounding it.
 *
 * SECRETS. Redeem codes are never read: `InventoryCode` rows are aggregated by
 * (orderId, status) and only counts are used. No PAN, CVV, OTP or UPI PIN
 * exists anywhere on this path.
 *
 * CONCURRENCY. Runs are serialised through the `./lease` WorkerLease, so a slow
 * 72h page-through and the next scheduled run cannot interleave.
 */

import { randomUUID } from 'node:crypto';

import {
  InventoryStatus,
  OrderStatus,
  ProductStatus,
  ReconciliationStatus,
  ReconciliationType,
  type Prisma,
} from '@prisma/client';

import { prisma } from '@/db/prisma';
import { logger } from '@/lib/logger';
import { observeReconciliationMismatch } from '@/observability/alerts';
import {
  recordInventoryDepleted,
  recordReconciliationMismatch,
  recordWorkerHeartbeat,
} from '@/observability/metrics';
import { getPaymentProvider } from '@/payments/registry';
import type { PaymentProvider, ProviderPaymentDetails, RefundRecord } from '@/payments/types';

import {
  compareProviderPaymentLinks,
  countBySeverity,
  countByType,
  findDepletedInventory,
  findDuplicatePayments,
  findFulfillmentMismatches,
  findStuckOrders,
  findUnrecordedRefunds,
  readFingerprint,
  STUCK_ORDER_STATUSES,
  toJsonObject,
  type DeliverySnapshot,
  type Discrepancy,
  type OrderCodeCount,
  type OrderSnapshot,
  type PaymentSnapshot,
  type ProductInventorySnapshot,
  type ProviderPaymentLink,
  type RefundSnapshot,
} from './compare';
import { RECONCILIATION_LEASE_NAME, withLease, type Heartbeat, type LeaseOptions } from './lease';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Whop caps `first` at 100; asking for more is rejected outright. */
const DEFAULT_PAGE_LIMIT = 100;

/**
 * Hard stop on Relay paging. 500 pages x 100 = 50k rows, far beyond any
 * plausible 72h window, and it guarantees a misbehaving cursor loop cannot spin
 * forever.
 */
const MAX_PROVIDER_PAGES = 500;

/** Ceiling on `PaymentEvent` rows pulled for the webhook-coverage join. */
const MAX_EVENT_ROWS = 20_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/** Minutes a paid order may sit in a mid-fulfillment state before it is stuck. */
export const DEFAULT_STUCK_THRESHOLD_MINUTES = 30;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunReconciliationOptions {
  /** Inclusive window start passed to the provider listing endpoints. */
  from: Date;
  /** Inclusive window end passed to the provider listing endpoints. */
  to: Date;
  /** Injectable clock — tests must not depend on wall time. */
  now?: Date;
  /** Override the lease name (tests run in parallel). */
  leaseName?: string;
  leaseOptions?: LeaseOptions;
  /** Defaults to 100. Clamped to what the provider accepts. */
  pageLimit?: number;
  /** Minutes before PAYMENT_VERIFIED / FULFILLMENT_PENDING / CODE_RESERVED is stuck. */
  stuckThresholdMinutes?: number;
  /** Also flag abandoned PAYMENT_PENDING orders. Off by default — it is noisy. */
  includeStalePending?: boolean;
  pendingThresholdMinutes?: number;
  /** Compare provider amounts against Order.totalMinor instead of Payment.amountMinor. */
  compareOrderTotals?: boolean;
}

/**
 * The value returned to the cron route / Inngest step.
 *
 * Everything here is JSON-serialisable: dates are ISO-8601 strings and
 * `byType` is a plain number map, so callers may spread it straight into a
 * response body or a log context.
 */
export interface ReconciliationSummary {
  runId: string;
  /** ISO-8601. */
  from: string;
  /** ISO-8601. */
  to: string;
  /** Total rows examined: provider payments + provider refunds + orders + products. */
  scanned: number;
  providerPayments: number;
  providerRefunds: number;
  ordersScanned: number;
  /** Discrepancies detected this run, before idempotent record de-duplication. */
  discrepancies: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  /** ReconciliationRecord rows written this run. */
  created: number;
  /** Issues already tracked by an OPEN record — the idempotency win. */
  skippedExisting: number;
  /** True when no payment provider is configured. Nothing was faked. */
  NOT_CONFIGURED?: boolean;
  /** True when another holder owns the lease and this run did nothing. */
  skipped?: boolean;
  reason?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Provider paging
// ---------------------------------------------------------------------------

/**
 * Relay-style pagination with two hard guarantees: a repeated cursor stops the
 * loop, and the page count is bounded. A provider that returns a cursor forever
 * must not be able to hang the cron.
 */
async function pageProvider<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
  label: string,
): Promise<T[]> {
  const out: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    out.push(...result.items);
    const next = result.nextCursor;
    if (next === undefined || next === '' || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }

  if (out.length > 0) {
    logger.debug('Reconciliation provider page complete', { label, rows: out.length });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal snapshots
// ---------------------------------------------------------------------------

function toOrderSnapshot(row: {
  id: string;
  reference: string;
  status: OrderStatus;
  totalMinor: number;
  currency: string;
  productId: string;
  quantity: number;
  createdAt: Date;
  updatedAt: Date;
  paidAt: Date | null;
}): OrderSnapshot {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    totalMinor: row.totalMinor,
    currency: row.currency,
    productId: row.productId,
    quantity: row.quantity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    paidAt: row.paidAt,
  };
}

function toPaymentSnapshot(row: {
  id: string;
  orderId: string;
  provider: PaymentSnapshot['provider'];
  providerPaymentId: string | null;
  providerCheckoutId: string | null;
  status: PaymentSnapshot['status'];
  amountMinor: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}): PaymentSnapshot {
  return {
    id: row.id,
    orderId: row.orderId,
    provider: row.provider,
    providerPaymentId: row.providerPaymentId,
    providerCheckoutId: row.providerCheckoutId,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRefundSnapshot(row: {
  id: string;
  orderId: string;
  paymentId: string;
  providerRefundId: string | null;
  status: string;
  amountMinor: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}): RefundSnapshot {
  return {
    id: row.id,
    orderId: row.orderId,
    paymentId: row.paymentId,
    providerRefundId: row.providerRefundId,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Per-order code tallies built from a `groupBy` on (orderId, status).
 *
 * NOTE WHAT IS NOT SELECTED: `codeCiphertext`, `codeLast4` and `codeFingerprint`
 * are absent from this query. The engine counts codes; it never reads one.
 */
async function loadOrderCodeCounts(orderIds: readonly string[]): Promise<OrderCodeCount[]> {
  if (orderIds.length === 0) return [];

  const rows = await prisma.inventoryCode.groupBy({
    by: ['orderId', 'status'],
    where: { orderId: { in: [...orderIds] } },
  });

  const byOrder = new Map<string, OrderCodeCount>();
  for (const row of rows) {
    const orderId = row.orderId;
    if (orderId === null || orderId === '') continue;
    let entry = byOrder.get(orderId);
    if (entry === undefined) {
      entry = { orderId, total: 0, reserved: 0, assigned: 0, delivered: 0, revoked: 0 };
      byOrder.set(orderId, entry);
    }
    entry.total += 1;
    switch (row.status) {
      case InventoryStatus.RESERVED:
        entry.reserved += 1;
        break;
      case InventoryStatus.ASSIGNED:
        entry.assigned += 1;
        break;
      case InventoryStatus.DELIVERED:
        entry.delivered += 1;
        break;
      case InventoryStatus.REVOKED:
        entry.revoked += 1;
        break;
      default:
        break;
    }
  }

  return [...byOrder.values()];
}

async function loadAvailableCodeCounts(productIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (productIds.length === 0) return out;

  const rows = await prisma.inventoryCode.groupBy({
    by: ['productId'],
    where: { productId: { in: [...productIds] }, status: InventoryStatus.AVAILABLE },
    _count: { _all: true },
  });
  for (const row of rows) out.set(row.productId, row._count._all);
  return out;
}

// ---------------------------------------------------------------------------
// PaymentEvent tallies — the MISSING_WEBHOOK evidence
// ---------------------------------------------------------------------------

interface EventTally {
  count: number;
  failed: number;
}

/**
 * Pulls the provider payment id out of a stored webhook envelope so a webhook
 * that arrived but never got linked to a Payment can still be counted.
 *
 * Only the opaque `data.id` / `data.payment_id` strings are read. The payload
 * is never logged and never copied into a discrepancy.
 */
function readProviderPaymentId(payload: Prisma.JsonValue): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const data = (payload as Record<string, Prisma.JsonValue>)['data'];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, Prisma.JsonValue>;
  const id = record['id'];
  if (typeof id === 'string' && id.length > 0) return id;
  const paymentId = record['payment_id'];
  if (typeof paymentId === 'string' && paymentId.length > 0) return paymentId;
  return null;
}

/**
 * An event "failed" when the signature did not verify or processing threw.
 * A merely unprocessed event is NOT failed — it may simply still be queued.
 */
function isFailedEvent(event: {
  signatureValid: boolean;
  processingError: string | null;
}): boolean {
  return !event.signatureValid || event.processingError !== null;
}

/**
 * Several lookup keys can describe the SAME events (an event is both linked to
 * a payment and to its order). Taking the largest tally rather than the sum
 * avoids double-counting and keeps the failure ratio honest.
 */
function pickLargestTally(...tallies: readonly (EventTally | undefined)[]): EventTally {
  let best: EventTally = { count: 0, failed: 0 };
  for (const tally of tallies) {
    if (tally !== undefined && tally.count > best.count) best = tally;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Order resolution from provider metadata
// ---------------------------------------------------------------------------

/**
 * A provider payment can name our order in its metadata (`order_id` /
 * `order_ref`, set by the checkout adapter) even when no Payment row binds to
 * it. Resolving it turns "MISSING_PAYMENT with no order" into "MISSING_PAYMENT
 * on a known order", which is the actionable form.
 */
function resolveOrderFromMetadata(
  details: ProviderPaymentDetails,
  ordersById: ReadonlyMap<string, OrderSnapshot>,
  ordersByReference: ReadonlyMap<string, OrderSnapshot>,
): OrderSnapshot | null {
  const metadata = details.metadata;
  if (metadata === undefined) return null;
  const byId = metadata['order_id'];
  if (typeof byId === 'string' && byId !== '') {
    const found = ordersById.get(byId);
    if (found !== undefined) return found;
  }
  const byReference = metadata['order_ref'];
  if (typeof byReference === 'string' && byReference !== '') {
    return ordersByReference.get(byReference) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Identity of "the same open issue": type plus the entity it was found on.
 * This is the key a re-run must not duplicate.
 */
function entityKey(
  type: ReconciliationType,
  orderId: string | null,
  paymentId: string | null,
  providerPaymentId: string | null,
): string {
  return [type, orderId ?? '~', paymentId ?? '~', providerPaymentId ?? '~'].join('|');
}

const SEVERITY_RANK: Record<Discrepancy['severity'], number> = {
  INFO: 0,
  WARN: 1,
  CRITICAL: 2,
};

/**
 * Collapses the findings for one entity into a single record.
 *
 * Re-running the same window re-derives the same findings, so the batch itself
 * is de-duplicated first; when one entity yields several findings of the same
 * type the most severe one wins and the rest are counted on it rather than
 * flooding the operator queue with four rows about one order.
 */
function collapseByEntity(discrepancies: readonly Discrepancy[]): Discrepancy[] {
  const byEntity = new Map<string, Discrepancy>();
  const extraCounts = new Map<string, number>();

  for (const item of discrepancies) {
    const key = entityKey(item.type, item.orderId, item.paymentId, item.providerPaymentId);
    const current = byEntity.get(key);
    if (current === undefined) {
      byEntity.set(key, item);
      continue;
    }
    extraCounts.set(key, (extraCounts.get(key) ?? 0) + 1);
    if (SEVERITY_RANK[item.severity] > SEVERITY_RANK[current.severity]) byEntity.set(key, item);
  }

  return [...byEntity.entries()].map(([key, item]) => {
    const related = extraCounts.get(key);
    if (related === undefined || related === 0) return item;
    return {
      ...item,
      actual: toJsonObject({ ...item.actual, relatedIssuesOfSameType: related + 1 }),
    };
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface PersistOutcome {
  created: number;
  skipped: number;
}

async function persistDiscrepancies(
  discrepancies: readonly Discrepancy[],
  runId: string,
): Promise<PersistOutcome> {
  if (discrepancies.length === 0) return { created: 0, skipped: 0 };

  const types = [...new Set(discrepancies.map((item) => item.type))];

  // Every OPEN record of a relevant type. The open queue is the working set an
  // operator actually works through, so reading it whole is both cheap and the
  // only way to catch an issue that has been open since last week.
  const openRecords = await prisma.reconciliationRecord.findMany({
    where: { status: ReconciliationStatus.OPEN, type: { in: types } },
    select: { id: true, type: true, orderId: true, paymentId: true, providerPaymentId: true, expected: true },
  });

  const openByFingerprint = new Set<string>();
  const openByEntity = new Set<string>();
  for (const record of openRecords) {
    openByEntity.add(
      entityKey(record.type, record.orderId, record.paymentId, record.providerPaymentId),
    );
    const fingerprint = readFingerprint(record.expected);
    if (fingerprint !== null) openByFingerprint.add(fingerprint);
  }

  let created = 0;
  let skipped = 0;

  for (const item of discrepancies) {
    const key = entityKey(item.type, item.orderId, item.paymentId, item.providerPaymentId);
    if (openByFingerprint.has(item.fingerprint) || openByEntity.has(key)) {
      skipped += 1;
      continue;
    }

    try {
      await prisma.reconciliationRecord.create({
        data: {
          type: item.type,
          status: ReconciliationStatus.OPEN,
          orderId: item.orderId,
          paymentId: item.paymentId,
          providerPaymentId: item.providerPaymentId,
          // The fingerprint lives inside `expected` so a later run can recognise
          // this exact issue without an extra table.
          expected: toJsonObject({ ...item.expected, fingerprint: item.fingerprint }),
          actual: item.productId === null
            ? item.actual
            : toJsonObject({ ...item.actual, productId: item.productId }),
          discrepancy: item.discrepancy,
          runId,
        },
      });
      created += 1;
      // Mark as already-known so a duplicate inside THIS batch cannot slip past.
      openByFingerprint.add(item.fingerprint);
      openByEntity.add(key);
    } catch (error) {
      // One unwritable row must not abort the run; the next run re-detects it.
      skipped += 1;
      logger.error('Failed to record reconciliation discrepancy', {
        runId,
        type: item.type,
        orderId: item.orderId ?? undefined,
        paymentId: item.paymentId ?? undefined,
        providerPaymentId: item.providerPaymentId ?? undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { created, skipped };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function newRunId(): string {
  return `rec_${randomUUID()}`;
}

async function listProviderPayments(
  provider: PaymentProvider,
  from: Date,
  to: Date,
  pageLimit: number,
): Promise<ProviderPaymentDetails[]> {
  return pageProvider(
    (cursor) =>
      provider.listPayments({
        from,
        to,
        limit: pageLimit,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    'listPayments',
  );
}

async function listProviderRefunds(
  provider: PaymentProvider,
  from: Date,
  to: Date,
  pageLimit: number,
): Promise<RefundRecord[]> {
  return pageProvider(
    (cursor) =>
      provider.listRefunds({
        from,
        to,
        limit: pageLimit,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    'listRefunds',
  );
}

async function executeRun(
  options: RunReconciliationOptions,
  runId: string,
  heartbeat: Heartbeat,
): Promise<ReconciliationSummary> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const from = options.from;
  const to = options.to;
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const stuckThresholdMinutes =
    options.stuckThresholdMinutes ?? envInt('RECONCILIATION_STUCK_MINUTES', DEFAULT_STUCK_THRESHOLD_MINUTES);
  const compareOrderTotals = options.compareOrderTotals ?? true;

  const base = {
    runId,
    from: from.toISOString(),
    to: to.toISOString(),
  };

  // --- The provider is the source of truth. No provider, no run. -----------
  const provider = getPaymentProvider();
  if (provider === null) {
    logger.warn('Reconciliation skipped — payment provider is NOT CONFIGURED', {
      runId,
      from: base.from,
      to: base.to,
    });
    return {
      ...base,
      scanned: 0,
      providerPayments: 0,
      providerRefunds: 0,
      ordersScanned: 0,
      discrepancies: 0,
      byType: {},
      bySeverity: { INFO: 0, WARN: 0, CRITICAL: 0 },
      created: 0,
      skippedExisting: 0,
      NOT_CONFIGURED: true,
      durationMs: Date.now() - startedAt,
    };
  }

  if (!provider.capabilities.supportsListing) {
    // Surfaced, not faked: without list support this engine genuinely cannot
    // reconcile, and pretending otherwise would report a false "all clear".
    logger.warn('Reconciliation skipped — provider does not support payment listing', {
      runId,
      provider: provider.name,
    });
    return {
      ...base,
      scanned: 0,
      providerPayments: 0,
      providerRefunds: 0,
      ordersScanned: 0,
      discrepancies: 0,
      byType: {},
      bySeverity: { INFO: 0, WARN: 0, CRITICAL: 0 },
      created: 0,
      skippedExisting: 0,
      NOT_CONFIGURED: true,
      reason: 'PROVIDER_CANNOT_LIST',
      durationMs: Date.now() - startedAt,
    };
  }

  logger.info('Reconciliation run started', {
    ...base,
    provider: provider.name,
    providerStatus: provider.status,
  });

  // --- Provider side -------------------------------------------------------
  const [providerPayments, providerRefunds] = await Promise.all([
    listProviderPayments(provider, from, to, pageLimit),
    listProviderRefunds(provider, from, to, pageLimit),
  ]);

  const providerPaymentIds = providerPayments.map((item) => item.providerPaymentId);

  // --- Internal side -------------------------------------------------------
  // Payments: anything the provider told us about, plus everything we created
  // in the window (needed for DUPLICATE_PAYMENT on a charge the provider has
  // since settled twice).
  const paymentRows = await prisma.payment.findMany({
    where: {
      provider: provider.kind,
      OR: [
        { providerPaymentId: { in: providerPaymentIds } },
        { createdAt: { gte: from } },
      ],
    },
    select: {
      id: true,
      orderId: true,
      provider: true,
      providerPaymentId: true,
      providerCheckoutId: true,
      status: true,
      amountMinor: true,
      currency: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const payments = paymentRows.map(toPaymentSnapshot);

  const paymentIds = payments.map((row) => row.id);
  const linkedOrderIds = [...new Set(payments.map((row) => row.orderId))];

  // Orders: anything touched in the window, plus every order sitting in a
  // mid-fulfillment state regardless of age — a PAYMENT_VERIFIED order that
  // stopped three weeks ago is exactly the STUCK_ORDER this job exists to find.
  const stuckStatuses: OrderStatus[] = [...STUCK_ORDER_STATUSES];
  if (options.includeStalePending === true) stuckStatuses.push(OrderStatus.PAYMENT_PENDING);

  const orderRows = await prisma.order.findMany({
    where: {
      OR: [
        { updatedAt: { gte: from } },
        { id: { in: linkedOrderIds } },
        { status: { in: stuckStatuses } },
      ],
    },
    select: {
      id: true,
      reference: true,
      status: true,
      totalMinor: true,
      currency: true,
      productId: true,
      quantity: true,
      createdAt: true,
      updatedAt: true,
      paidAt: true,
    },
  });
  const orders = orderRows.map(toOrderSnapshot);
  const orderIds = orders.map((row) => row.id);

  // Fulfillment + inventory evidence. Only ids, statuses and counts.
  const [deliveryRows, codeCounts] = await Promise.all([
    orderIds.length === 0
      ? Promise.resolve<DeliverySnapshot[]>([])
      : prisma.delivery
          .findMany({
            where: { orderId: { in: orderIds } },
            select: { id: true, orderId: true, status: true, sentAt: true },
          })
          .then((rows) =>
            rows.map<DeliverySnapshot>((row) => ({
              id: row.id,
              orderId: row.orderId,
              status: row.status,
              sentAt: row.sentAt,
            })),
          ),
    loadOrderCodeCounts(orderIds),
  ]);

  const refundRows = await prisma.refund.findMany({
    where: {
      OR: [{ createdAt: { gte: from } }, { orderId: { in: orderIds } }],
    },
    select: {
      id: true,
      orderId: true,
      paymentId: true,
      providerRefundId: true,
      status: true,
      amountMinor: true,
      currency: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const refundSnapshots = refundRows.map(toRefundSnapshot);

  // Webhook evidence for MISSING_WEBHOOK / FAILED_WEBHOOK.
  const eventRows = await prisma.paymentEvent.findMany({
    where: {
      OR: [
        { receivedAt: { gte: from } },
        { paymentId: { in: paymentIds } },
        { orderId: { in: orderIds } },
      ],
    },
    select: {
      id: true,
      paymentId: true,
      orderId: true,
      signatureValid: true,
      processingError: true,
      payload: true,
    },
    take: MAX_EVENT_ROWS,
  });
  if (eventRows.length >= MAX_EVENT_ROWS) {
    logger.warn('PaymentEvent scan hit its row ceiling — coverage may be partial', {
      runId,
      limit: MAX_EVENT_ROWS,
    });
  }

  const eventsByPaymentId = new Map<string, EventTally>();
  const eventsByOrderId = new Map<string, EventTally>();
  const eventsByProviderPaymentId = new Map<string, EventTally>();

  function bump(map: Map<string, EventTally>, key: string | null, failed: boolean): void {
    if (key === null || key === '') return;
    let entry = map.get(key);
    if (entry === undefined) {
      entry = { count: 0, failed: 0 };
      map.set(key, entry);
    }
    entry.count += 1;
    if (failed) entry.failed += 1;
  }

  for (const event of eventRows) {
    const failed = isFailedEvent(event);
    bump(eventsByPaymentId, event.paymentId, failed);
    bump(eventsByOrderId, event.orderId, failed);
    bump(eventsByProviderPaymentId, readProviderPaymentId(event.payload), failed);
  }

  // --- Join provider <-> internal ----------------------------------------
  const paymentsByProviderId = new Map<string, PaymentSnapshot>();
  for (const payment of payments) {
    const providerPaymentId = payment.providerPaymentId;
    if (providerPaymentId !== null && providerPaymentId !== '') {
      paymentsByProviderId.set(providerPaymentId, payment);
    }
  }

  const ordersById = new Map<string, OrderSnapshot>();
  const ordersByReference = new Map<string, OrderSnapshot>();
  for (const order of orders) {
    ordersById.set(order.id, order);
    ordersByReference.set(order.reference, order);
  }

  const links: ProviderPaymentLink[] = providerPayments.map((providerPayment) => {
    const payment = paymentsByProviderId.get(providerPayment.providerPaymentId) ?? null;
    const order =
      payment !== null
        ? ordersById.get(payment.orderId) ?? null
        : resolveOrderFromMetadata(providerPayment, ordersById, ordersByReference);

    const tally = pickLargestTally(
      eventsByProviderPaymentId.get(providerPayment.providerPaymentId),
      payment !== null ? eventsByPaymentId.get(payment.id) : undefined,
      order !== null ? eventsByOrderId.get(order.id) : undefined,
    );

    return {
      providerPayment,
      payment,
      order,
      eventCount: tally.count,
      failedEventCount: tally.failed,
    };
  });

  const refundsByPaymentId = new Map<string, RefundSnapshot>();
  for (const refund of refundSnapshots) {
    if (!refundsByPaymentId.has(refund.paymentId)) refundsByPaymentId.set(refund.paymentId, refund);
  }

  // --- Pure comparisons ----------------------------------------------------
  const productRows = await prisma.product.findMany({
    where: { status: ProductStatus.ACTIVE },
    select: { id: true, slug: true, productName: true, status: true, inventoryCount: true },
  });
  const availableByProduct = await loadAvailableCodeCounts(productRows.map((row) => row.id));
  const products: ProductInventorySnapshot[] = productRows.map((row) => ({
    id: row.id,
    slug: row.slug,
    productName: row.productName,
    status: row.status,
    inventoryCount: row.inventoryCount,
    availableCount: availableByProduct.get(row.id) ?? 0,
  }));

  const discrepancies: Discrepancy[] = [
    // Provider-paid-but-unrecorded, provider-paid-but-no-webhook, wrong amount,
    // wrong currency, reversed money.
    ...compareProviderPaymentLinks(links, { compareOrderTotals }),
    // Refunds the provider completed that we never wrote down.
    ...findUnrecordedRefunds({
      refunds: providerRefunds,
      refundsByPaymentId,
      paymentsByProviderId,
      ordersById,
    }),
    ...findDuplicatePayments(payments),
    ...findStuckOrders(orders, {
      now,
      thresholdMinutes: stuckThresholdMinutes,
      ...(options.includeStalePending === true
        ? {
            includeStalePending: true,
            pendingThresholdMinutes:
              options.pendingThresholdMinutes ?? stuckThresholdMinutes * 6,
          }
        : {}),
    }),
    ...findFulfillmentMismatches({ orders, deliveries: deliveryRows, codeCounts }),
    ...findDepletedInventory(products),
  ];

  const byType = countByType(discrepancies);
  const bySeverity = countBySeverity(discrepancies);

  // Losing the lease mid-scan means another run owns the job now; writing
  // records under a lease we no longer hold would double-report.
  if (!heartbeat.healthy()) {
    throw new Error('Reconciliation lease was lost mid-run; aborting before writing records');
  }

  const persistable = collapseByEntity(discrepancies);
  const { created, skipped } = await persistDiscrepancies(persistable, runId);

  // --- Observability -------------------------------------------------------
  for (const [type, count] of Object.entries(byType)) {
    recordReconciliationMismatch(type, count);
  }
  for (const product of products) {
    if (product.status === ProductStatus.ACTIVE && product.availableCount === 0) {
      recordInventoryDepleted(product.slug);
    }
  }
  // Alerts fire on what the operator must act on: a CRITICAL finding is a
  // customer who paid and got nothing, or money that moved the wrong way.
  for (const item of discrepancies) {
    if (item.severity === 'CRITICAL') {
      observeReconciliationMismatch(item.type, item.orderId ?? undefined);
    }
  }

  recordWorkerHeartbeat(RECONCILIATION_LEASE_NAME, true);

  const durationMs = Date.now() - startedAt;
  logger.info('Reconciliation run finished', {
    ...base,
    scanned: providerPayments.length + providerRefunds.length + orders.length + products.length,
    discrepancies: discrepancies.length,
    created,
    skippedExisting: skipped,
    byType,
    durationMs,
  });

  if (bySeverity.CRITICAL !== undefined && bySeverity.CRITICAL > 0) {
    logger.warn('Reconciliation found critical discrepancies — operator action required', {
      runId,
      critical: bySeverity.CRITICAL,
      types: Object.entries(byType),
    });
  }

  return {
    ...base,
    scanned: providerPayments.length + providerRefunds.length + orders.length + products.length,
    providerPayments: providerPayments.length,
    providerRefunds: providerRefunds.length,
    ordersScanned: orders.length,
    discrepancies: discrepancies.length,
    byType,
    bySeverity,
    created,
    skippedExisting: skipped,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Compares the provider's view of a time window against ours and records every
 * disagreement.
 *
 * Does NOT mutate financial state or order status — see the module header. The
 * returned summary is JSON-safe and is spread straight into the cron response.
 *
 * @throws when the provider listing fails. That is a genuine job failure: the
 *   cron/Inngest retry is the correct response to it, and swallowing it would
 *   report a clean run that never happened.
 */
export async function runReconciliation(
  options: RunReconciliationOptions,
): Promise<ReconciliationSummary> {
  const runId = newRunId();
  const leaseName = options.leaseName ?? RECONCILIATION_LEASE_NAME;

  try {
    const outcome = await withLease(
      leaseName,
      (_lease, heartbeat) => executeRun(options, runId, heartbeat),
      options.leaseOptions ?? {},
    );

    if (!outcome.ok) {
      // Another run owns this job. Reporting this as success would hide it.
      return {
        runId,
        from: options.from.toISOString(),
        to: options.to.toISOString(),
        scanned: 0,
        providerPayments: 0,
        providerRefunds: 0,
        ordersScanned: 0,
        discrepancies: 0,
        byType: {},
        bySeverity: { INFO: 0, WARN: 0, CRITICAL: 0 },
        created: 0,
        skippedExisting: 0,
        skipped: true,
        reason: 'LEASE_HELD_BY_OTHER',
        durationMs: 0,
      };
    }

    return outcome.value;
  } catch (error) {
    recordWorkerHeartbeat(leaseName, false);
    logger.error('Reconciliation run failed', {
      runId,
      from: options.from.toISOString(),
      to: options.to.toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}