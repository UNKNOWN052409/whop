/**
 * A small, dependency-free circuit breaker.
 *
 * Why it exists: when an upstream provider (Whop) is down, every in-flight
 * request on every Vercel function instance keeps its socket open, keeps its
 * event-loop slot busy, and keeps paying for a timeout it already knows is
 * worthless. Without a breaker a provider blip cascades into a total outage of
 * *this* app even though our database and Redis are perfectly healthy. The
 * whole point of this module is the OPEN state: calls fail fast in
 * microseconds WITHOUT touching the network.
 *
 * States
 *   CLOSED     — normal. Calls pass through. `failureThreshold` CONSECUTIVE
 *                failures open the circuit.
 *   OPEN       — fail fast. Every call throws AppError/PROVIDER_UNAVAILABLE
 *                without opening a socket. After `openMs` one probe is admitted.
 *   HALF_OPEN  — exactly ONE call is admitted at a time. `successThreshold`
 *                consecutive probe successes close the circuit; a single probe
 *                failure re-opens it and restarts the `openMs` timer.
 *
 * ------------------------------------------------------------------
 * HONEST LIMITATION — THIS IS PER-PROCESS STATE, NOT DISTRIBUTED
 * ------------------------------------------------------------------
 * On Vercel each function instance runs in its own isolate with its own heap;
 * instances do not share memory. There is NO distributed breaker here and none
 * is implied. Concretely, with N instances during a Whop outage:
 *
 *   - each instance independently reaches OPEN after its own `failureThreshold`
 *     consecutive failures, so the FIRST few requests from each instance still
 *     pay the network timeout — up to `failureThreshold` x `timeoutMs` of dead
 *     work per instance per operation;
 *   - a long-lived instance stays OPEN far longer than a freshly-spawned one,
 *     and a newly-spawned instance starts CLOSED, so **one bad instance may
 *     still probe a dead upstream** even while its siblings are fast-failing;
 *   - cold starts reset the breaker to CLOSED.
 *
 * That is an acceptable trade-off for this system: the breaker is a per-process
 * blast-radius damper, not a global rate limit. A genuinely shared breaker would
 * need Upstash Redis state (which we already depend on) — that is a deliberate
 * future change, not something this file does. Do not describe this as
 * "distributed" or "cluster-wide" in a doc, a comment or a postmortem.
 *
 * Also note there are deliberately NO background timers: the open window is
 * evaluated lazily on the next call. A held timer would keep a serverless
 * invocation warm and pin a handle open for no benefit.
 *
 * Safety: this module never logs or retains an Error instance, a response body
 * or a request payload. It keeps the failure CODE and the timestamp only, so a
 * circuit log line can never become a vector for leaking a redeem code, a PAN,
 * a CVV, an OTP or a UPI PIN.
 */

import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Used in logs, metrics and the thrown error. Defaults to "circuit". */
  name?: string;
  /** Consecutive failures before CLOSED -> OPEN. Default 5. */
  failureThreshold?: number;
  /** Consecutive HALF_OPEN successes before -> CLOSED. Default 2. */
  successThreshold?: number;
  /** How long the circuit stays OPEN before a probe is admitted. Default 30s. */
  openMs?: number;
  /** Per-call budget. 0 disables the budget. Default 15_000. */
  timeoutMs?: number;
  /**
   * Decides whether an error is evidence that the DEPENDENCY is unwell.
   * Defaults to `isProviderOutageError`. Returning false does not hide the
   * error — it is still thrown to the caller — it only means the error is not a
   * signal about upstream health (e.g. a 400 the caller must fix, or a 401 that
   * means our credential is revoked and /api/health should say so).
   */
  isFailure?: (error: unknown) => boolean;
  /** Merged into the thrown PROVIDER_UNAVAILABLE `details`. Never secrets. */
  details?: Record<string, unknown>;
  /** Injectable clock, for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** Timestamp of the OPEN transition, or null when not OPEN. */
  openedAt: number | null;
  /** Epoch ms at which the next probe becomes admissible, or null. */
  nextProbeAt: number | null;
  /** True while the single HALF_OPEN probe is in flight. */
  probeInFlight: boolean;
  totalCalls: number;
  totalFailures: number;
  totalRejections: number;
  /** Error CODE of the last counted failure, e.g. PROVIDER_UNAVAILABLE. */
  lastFailureCode: string | null;
}

/** Called on every state change; replaceable for metrics backends. */
export interface CircuitStateEvent {
  name: string;
  previousState: CircuitState;
  state: CircuitState;
  /** Why we moved: "failure_threshold_reached" | "probe_failed" | ... */
  reason: string;
  at: number;
  consecutiveFailures: number;
}

export type CircuitStateObserver = (event: CircuitStateEvent) => void;

const DEFAULTS = {
  failureThreshold: 5,
  successThreshold: 2,
  openMs: 30_000,
  timeoutMs: 15_000,
} as const;

let observer: CircuitStateObserver | null = null;

/**
 * Hook support for metrics. Call once at boot with your exporter; pass null to
 * go back to the default logger-based observer.
 */
export function setCircuitStateObserver(next: CircuitStateObserver | null): void {
  observer = next;
}

/**
 * Report a circuit state change.
 *
 * Default behaviour is the logger (one JSON line per transition, tagged so it
 * is greppable during an incident). If a custom observer is registered it is
 * called INSTEAD of the logger — a metrics backend is expected to log, or to
 * be paired with `setCircuitStateObserver` around the logger.
 *
 * Only the name, the state and non-secret counters are ever emitted.
 */
export function observeCircuitState(
  name: string,
  state: CircuitState,
  details?: Partial<Omit<CircuitStateEvent, 'name' | 'state'>> & Record<string, unknown>,
): void {
  const event: CircuitStateEvent = {
    name,
    previousState: details?.previousState ?? state,
    state,
    reason: details?.reason ?? 'unspecified',
    at: details?.at ?? Date.now(),
    consecutiveFailures: details?.consecutiveFailures ?? 0,
  };

  if (observer) {
    try {
      observer(event);
    } catch {
      // A broken metrics exporter must never take down a payment path.
    }
    return;
  }

  const context: Record<string, unknown> = {
    circuit: name,
    circuitState: state,
    previousCircuitState: event.previousState,
    reason: event.reason,
    consecutiveFailures: event.consecutiveFailures,
  };
  if (state === 'OPEN') logger.warn('Circuit opened; failing fast without calling upstream', context);
  else if (event.previousState !== state)
    logger.info('Circuit state changed', context);
}

function positiveInt(value: number | undefined, fallback: number, field: string, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new AppError(`Circuit "${name}" ${field} must be a positive integer`, 500, 'INTERNAL_ERROR');
  }
  return value;
}

function nonNegativeInt(value: number | undefined, fallback: number, field: string, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new AppError(`Circuit "${name}" ${field} must be a non-negative integer`, 500, 'INTERNAL_ERROR');
  }
  return value;
}

/**
 * Default failure predicate: transport faults, timeouts and 5xx-ish provider
 * errors count; client-side rejections do not.
 *
 * Deliberately NOT counted: 400/403/404/409/422 (the caller must fix it, Whop is
 * healthy) and 401 (our credential was revoked — that is a CONFIGURATION fault
 * that /api/health already reports honestly as NOT CONFIGURED, and hiding it
 * behind a mystery "circuit open" would make an incident harder to diagnose).
 *
 * Known trade-off: an untyped `Error` from our OWN code (a stray TypeError,
 * say) is indistinguishable from a transport fault and is counted as one. That
 * is the safe direction — a circuit that opens on our bug costs us availability,
 * a circuit that never opens on a real outage costs us the whole reason this
 * module exists. Override `isFailure` if a caller needs a stricter rule.
 */
export function isProviderOutageError(error: unknown): boolean {
  if (error instanceof AppError) return error.code === 'PROVIDER_UNAVAILABLE';
  // Non-AppError: an untyped transport fault (DNS, reset socket, timeout).
  return error instanceof Error;
}

interface Permit {
  isProbe: boolean;
}

const DEADLINE: unique symbol = Symbol('circuit.deadline');

export class CircuitBreaker {
  readonly name: string;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly openMs: number;
  private readonly timeoutMs: number;
  private readonly isFailure: (error: unknown) => boolean;
  private readonly extraDetails: Record<string, unknown>;
  private readonly nowFn: () => number;

  private currentState: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private probeInFlight = false;
  private openedAt: number | null = null;
  private nextProbeAt: number | null = null;
  private calls = 0;
  private failureCount = 0;
  private rejectionCount = 0;
  private lastFailureCode: string | null = null;

  constructor(options: CircuitBreakerOptions = {}) {
    const name = options.name ?? 'circuit';
    this.name = name;
    this.failureThreshold = positiveInt(options.failureThreshold, DEFAULTS.failureThreshold, 'failureThreshold', name);
    this.successThreshold = positiveInt(options.successThreshold, DEFAULTS.successThreshold, 'successThreshold', name);
    this.openMs = nonNegativeInt(options.openMs, DEFAULTS.openMs, 'openMs', name);
    this.timeoutMs = nonNegativeInt(options.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs', name);
    this.isFailure = options.isFailure ?? isProviderOutageError;
    this.extraDetails = options.details ?? {};
    this.nowFn = options.now ?? Date.now;
  }

  /**
   * The last DECIDED state. Note this does not advance on a timer: while OPEN,
   * `state` stays "OPEN" until a probe actually runs, so `nextProbeAt` in the
   * snapshot is what tells you a probe has become admissible.
   */
  get state(): CircuitState {
    return this.currentState;
  }

  /** True while calls are being failed fast right now. */
  isOpen(): boolean {
    if (this.currentState !== 'OPEN') return false;
    const now = this.nowFn();
    return this.nextProbeAt === null || now < this.nextProbeAt;
  }

  /** Pure read. Never admits the probe — a health check must not consume it. */
  snapshot(): CircuitBreakerSnapshot {
    return {
      name: this.name,
      state: this.currentState,
      consecutiveFailures: this.failures,
      consecutiveSuccesses: this.successes,
      openedAt: this.openedAt,
      nextProbeAt: this.nextProbeAt,
      probeInFlight: this.probeInFlight,
      totalCalls: this.calls,
      totalFailures: this.failureCount,
      totalRejections: this.rejectionCount,
      lastFailureCode: this.lastFailureCode,
    };
  }

  /** Test/diagnostic helper. Puts the breaker back to a pristine CLOSED state. */
  reset(): void {
    this.currentState = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.probeInFlight = false;
    this.openedAt = null;
    this.nextProbeAt = null;
    this.lastFailureCode = null;
  }

  /**
   * Fail fast if the circuit is open, WITHOUT reserving a probe slot.
   * Use this for "can I even try?" checks; use `run()` for the real thing.
   */
  assertAvailable(): void {
    if (this.currentState === 'OPEN') {
      const now = this.nowFn();
      if (this.nextProbeAt !== null && now >= this.nextProbeAt) return; // probe admissible
      this.rejectionCount += 1;
      throw this.unavailableError(now, 'circuit_open');
    }
  }

  /**
   * Run `fn` through the breaker.
   *
   * - OPEN            -> throws PROVIDER_UNAVAILABLE immediately, `fn` is never
   *                     called and no socket is opened.
   * - HALF_OPEN       -> only ONE call at a time is admitted; concurrent
   *                     callers fail fast too.
   * - every state     -> the call is bounded by `timeoutMs`. The callback is
   *                     handed an AbortSignal that fires on the deadline, so a
   *                     well-behaved transport can actually cancel the socket
   *                     instead of being abandoned.
   *
   * A call that blows the budget counts as a FAILURE (a dependency that cannot
   * answer in time is a dependency that is down) and the underlying promise is
   * detached, not awaited twice.
   */
  async run<T>(fn: (signal: AbortSignal | undefined) => Promise<T> | T): Promise<T> {
    const permit = this.acquire();
    try {
      const value = await this.execute(fn);
      this.onSuccess(permit);
      return value;
    } catch (error) {
      this.onFailure(error, permit);
      throw error;
    }
  }

  // --- Internals ---------------------------------------------------------------

  private acquire(): Permit {
    const now = this.nowFn();

    if (this.currentState === 'OPEN') {
      if (this.nextProbeAt !== null && now >= this.nextProbeAt) {
        this.transition('HALF_OPEN', now, 'open_window_elapsed');
      } else {
        this.rejectionCount += 1;
        throw this.unavailableError(now, 'circuit_open');
      }
    }

    if (this.currentState === 'HALF_OPEN') {
      if (this.probeInFlight) {
        this.rejectionCount += 1;
        throw this.unavailableError(now, 'probe_in_flight');
      }
      this.probeInFlight = true;
      return { isProbe: true };
    }

    this.calls += 1;
    return { isProbe: false };
  }

  private async execute<T>(fn: (signal: AbortSignal | undefined) => Promise<T> | T): Promise<T> {
    if (this.timeoutMs <= 0) return await fn(undefined);

    const controller = new AbortController();
    let fire: () => void = () => {};
    const deadline = new Promise<typeof DEADLINE>((resolve) => {
      fire = () => resolve(DEADLINE);
    });
    // Deliberately NOT unref()'d: an unref'd deadline can be skipped when the
    // caller's promise is the only pending work in the loop, and a budget that
    // silently does not fire is worse than no budget. We clearTimeout on every
    // path below, so the timer never outlives the call it bounds and can never
    // keep a serverless invocation warm on its own.
    const timer = setTimeout(() => {
      controller.abort(this.timeoutError());
      fire();
    }, this.timeoutMs);

    // `settled` never rejects, so a late rejection from the abandoned call can
    // never surface as an unhandled rejection.
    const settled = Promise.resolve()
      .then(() => fn(controller.signal))
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    const result = await Promise.race([settled, deadline]);
    clearTimeout(timer);

    if (result === DEADLINE) throw this.timeoutError();
    if (result.ok) return result.value;
    throw result.error;
  }

  private onSuccess(permit: Permit): void {
    const now = this.nowFn();
    if (permit.isProbe) this.calls += 1;

    if (this.currentState === 'HALF_OPEN') {
      this.probeInFlight = false;
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.failures = 0;
        this.successes = 0;
        this.probeInFlight = false;
        this.openedAt = null;
        this.nextProbeAt = null;
        this.currentState = 'CLOSED';
        observeCircuitState(this.name, 'CLOSED', {
          previousState: 'HALF_OPEN',
          reason: 'probe_succeeded',
          at: now,
          consecutiveFailures: 0,
        });
      }
      return;
    }

    this.failures = 0;
  }

  private onFailure(error: unknown, permit: Permit): void {
    const now = this.nowFn();
    if (permit.isProbe) this.calls += 1;
    this.failureCount += 1;
    this.successes = 0;

    if (this.currentState === 'HALF_OPEN') {
      this.open(now, 'probe_failed');
      return;
    }

    this.failures += 1;
    if (!this.isFailure(error)) {
      // Not evidence about upstream health: break the consecutive run rather
      // than letting an unrelated 400 push us over the threshold.
      this.failures = 0;
      return;
    }

    this.lastFailureCode = error instanceof AppError ? error.code : 'untyped_error';
    if (this.failures >= this.failureThreshold) this.open(now, 'failure_threshold_reached');
  }

  private open(now: number, reason: string): void {
    const previous = this.currentState;
    this.currentState = 'OPEN';
    this.probeInFlight = false;
    this.failures = 0;
    this.successes = 0;
    this.openedAt = now;
    this.nextProbeAt = now + this.openMs;
    observeCircuitState(this.name, 'OPEN', {
      previousState: previous,
      reason,
      at: now,
      consecutiveFailures: this.failureThreshold,
    });
  }

  private transition(state: CircuitState, now: number, reason: string): void {
    const previous = this.currentState;
    this.currentState = state;
    observeCircuitState(this.name, state, { previousState: previous, reason, at: now, consecutiveFailures: this.failures });
  }

  private timeoutError(): AppError {
    return new AppError(
      `${this.name} did not answer within ${this.timeoutMs}ms`,
      504,
      'PROVIDER_UNAVAILABLE',
      { details: { ...this.extraDetails, circuit: this.name, reason: 'timeout', timeoutMs: this.timeoutMs } },
    );
  }

  private unavailableError(now: number, reason: string): AppError {
    const retryInMs = this.nextProbeAt === null ? this.openMs : Math.max(0, this.nextProbeAt - now);
    return new AppError(
      `${this.name} is temporarily unavailable (circuit is OPEN)`,
      503,
      'PROVIDER_UNAVAILABLE',
      {
        details: {
          ...this.extraDetails,
          circuit: this.name,
          circuitState: this.currentState,
          reason,
          openMs: this.openMs,
          retryInMs,
        },
        retryAfterSeconds: Math.max(1, Math.ceil(retryInMs / 1000)),
      },
    );
  }
}

export function createCircuitBreaker(options?: CircuitBreakerOptions): CircuitBreaker {
  return new CircuitBreaker(options);
}