/**
 * Public surface of the Whop payment adapter.
 *
 * Import from `@/payments/whop`, never from the individual modules, so the
 * provider can gain dependencies without rippling through callers.
 *
 * Re-exported deliberately:
 *   - the provider class + factory (the app's payment provider)
 *   - the webhook helpers the route and the Inngest workers share
 *   - the config helpers callers need to report REAL | SANDBOX |
 *     NOT_CONFIGURED honestly on /api/health
 *   - the per-operation circuit breakers, so /api/health and any future caller
 *     can see that an OPEN breaker fails fast without duplicating registry
 *     plumbing
 *
 * NOT re-exported: the raw HTTP client, the signature primitives or the money
 * helpers. Those are implementation details; exposing them would let a caller
 * bypass the amount/currency assertions that make verification authoritative.
 */

export {
  WhopPaymentProvider,
  createWhopPaymentProvider,
  whopPaymentProvider,
} from './provider';

export {
  WHOP_EVENTS,
  WHOP_EVENT_OUTCOMES,
  cardDescriptor,
  isDisputeEvent,
  isPaymentEvent,
  isRefundEvent,
  isReversalEvent,
  nextCursorFrom,
  normalizeRefundStatus,
  normalizeWhopWebhook,
  pageInfoFrom,
  paymentVerificationFromStatus,
  readWhopAccountId,
  readWhopEventAmount,
  readWhopOrderReference,
  readWhopPaymentId,
  whopOutcomeFor,
  type NormalizeOptions,
  type NormalizeResult,
  type WhopEventType,
} from './events';

export {
  WHOP_PROVIDER_NAME,
  enabledWhopPaymentMethods,
  hasSettleableMethod,
  requireWhopConfig,
  resolveWhopConfig,
  whopPaymentMethodConfiguration,
  type ResolvedWhopConfig,
  type WhopPaymentMethod,
} from './config';

export {
  WHOP_CIRCUIT_DEFAULTS,
  WHOP_CIRCUIT_OPERATIONS,
  assertWhopCircuitClosed,
  getWhopCircuit,
  isAnyWhopCircuitOpen,
  isWhopOutageError,
  resetWhopCircuits,
  runWithWhopCircuit,
  whopCircuitSnapshot,
  whopCircuitSnapshots,
  type WhopCircuitOperation,
} from './circuit';

export type { CircuitState } from '@/lib/circuit-breaker';

export type { WebhookVerificationResult, VerifiedWebhookEvent } from '@/payments/types';