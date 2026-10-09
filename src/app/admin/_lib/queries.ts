/**
 * Read models for the admin panel.
 *
 * Every function here is a plain async query used by a server component. They
 * contain no authorisation logic — each caller has already been through
 * `requirePageSession()` — and no presentation logic, so they stay testable
 * and reusable by the API routes.
 *
 * MONEY RULES OBSERVED THROUGHOUT
 * -------------------------------
 *  - Currency MONEY is NEVER summed across currencies. Every monetary total is
 *    keyed by currency and the dashboard renders one row per currency, exactly
 *    as it renders revenue. Summing USD and EUR into one number would be a
 *    financial bug, not a display shortcut.
 *  - Row COUNTS are the deliberate exception to that rule, and the distinction
 *    is load-bearing: "how many refunds are pending" has one correct answer for
 *    the whole book, because a count of rows carries no unit and cannot be
 *    misread as an amount. So counts stay currency-agnostic and are summed;
 *    every sum of `*Minor` stays per-currency. If a field's unit is money, it
 *    is per-currency. If its unit is rows, it is global.
 *  - Aggregates come back from Postgres as integers (or bigints for SUM), and
 *    are used as integers. No float ever touches a monetary total.
 *  - "Revenue" is reported GROSS and NET separately. NET prefers
 *    `Payment.netAmountMinor` — Whop's `amount_after_fees`, the amount actually
 *    banked — and the count of payments missing that field is surfaced so a
 *    partial net figure can never be mistaken for a complete one.
 *
 * CODE RULES OBSERVED THROUGHOUT
 * ------------------------------
 *  - No query in this file ever selects `InventoryCode.codeCiphertext`. The
 *    selects below are explicit for exactly that reason: adding the column to a
 *    later `select: true` would put encrypted (and therefore decryptable) code
 *    material into an admin list that has no business holding it.
 */

import { Prisma } from '@prisma/client';
import type {
  FulfillmentStatus,
  InventoryStatus,
  OrderStatus,
  PaymentStatus,
} from '@prisma/client';
import { prisma } from '@/db/prisma';

/** Payment statuses that mean money was successfully captured. */
export const CAPTURED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'PAID',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
];

/** Payment statuses that are still legitimately in flight. */
export const OPEN_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'CREATED',
  'PENDING',
  'REQUIRES_ACTION',
  'AUTHORIZED',
];

/**
 * Order states in which a code has left inventory. COGS and "gross margin" are
 * computed over exactly this set: revenue booked against stock that never left
 * the warehouse is not margin, it is a liability.
 */
export const RELEASED_ORDER_STATUSES: readonly OrderStatus[] = [
  'CODE_RESERVED',
  'CODE_DELIVERED',
  'COMPLETED',
  'REFUND_PENDING',
  'REFUNDED',
];

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface CurrencyRevenue {
  currency: string;
  /** Sum of `Payment.amountMinor` over captured payments. */
  grossMinor: number;
  /** Sum of `Payment.netAmountMinor` (post-fee). Falls back to amountMinor. */
  netMinor: number;
  /** gross - net, i.e. processor fees actually charged. */
  feeMinor: number;
  capturedPayments: number;
  /** Captured payments where the provider told us the net amount. */
  paymentsWithNet: number;
  /** Captured payments where netAmountMinor is null — net is an estimate. */
  paymentsWithoutNet: number;
  todayGrossMinor: number;
  todayNetMinor: number;
  todayCount: number;
}

/**
 * Refunds in a single currency — the refund counterpart of `CurrencyRevenue`.
 *
 * `succeededMinor` is money and is therefore never added to another currency's
 * value. The `*Count` fields are counts of rows, which are unitless and are
 * aggregated across the whole book instead; both live here so the dashboard can
 * render a per-currency table without reaching for a global figure.
 */
export interface CurrencyRefunds {
  currency: string;
  /** Sum of `Refund.amountMinor` over this currency's SUCCEEDED refunds. */
  succeededMinor: number;
  /** Every refund row in this currency, whatever its status. */
  count: number;
  succeededCount: number;
  pendingCount: number;
  failedCount: number;
}

export interface InventorySnapshot {
  byStatus: { status: InventoryStatus; count: number }[];
  total: number;
  /** Reservations whose lease has already lapsed — the reaper should reclaim. */
  expiredReservations: number;
  reservedForOrders: number;
}

export interface DashboardSnapshot {
  revenue: CurrencyRevenue[];
  successfulPayments: number;
  failedPayments: number;
  pendingPayments: number;
  expiredPayments: number;
  disputedPayments: number;
  completedOrders: number;
  manualReviewOrders: number;
  failedFulfillmentOrders: number;
  fulfillmentJobs: { status: FulfillmentStatus; count: number }[];
  /**
   * Refunds.
   *
   * There is deliberately NO `succeededMinor` field here. Money lives only in
   * `byCurrency`, so no consumer can read a cross-currency sum of
   * `Refund.amountMinor` off this object by accident — the type cannot express
   * one. The top-level counters below are ROW counts and are summed across
   * currencies deliberately; they are derived from `byCurrency` in
   * `loadDashboard` so the two views can never disagree.
   */
  refunds: {
    count: number;
    succeededCount: number;
    pendingCount: number;
    failedCount: number;
    /** Money, one entry per currency. */
    byCurrency: CurrencyRefunds[];
  };
  /** Cost of goods sold, by currency, over orders whose code was released. */
  cogs: { currency: string; cogsMinor: number; orders: number }[];
  productsByStatus: { status: string; count: number }[];
  lowStock: {
    id: string;
    slug: string;
    productName: string;
    inventoryCount: number;
    faceValueMinor: number;
    sellingPriceMinor: number;
    currency: string;
  }[];
  inventory: InventorySnapshot;
  generatedAt: Date;
}

function emptyRevenue(currency: string): CurrencyRevenue {
  return {
    currency,
    grossMinor: 0,
    netMinor: 0,
    feeMinor: 0,
    capturedPayments: 0,
    paymentsWithNet: 0,
    paymentsWithoutNet: 0,
    todayGrossMinor: 0,
    todayNetMinor: 0,
    todayCount: 0,
  };
}

function emptyRefunds(currency: string): CurrencyRefunds {
  return {
    currency,
    succeededMinor: 0,
    count: 0,
    succeededCount: 0,
    pendingCount: 0,
    failedCount: 0,
  };
}

/** UTC midnight. The dashboard's "today" is a UTC day, stated as such in the UI. */
export function startOfUtcToday(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Cost of goods sold.
 *
 * `Order` snapshots price but deliberately does not snapshot supplier cost —
 * cost is a live commercial fact, and freezing it would let a supplier price
 * rise silently rewrite the historical margin of orders already delivered.
 * So this joins Product for the unit cost and multiplies by the order quantity,
 * entirely in integer minor units inside Postgres.
 */
async function loadCogs(): Promise<{ currency: string; cogsMinor: number; orders: number }[]> {
  const rows = await prisma.$queryRaw<{ currency: string; cogs: bigint; orders: bigint }[]>(
    Prisma.sql`
      SELECT o."currency"                        AS "currency",
             SUM(p."supplierCostMinor" * o."quantity")::bigint AS "cogs",
             COUNT(*)::bigint                    AS "orders"
      FROM "Order" o
      JOIN "Product" p ON p."id" = o."productId"
      WHERE o."status" IN (${Prisma.join([...RELEASED_ORDER_STATUSES])})
      GROUP BY o."currency"
    `,
  );

  return rows.map((row) => ({
    currency: row.currency,
    cogsMinor: Number(row.cogs),
    orders: Number(row.orders),
  }));
}

export async function loadInventorySnapshot(): Promise<InventorySnapshot> {
  const [byStatus, expiredReservations, reservedForOrders] = await Promise.all([
    prisma.inventoryCode.groupBy({
      by: ['status'],
      _count: { _all: true },
      orderBy: { status: 'asc' },
    }),
    prisma.inventoryCode.count({
      where: { status: 'RESERVED', reservationExpiresAt: { lt: new Date() } },
    }),
    prisma.inventoryCode.count({
      where: { status: { in: ['RESERVED', 'ASSIGNED'] } },
    }),
  ]);

  const counts = byStatus.map((row) => ({ status: row.status, count: row._count._all }));
  return {
    byStatus: counts,
    total: counts.reduce((sum, entry) => sum + entry.count, 0),
    expiredReservations,
    reservedForOrders,
  };
}

export async function loadDashboard(now: Date = new Date()): Promise<DashboardSnapshot> {
  const todayStart = startOfUtcToday(now);

  const [
    revenueRows,
    todayRows,
    paymentStatusRows,
    orderStatusRows,
    fulfillmentRows,
    refundRows,
    cogs,
    productsByStatus,
    lowStock,
    inventory,
  ] = await Promise.all([
    // All-time revenue, bucketed by currency AND status so captured money is
    // never confused with a pending authorisation.
    prisma.payment.groupBy({
      by: ['currency', 'status'],
      _count: { _all: true },
      _sum: { amountMinor: true, netAmountMinor: true },
    }),
    prisma.payment.groupBy({
      by: ['currency'],
      // `Payment` has no `paidAt`: settlement is recorded on `verifiedAt`
      // (set only after signature + provider-API verification), which is the
      // moment the money is ours.
      where: { status: { in: [...CAPTURED_PAYMENT_STATUSES] }, verifiedAt: { gte: todayStart } },
      _count: { _all: true },
      _sum: { amountMinor: true, netAmountMinor: true },
    }),
    prisma.payment.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.fulfillmentJob.groupBy({ by: ['status'], _count: { _all: true } }),
    // Bucketed by currency AND status, exactly like the revenue query above.
    // Grouping by status alone cannot answer "how much did we refund in EUR",
    // because `Refund.amountMinor` is denominated in that row's own currency.
    prisma.refund.groupBy({
      by: ['currency', 'status'],
      _count: { _all: true },
      _sum: { amountMinor: true },
    }),
    loadCogs(),
    prisma.product.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.product.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        slug: true,
        productName: true,
        inventoryCount: true,
        faceValueMinor: true,
        sellingPriceMinor: true,
        currency: true,
      },
      orderBy: [{ inventoryCount: 'asc' }, { productName: 'asc' }],
      take: 8,
    }),
    loadInventorySnapshot(),
  ]);

  // Fold the group-by rows into one entry per currency. `_sum` on a nullable
  // column is `number | null`, and a NULL net is meaningfully different from a
  // zero net — it means the provider never told us.
  const byCurrency = new Map<string, CurrencyRevenue>();
  const ensure = (currency: string): CurrencyRevenue => {
    const existing = byCurrency.get(currency);
    if (existing) return existing;
    const created = emptyRevenue(currency);
    byCurrency.set(currency, created);
    return created;
  };

  const capturedSet = new Set<string>(CAPTURED_PAYMENT_STATUSES);
  for (const row of revenueRows) {
    if (!capturedSet.has(row.status)) continue;
    const bucket = ensure(row.currency);
    const amount = row._sum.amountMinor ?? 0;
    const net = row._sum.netAmountMinor;
    bucket.grossMinor += amount;
    bucket.capturedPayments += row._count._all;
    if (net === null) {
      bucket.paymentsWithoutNet += row._count._all;
      bucket.netMinor += amount; // conservative: assume zero fees were taken
    } else {
      bucket.paymentsWithNet += row._count._all;
      bucket.netMinor += net;
    }
    bucket.feeMinor += amount - (net ?? amount);
  }

  for (const row of todayRows) {
    const bucket = ensure(row.currency);
    const amount = row._sum.amountMinor ?? 0;
    bucket.todayGrossMinor += amount;
    bucket.todayNetMinor += row._sum.netAmountMinor ?? amount;
    bucket.todayCount += row._count._all;
  }

  const paymentCounts = new Map<string, number>();
  for (const row of paymentStatusRows) {
    paymentCounts.set(row.status, row._count._all);
  }
  const orderCounts = new Map<string, number>();
  for (const row of orderStatusRows) {
    orderCounts.set(row.status, row._count._all);
  }
  // Refunds fold the same way revenue does: one bucket per currency, keyed off
  // the currency the database grouped by, so `succeededMinor` never leaves the
  // currency it is denominated in. Row counts are accumulated per bucket here
  // and only added across buckets below.
  const refundsByCurrency = new Map<string, CurrencyRefunds>();
  const ensureRefunds = (currency: string): CurrencyRefunds => {
    const existing = refundsByCurrency.get(currency);
    if (existing) return existing;
    const created = emptyRefunds(currency);
    refundsByCurrency.set(currency, created);
    return created;
  };
  for (const row of refundRows) {
    const bucket = ensureRefunds(row.currency);
    bucket.count += row._count._all;
    if (row.status === 'SUCCEEDED') {
      bucket.succeededCount += row._count._all;
      bucket.succeededMinor += row._sum.amountMinor ?? 0;
    } else if (row.status === 'PENDING') {
      bucket.pendingCount += row._count._all;
    } else if (row.status === 'FAILED') {
      bucket.failedCount += row._count._all;
    }
  }

  // Row counts, summed across currencies. This is the one place a cross-currency
  // reduction is allowed, and it is derived from the buckets above rather than
  // from a separate pass over the rows, so the global totals and the per-currency
  // table are guaranteed to reconcile. Only counts are summed; no `*Minor` field
  // is touched here.
  const refundRowCounts = { count: 0, succeededCount: 0, pendingCount: 0, failedCount: 0 };
  for (const bucket of refundsByCurrency.values()) {
    refundRowCounts.count += bucket.count;
    refundRowCounts.succeededCount += bucket.succeededCount;
    refundRowCounts.pendingCount += bucket.pendingCount;
    refundRowCounts.failedCount += bucket.failedCount;
  }

  // Revenue sorted by volume so the busiest currency leads the table.
  const revenue = [...byCurrency.values()].sort(
    (a, b) => b.grossMinor - a.grossMinor || a.currency.localeCompare(b.currency),
  );

  // Refunds sorted by volume, for the same display reason and under the same
  // caveat: comparing two currencies' magnitudes is an ORDERING decision for
  // the table, never a total that gets shown to anyone.
  const refundRowsByCurrency = [...refundsByCurrency.values()].sort(
    (a, b) => b.succeededMinor - a.succeededMinor || a.currency.localeCompare(b.currency),
  );

  return {
    revenue,
    successfulPayments: CAPTURED_PAYMENT_STATUSES.reduce(
      (sum, status) => sum + (paymentCounts.get(status) ?? 0),
      0,
    ),
    failedPayments: paymentCounts.get('FAILED') ?? 0,
    pendingPayments: OPEN_PAYMENT_STATUSES.reduce(
      (sum, status) => sum + (paymentCounts.get(status) ?? 0),
      0,
    ),
    expiredPayments: paymentCounts.get('EXPIRED') ?? 0,
    disputedPayments: (paymentCounts.get('DISPUTED') ?? 0) + (paymentCounts.get('REVERSED') ?? 0),
    completedOrders: orderCounts.get('COMPLETED') ?? 0,
    manualReviewOrders: orderCounts.get('MANUAL_REVIEW') ?? 0,
    failedFulfillmentOrders: orderCounts.get('FULFILLMENT_FAILED') ?? 0,
    fulfillmentJobs: fulfillmentRows.map((row) => ({ status: row.status, count: row._count._all })),
    refunds: {
      ...refundRowCounts,
      byCurrency: refundRowsByCurrency,
    },
    cogs,
    productsByStatus: productsByStatus.map((row) => ({ status: row.status, count: row._count._all })),
    lowStock,
    inventory,
    generatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface OrderListQuery {
  /** Matches order reference (case-insensitive) or customer email. */
  q?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export const ORDER_PAGE_SIZE = 25;

export interface OrderListResult {
  orders: {
    id: string;
    reference: string;
    status: OrderStatus;
    customerEmail: string;
    productName: string;
    quantity: number;
    totalMinor: number;
    faceValueMinor: number;
    currency: string;
    createdAt: Date;
    paymentStatus: PaymentStatus | null;
    fulfillmentStatus: FulfillmentStatus | null;
    emailStatus: string | null;
    /** Only the trailing four characters — the ciphertext is never selected. */
    codeLast4: string | null;
  }[];
  total: number;
  page: number;
  pageSize: number;
}

function orderListWhere(q: OrderListQuery): Prisma.OrderWhereInput {
  const conditions: Prisma.OrderWhereInput[] = [];

  const term = q.q?.trim();
  if (term) {
    const normalized = term.toLowerCase();
    conditions.push({
      OR: [
        { reference: { contains: term, mode: 'insensitive' } },
        { customerEmail: { contains: term, mode: 'insensitive' } },
        { customerEmailNormalized: { contains: normalized } },
      ],
    });
  }

  const status = q.status?.trim();
  if (status && status !== 'ALL') {
    conditions.push({ status: status as OrderStatus });
  }

  return conditions.length > 0 ? { AND: conditions } : {};
}

export async function searchOrders(query: OrderListQuery): Promise<OrderListResult> {
  const pageSize = Math.min(Math.max(query.pageSize ?? ORDER_PAGE_SIZE, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const where = orderListWhere(query);

  const [total, rows] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        reference: true,
        status: true,
        customerEmail: true,
        productName: true,
        quantity: true,
        totalMinor: true,
        faceValueMinor: true,
        currency: true,
        createdAt: true,
        // codeLast4 only. codeCiphertext is deliberately absent.
        inventoryCodes: { select: { codeLast4: true }, take: 1 },
        payments: {
          select: { status: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        fulfillmentJobs: {
          select: { status: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        deliveries: {
          select: { status: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    }),
  ]);

  return {
    orders: rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      status: row.status,
      customerEmail: row.customerEmail,
      productName: row.productName,
      quantity: row.quantity,
      totalMinor: row.totalMinor,
      faceValueMinor: row.faceValueMinor,
      currency: row.currency,
      createdAt: row.createdAt,
      paymentStatus: row.payments[0]?.status ?? null,
      fulfillmentStatus: row.fulfillmentJobs[0]?.status ?? null,
      emailStatus: row.deliveries[0]?.status ?? null,
      codeLast4: row.inventoryCodes[0]?.codeLast4 ?? null,
    })),
    total,
    page,
    pageSize,
  };
}

/** The order detail read model. Returns null when the reference is unknown. */
export async function loadOrderDetail(reference: string) {
  return prisma.order.findUnique({
    where: { reference },
    select: {
      id: true,
      reference: true,
      status: true,
      productId: true,
      productName: true,
      quantity: true,
      customerEmail: true,
      customerEmailNormalized: true,
      faceValueMinor: true,
      sellingPriceMinor: true,
      unitPriceMinor: true,
      totalMinor: true,
      currency: true,
      region: true,
      deliveryMethod: true,
      riskLevel: true,
      riskDecision: true,
      riskScore: true,
      paidAt: true,
      completedAt: true,
      cancelledAt: true,
      manualReviewReason: true,
      createdAt: true,
      updatedAt: true,
      product: {
        select: { id: true, slug: true, status: true, supplierCostMinor: true },
      },
      payments: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          provider: true,
          providerPaymentId: true,
          providerCheckoutId: true,
          status: true,
          verifiedAt: true,
          amountMinor: true,
          netAmountMinor: true,
          feeMinor: true,
          currency: true,
          cardBrand: true,
          cardLast4: true,
          failureCode: true,
          failureMessage: true,
          declineCode: true,
          createdAt: true,
        },
      },
      fulfillmentJobs: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          attempts: true,
          maxAttempts: true,
          nextAttemptAt: true,
          lastError: true,
          inventoryAllocatedAt: true,
          startedAt: true,
          completedAt: true,
        },
      },
      deliveries: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          email: true,
          provider: true,
          providerMessageId: true,
          status: true,
          attempts: true,
          lastError: true,
          sentAt: true,
          deliveredAt: true,
          failedAt: true,
        },
      },
      refunds: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          amountMinor: true,
          currency: true,
          reason: true,
          failureMessage: true,
          providerRefundId: true,
          initiatedBy: true,
          createdAt: true,
          completedAt: true,
        },
      },
      inventoryCodes: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          // codeLast4 only — the plaintext is never selected here.
          codeLast4: true,
          status: true,
          region: true,
          currency: true,
          faceValueMinor: true,
          expiresAt: true,
          reservedAt: true,
          reservationExpiresAt: true,
          deliveredAt: true,
          revokedAt: true,
          externalRef: true,
        },
      },
      transitions: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          fromState: true,
          toState: true,
          reason: true,
          actor: true,
          metadata: true,
          createdAt: true,
        },
      },
      reconciliationRecords: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          type: true,
          status: true,
          discrepancy: true,
          providerPaymentId: true,
          createdAt: true,
          resolvedAt: true,
        },
      },
    },
  });
}

/**
 * Audit rows recorded against one specific order.
 *
 * AuditLog has no relation to Order — `entity`/`entityId` are deliberately
 * loose strings so a single table can record mutations of any kind, including
 * rows whose subject no longer exists. That also means an audit row survives a
 * cascade delete, which is the point.
 */
export async function loadOrderScopedAudit(orderId: string) {
  return prisma.auditLog.findMany({
    where: { entity: 'Order', entityId: orderId },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: { id: true, actor: true, action: true, entity: true, metadata: true, createdAt: true },
  });
}

/** Audit rows for an order identified by its customer-facing reference. */
export async function loadOrderAudit(reference: string) {
  const order = await prisma.order.findUnique({
    where: { reference },
    select: { id: true },
  });
  if (!order) return [];
  return loadOrderScopedAudit(order.id);
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/**
 * Products for the admin list, including suppliers and pricing inputs.
 * The pricing engine is applied by the caller (it is pure and takes a rule),
 * so this query stays a query.
 */
export async function loadAdminProducts(take = 100) {
  return prisma.product.findMany({
    orderBy: [{ status: 'asc' }, { productName: 'asc' }],
    take,
    select: {
      id: true,
      slug: true,
      productName: true,
      brand: true,
      category: true,
      region: true,
      description: true,
      currency: true,
      faceValueMinor: true,
      sellingPriceMinor: true,
      supplierCostMinor: true,
      discountBps: true,
      marginBps: true,
      status: true,
      inventoryCount: true,
      createdAt: true,
      updatedAt: true,
      providers: {
        select: {
          id: true,
          supplierId: true,
          supplierSku: true,
          supplierCostMinor: true,
          currency: true,
          region: true,
          active: true,
          supplier: { select: { id: true, name: true, active: true, authorizationRef: true } },
        },
      },
    },
  });
}

export async function loadAdminProduct(id: string) {
  return prisma.product.findUnique({
    where: { id },
    select: {
      id: true,
      slug: true,
      productName: true,
      brand: true,
      category: true,
      region: true,
      description: true,
      imageUrl: true,
      currency: true,
      faceValueMinor: true,
      sellingPriceMinor: true,
      supplierCostMinor: true,
      discountBps: true,
      marginBps: true,
      deliveryMethod: true,
      status: true,
      inventoryCount: true,
      createdAt: true,
      updatedAt: true,
      providers: {
        select: {
          id: true,
          supplierId: true,
          supplierSku: true,
          supplierCostMinor: true,
          currency: true,
          region: true,
          active: true,
          supplier: { select: { id: true, name: true, active: true } },
        },
      },
    },
  });
}

export async function loadSuppliers() {
  return prisma.supplier.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, active: true, authorizationRef: true },
  });
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface InventoryRow {
  id: string;
  codeLast4: string;
  status: InventoryStatus;
  productId: string;
  productName: string;
  supplierName: string | null;
  region: string;
  currency: string;
  faceValueMinor: number;
  orderReference: string | null;
  reservedAt: Date | null;
  reservationExpiresAt: Date | null;
  deliveredAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface InventoryOverview {
  snapshot: InventorySnapshot;
  byProduct: {
    productId: string;
    slug: string;
    productName: string;
    currency: string;
    sellingPriceMinor: number;
    faceValueMinor: number;
    available: number;
    reserved: number;
    assigned: number;
    delivered: number;
    revoked: number;
    total: number;
  }[];
  reservations: InventoryRow[];
  batches: {
    id: string;
    fileName: string | null;
    totalRows: number;
    importedRows: number;
    skippedRows: number;
    errorRows: number;
    status: string;
    createdAt: Date;
  }[];
}

export async function loadInventoryOverview(): Promise<InventoryOverview> {
  const [snapshot, productRows, reservations, batches] = await Promise.all([
    loadInventorySnapshot(),
    prisma.product.findMany({
      orderBy: [{ status: 'asc' }, { productName: 'asc' }],
      select: {
        id: true,
        slug: true,
        productName: true,
        currency: true,
        sellingPriceMinor: true,
        faceValueMinor: true,
        inventoryCount: true,
        inventory: { select: { status: true } },
      },
    }),
    prisma.inventoryCode.findMany({
      where: { status: { in: ['RESERVED', 'ASSIGNED'] } },
      orderBy: [{ reservationExpiresAt: 'asc' }],
      take: 50,
      select: {
        id: true,
        codeLast4: true,
        status: true,
        productId: true,
        region: true,
        currency: true,
        faceValueMinor: true,
        reservedAt: true,
        reservationExpiresAt: true,
        deliveredAt: true,
        expiresAt: true,
        createdAt: true,
        product: { select: { productName: true } },
        supplier: { select: { name: true } },
        order: { select: { reference: true } },
      },
    }),
    prisma.inventoryImportBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        fileName: true,
        totalRows: true,
        importedRows: true,
        skippedRows: true,
        errorRows: true,
        status: true,
        createdAt: true,
      },
    }),
  ]);

  const byProduct = productRows.map((product) => {
    const counts: Record<string, number> = {};
    for (const item of product.inventory) {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
    }
    return {
      productId: product.id,
      slug: product.slug,
      productName: product.productName,
      currency: product.currency,
      sellingPriceMinor: product.sellingPriceMinor,
      faceValueMinor: product.faceValueMinor,
      available: counts.AVAILABLE ?? 0,
      reserved: counts.RESERVED ?? 0,
      assigned: counts.ASSIGNED ?? 0,
      delivered: counts.DELIVERED ?? 0,
      revoked: counts.REVOKED ?? 0,
      total: product.inventory.length,
    };
  });

  return {
    snapshot,
    byProduct,
    reservations: reservations.map((row) => ({
      id: row.id,
      codeLast4: row.codeLast4,
      status: row.status,
      productId: row.productId,
      productName: row.product.productName,
      supplierName: row.supplier?.name ?? null,
      region: row.region,
      currency: row.currency,
      faceValueMinor: row.faceValueMinor,
      orderReference: row.order?.reference ?? null,
      reservedAt: row.reservedAt,
      reservationExpiresAt: row.reservationExpiresAt,
      deliveredAt: row.deliveredAt,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    })),
    batches,
  };
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

/**
 * Support lookup by exact order reference. This is the ONLY support read path
 * and it returns exactly the same shape as the admin order list — masked code,
 * no ciphertext — because support staff have no more need for a plaintext code
 * than an operator does, and support is the role most likely to be phished.
 */
export async function lookupByReference(reference: string) {
  const normalized = reference.trim().toUpperCase();
  const [byReference, byEmail] = await Promise.all([
    prisma.order.findUnique({
      where: { reference: normalized },
      select: {
        id: true,
        reference: true,
        status: true,
        customerEmail: true,
        productName: true,
        quantity: true,
        totalMinor: true,
        faceValueMinor: true,
        currency: true,
        createdAt: true,
        paidAt: true,
        completedAt: true,
        inventoryCodes: { select: { codeLast4: true, status: true }, take: 1 },
        payments: { select: { status: true, provider: true }, orderBy: { createdAt: 'desc' }, take: 1 },
        deliveries: { select: { status: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    }),
    normalized.includes('@')
      ? prisma.order.findMany({
          where: { customerEmailNormalized: normalized.toLowerCase() },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            reference: true,
            status: true,
            productName: true,
            totalMinor: true,
            currency: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  return { order: byReference, byEmail };
}