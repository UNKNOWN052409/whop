/**
 * Per-OPERATION circuit breakers for Whop.
 *
 * WHY PER OPERATION AND NOT ONE BREAKER FOR THE WHOLE CLIENT
 * Whop meters "600 requests per minute per operation and API credential", so
 * its health is genuinely per-operation. `listPayments` can be degraded (or
 * genuinely broken) while `createCheckoutConfiguration` is serving traffic
 * perfectly. A single client-wide breaker would let one slow endpoint take
 * every card payment down with it — the exact cascade this task exists to
 * prevent. Each operation therefore gets its own CLOSED/OPEN/HALF_OPEN state,
 * so a dead reconciliation endpoint cannot stop a customer from paying.
 *
 * ------------------------------------------------------------------
 * INTEGRATION POINT (one line in src/payments/whop/client.ts)
 * ------------------------------------------------------------------
 * Inside `createWhopClient().request()`, wrap the existing `fetch(...)` call:
 *
 *     import { runWithWhopCircuit } from './circuit';
 *     ...
 *     // inside the attempt loop, replacing the bare `await fetch(url, {...})`
 *     const response = await runWithWhopCircuit(operation, (signal) =>
 *       fetch(url, {
 *         method, headers, body: serialized,
 *         signal: signal ?? AbortSignal.timeout(timeoutMs),
 *         cache: 'no-store', credentials: 'omit', redirect: 'manual',
 *       }),
 *     );
 *
 * `runWithWhopCircuit` passes an AbortSignal that fires when the breaker's
 * per-call budget expires, so the socket is genuinely cancelled rather than
 * abandoned; the `signal ?? AbortSignal.timeout(timeoutMs)` keeps the existing
 * behaviour for anyone who omits it. Everything else in `request()` — the
 * retry loop, the rate limiter, the error envelope parsing — stays as-is, and
 * the breaker counts each attempt separately.
 *
 * If you would rather wrap the WHOLE retry loop instead of one attempt, that
 * also works, but raise `WHOP_CIRCUIT_DEFAULTS.timeoutMs` to at least
 * attempts x 15s + backoff (~50_000) or the breaker will time out calls that
 * the client was about to succeed on.
 *
 * ------------------------------------------------------------------
 * FAILURE ACCOUNTING — WHAT COUNTS AND WHY
 * ------------------------------------------------------------------
 * Only genuine provider unavailability trips a breaker: 5xx responses, transport
 * faults (DNS, reset socket) and budget overruns. Deliberately NOT counted:
 *   - 400/403/404/409/422 — Whop is healthy, the caller must fix the request.
 *   - 401 — our credential is revoked/wrong. That is a CONFIGURATION fault,
 *     already reported honestly as NOT_CONFIGURED on /api/health; folding it
 *     into a circuit would hide a config bug behind a mystery "circuit open".
 *   - 429 — rate limiting is a capacity signal the client-side limiter already
 *     handles; counting it would conflate "we asked too fast" with "they're
 *     down".
 *
 * Honesty note: this registry is per-process module state, exactly like the
 * client-side rate limiter in `client.ts`. On Vercel each instance has its own
 * breakers and instances share no memory, so N instances means up to N
 * independent OPEN/HALF_OPEN timelines and a cold start resets everything. One
 * instance may therefore still probe a dead Whop while its siblings fast-fail.
 * See the limitation note in `@/lib/circuit-breaker`.
 *
 * State is exposed read-only for /api/health and for tests; nothing here ever
 * touches money, credentials or request payloads.
 */

import {
  CircuitBreaker,
  isProviderOutageError,
  type CircuitBreakerSnapshot,
} from '@/lib/circuit-breaker';

/**
 * Whop operation ids used by the adapter today. The registry accepts ANY string
 * (the client passes its `operation` string straight through) — this list
 * exists so /api/health can report a stable, ordered set of expected breakers
 * even before one has ever been called.
 */
export const WHOP_CIRCUIT_OPERATIONS = [
  'createCheckoutConfiguration',
  'getPayment',
  'listPayments',
  'createRefund',
  'listRefunds',
] as const;

export type WhopCircuitOperation = (typeof WHOP_CIRCUIT_OPERATIONS)[number];

/**
 * Tunables. Chosen for a payments workload, not a generic service:
 *
 *  - failureThreshold 5: one 502 from Whop must not take card payments down,
 *    but five consecutive failures means something is genuinely wrong.
 *  - successThreshold 2: one lucky probe after an incident is not enough to
 *    declare recovery and let a full request flood back at a fragile upstream.
 *  - openMs 30_000: long enough to stop the bleeding, short enough that a brief
 *    Whop blip is not a 30-second payment outage for this app.
 *  - timeoutMs 20_000: slightly above the client's 15s per-attempt fetch
 *    timeout, so the client's own AbortSignal.timeout fires first and we are
 *    counting a real Whop timeout rather than racing it.
 */
export const WHOP_CIRCUIT_DEFAULTS = {
  failureThreshold: 5,
  successThreshold: 2,
  openMs: 30_000,
  timeoutMs: 20_000,
} as const;

const breakers = new Map<string, CircuitBreaker>();

/**
 * The breaker for one Whop operation, created on first use and reused for the
 * life of the process. Never returns null and never touches the network.
 */
export function getWhopCircuit(operation: string): CircuitBreaker {
  const existing = breakers.get(operation);
  if (existing) return existing;

  const breaker = new CircuitBreaker({
    // Namespaced so a shared metrics stream can tell whop operations apart
    // from any other breaker without carrying the provider field around.
    name: `whop.${operation}`,
    failureThreshold: WHOP_CIRCUIT_DEFAULTS.failureThreshold,
    successThreshold: WHOP_CIRCUIT_DEFAULTS.successThreshold,
    openMs: WHOP_CIRCUIT_DEFAULTS.openMs,
    timeoutMs: WHOP_CIRCUIT_DEFAULTS.timeoutMs,
    isFailure: isWhopOutageError,
    // Merged into the thrown error's `details`. Contains no secrets and never
    // a request or response body.
    details: { provider: 'whop', operation },
  });

  breakers.set(operation, breaker);
  return breaker;
}

/**
 * Run one Whop call through the operation's breaker.
 *
 * While that operation's circuit is OPEN this throws
 * `AppError`/`PROVIDER_UNAVAILABLE` (503, with `retryAfterSeconds`) WITHOUT
 * calling `fn` at all — no socket, no DNS lookup, no Whop quota spent.
 */
export function runWithWhopCircuit<T>(
  operation: string,
  fn: (signal: AbortSignal | undefined) => Promise<T> | T,
): Promise<T> {
  return getWhopCircuit(operation).run(fn);
}

/**
 * Whether an error should count against the circuit. Exposed so the client and
 * tests share one definition of "Whop is unwell" (see the header comment).
 */
export function isWhopOutageError(error: unknown): boolean {
  return isProviderOutageError(error);
}

/** Fail fast without reserving the probe slot. For "should I even try?" checks. */
export function assertWhopCircuitClosed(operation: string): void {
  getWhopCircuit(operation).assertAvailable();
}

export function whopCircuitSnapshot(operation: string): CircuitBreakerSnapshot {
  return getWhopCircuit(operation).snapshot();
}

/** Every known breaker, for /api/health. Contains no secrets. */
export function whopCircuitSnapshots(): Record<string, CircuitBreakerSnapshot> {
  const out: Record<string, CircuitBreakerSnapshot> = {};
  for (const operation of WHOP_CIRCUIT_OPERATIONS) {
    const breaker = breakers.get(operation);
    if (breaker) out[operation] = breaker.snapshot();
  }
  // Include anything the client used that we did not enumerate.
  for (const [operation, breaker] of breakers) {
    if (!(operation in out)) out[operation] = breaker.snapshot();
  }
  return out;
}

/** True when any operation's circuit is currently failing fast. */
export function isAnyWhopCircuitOpen(): boolean {
  for (const breaker of breakers.values()) {
    if (breaker.isOpen()) return true;
  }
  return false;
}

/** Test-only: drop all breaker state. Does not touch credentials or config. */
export function resetWhopCircuits(): void {
  breakers.clear();
}