/**
 * Public surface of the reconciliation subsystem (spec §18).
 *
 * Three layers, deliberately separate:
 *   ./compare — PURE discrepancy logic. Plain data in, plain data out. Testable
 *               with no database, no provider and no clock.
 *   ./lease   — the cross-process WorkerLease that stops two runs overlapping.
 *   ./engine  — the I/O layer that pages the provider, joins it to Postgres and
 *               writes idempotent ReconciliationRecord rows.
 *
 * Import from `@/reconcile` rather than reaching into the individual modules.
 */

export {
  runReconciliation,
  DEFAULT_STUCK_THRESHOLD_MINUTES,
  type ReconciliationSummary,
  type RunReconciliationOptions,
} from './engine';

export {
  // Comparison primitives
  compareProviderPaymentLinks,
  findDuplicatePayments,
  findStuckOrders,
  findFulfillmentMismatches,
  findDepletedInventory,
  findUnrecordedRefunds,
  // Helpers shared with callers and tests
  countByType,
  countBySeverity,
  fingerprint,
  readFingerprint,
  toJsonObject,
  normalizeCurrency,
  currenciesMatch,
  providerOutcome,
  isProviderSettled,
  isProviderReversed,
  totalChargedMinor,
  hasCritical,
  STUCK_ORDER_STATUSES,
  SETTLED_PAYMENT_STATUSES,
  // Types
  type CompareProviderOptions,
  type DeliverySnapshot,
  type Discrepancy,
  type DiscrepancySeverity,
  type FulfillmentMismatchInput,
  type OrderCodeCount,
  type OrderSnapshot,
  type PaymentSnapshot,
  type ProductInventorySnapshot,
  type ProviderOutcome,
  type ProviderPaymentLink,
  type RefundComparisonInput,
  type RefundSnapshot,
  type StuckOrderOptions,
} from './compare';

export {
  RECONCILIATION_LEASE_NAME,
  DEFAULT_LEASE_TTL_MS,
  MAX_LEASE_TTL_MS,
  acquireLease,
  renewLease,
  releaseLease,
  startLeaseHeartbeat,
  withLease,
  type AcquireLeaseResult,
  type Heartbeat,
  type Lease,
  type LeaseOptions,
  type WithLeaseResult,
} from './lease';