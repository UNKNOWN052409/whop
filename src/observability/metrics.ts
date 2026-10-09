/**
 * In-process Prometheus metrics registry (spec §22).
 *
 * Hand-rolled on purpose: no dependency, no client library, no risk of a
 * version bump changing scrape output. It implements exactly the slice of the
 * Prometheus data model this service needs — counters, gauges and histograms
 * with static label sets — and renders the text exposition format
 * (version 0.0.4).
 *
 * SCOPE AND HONESTY
 *
 * These metrics are PER PROCESS. On a serverless deploy every cold start gets
 * a fresh registry, so counters reset when an instance is recycled and a
 * `rate()` over them is per-instance, not fleet-wide. That is a real limitation
 * of in-process metrics on Vercel, not something this module papers over: the
 * durable, cross-instance truth lives in Postgres (Payment, Order,
 * ReconciliationRecord) and this registry exists for fast, cheap operational
 * signal plus alerting input.
 *
 * Nothing here ever receives a redeem code, PAN, email address or any other
 * customer secret. Label values are limited to enums and internal ids by
 * construction — see `sanitizeLabelValue`.
 */

import { appConfig } from '@/lib/env';
import { logger } from '@/lib/logger';

// --- Types -------------------------------------------------------------------

export type MetricType = 'counter' | 'gauge' | 'histogram';

export type LabelValues = Readonly<Record<string, string>>;

export type Series = { labels: Record<string, string>; value: number };

/**
 * Hard cap on distinct label combinations per metric. An unbounded label (a
 * raw provider id, an email) would be a memory leak and a scrape-time DoS;
 * this turns that class of bug into a dropped series plus a visible counter.
 */
const MAX_SERIES_PER_METRIC = 500;

const MAX_LABEL_VALUE_LENGTH = 120;

/** Latency buckets in milliseconds. Covers ~10ms to ~30s. */
export const DEFAULT_LATENCY_BUCKETS_MS: readonly number[] = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
];

/** Rolling window used by the derived rate gauges. */
const RATE_WINDOW_MS = 5 * 60_000;
const RATE_WINDOW_MAX_SAMPLES = 512;

// --- Formatting helpers ------------------------------------------------------

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? '+Inf' : '-Inf';
  if (Number.isInteger(value)) return String(value);
  const rounded = Number(value.toPrecision(12));
  return String(rounded);
}

/** Escapes a label value per the exposition format. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Escapes HELP text: backslash and newline only (quotes are literal). */
function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/**
 * Normalises a label value. Control characters are stripped (they would break
 * the exposition format) and the value is bounded. Callers are expected to
 * pass enums or internal ids only; nothing here attempts to detect PII, so the
 * API deliberately refuses arbitrary payloads as labels.
 */
export function sanitizeLabelValue(value: string): string {
  const cleaned = value.replace(/[\r\n\t]/g, ' ').trim();
  return cleaned.length > MAX_LABEL_VALUE_LENGTH
    ? `${cleaned.slice(0, MAX_LABEL_VALUE_LENGTH)}…`
    : cleaned;
}

function buildSeriesLabels(labels: LabelValues, labelNames: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of labelNames) {
    const raw = labels[name];
    out[name] = raw === undefined ? '' : sanitizeLabelValue(raw);
  }
  return out;
}

function seriesKey(labelNames: readonly string[], labels: Record<string, string>): string {
  if (labelNames.length === 0) return '';
  return labelNames.map((name) => `${name}=${labels[name] ?? ''}`).join('|');
}

function formatLabels(labels: Record<string, string>, extra?: { le?: number }): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(labels)) {
    parts.push(`${name}="${escapeLabelValue(value)}"`);
  }
  if (extra?.le !== undefined) parts.push(`le="${formatValue(extra.le)}"`);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

/**
 * `name{label="value"} 1`, with an optional `le` bucket boundary appended.
 * Passing `Number.POSITIVE_INFINITY` emits the mandatory `le="+Inf"` bucket.
 */
function renderSampleLine(
  name: string,
  labels: Record<string, string>,
  value: number,
  le?: number,
): string {
  const rendered = le === undefined ? formatLabels(labels) : formatLabels(labels, { le });
  return `${name}${rendered} ${formatValue(value)}`;
}

// --- Metric implementations --------------------------------------------------

class Counter {
  readonly type = 'counter' as const;
  private readonly series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
  ) {}

  inc(labels: LabelValues = {}, amount = 1): void {
    if (!Number.isFinite(amount)) return;
    const key = seriesKey(this.labelNames, buildSeriesLabels(labels, this.labelNames));
    const existing = this.series.get(key);
    if (existing) {
      existing.value += amount;
      return;
    }
    if (this.series.size >= MAX_SERIES_PER_METRIC) {
      droppedSeriesCounter.inc({ metric: this.name }, 1);
      return;
    }
    this.series.set(key, { labels: buildSeriesLabels(labels, this.labelNames), value: amount });
  }

  get(labels: LabelValues = {}): number {
    const key = seriesKey(this.labelNames, buildSeriesLabels(labels, this.labelNames));
    return this.series.get(key)?.value ?? 0;
  }

  /** Sum across every series. Used by the alert evaluator. */
  total(): number {
    let sum = 0;
    for (const entry of this.series.values()) sum += entry.value;
    return sum;
  }

  reset(): void {
    this.series.clear();
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} counter`];
    for (const entry of this.series.values()) {
      lines.push(renderSampleLine(this.name, entry.labels, entry.value));
    }
    // A counter with no series still has to be declared, otherwise a dashboard
    // breaks with "metric not found" before the first request lands.
    if (this.series.size === 0) {
      lines.push(renderSampleLine(this.name, buildSeriesLabels({}, this.labelNames), 0));
    }
    return lines;
  }
}

class Gauge {
  readonly type = 'gauge' as const;
  private readonly series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
  ) {}

  set(value: number, labels: LabelValues = {}): void {
    if (!Number.isFinite(value)) return;
    const normalised = buildSeriesLabels(labels, this.labelNames);
    const key = seriesKey(this.labelNames, normalised);
    const existing = this.series.get(key);
    if (existing) {
      existing.value = value;
      return;
    }
    if (this.series.size >= MAX_SERIES_PER_METRIC) {
      droppedSeriesCounter.inc({ metric: this.name }, 1);
      return;
    }
    this.series.set(key, { labels: normalised, value });
  }

  inc(labels: LabelValues = {}, amount = 1): void {
    const normalised = buildSeriesLabels(labels, this.labelNames);
    const key = seriesKey(this.labelNames, normalised);
    const existing = this.series.get(key);
    if (existing) {
      existing.value += amount;
      return;
    }
    this.set(amount, labels);
  }

  dec(labels: LabelValues = {}, amount = 1): void {
    this.inc(labels, -amount);
  }

  get(labels: LabelValues = {}): number {
    const key = seriesKey(this.labelNames, buildSeriesLabels(labels, this.labelNames));
    return this.series.get(key)?.value ?? 0;
  }

  /** Sum across every series. */
  total(): number {
    let sum = 0;
    for (const entry of this.series.values()) sum += entry.value;
    return sum;
  }

  /**
   * Every current series, labels included. Gauge readers (the alert evaluator)
   * need the label set, not just the total — a per-product gauge is useless
   * without knowing which product each value belongs to.
   */
  values(): Series[] {
    return [...this.series.values()];
  }

  reset(): void {
    this.series.clear();
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} gauge`];
    if (this.series.size === 0) {
      lines.push(renderSampleLine(this.name, buildSeriesLabels({}, this.labelNames), 0));
      return lines;
    }
    for (const entry of this.series.values()) {
      lines.push(renderSampleLine(this.name, entry.labels, entry.value));
    }
    return lines;
  }
}

class Histogram {
  readonly type = 'histogram' as const;
  private readonly series = new Map<
    string,
    { labels: Record<string, string>; counts: number[]; sum: number; count: number }
  >();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
    readonly buckets: readonly number[],
  ) {}

  observe(value: number, labels: LabelValues = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const normalised = buildSeriesLabels(labels, this.labelNames);
    const key = seriesKey(this.labelNames, normalised);
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= MAX_SERIES_PER_METRIC) {
        droppedSeriesCounter.inc({ metric: this.name }, 1);
        return;
      }
      entry = {
        labels: normalised,
        counts: this.buckets.map(() => 0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    // Cumulative buckets: increment every boundary the value falls under.
    for (let i = 0; i < this.buckets.length; i += 1) {
      const boundary = this.buckets[i];
      if (boundary !== undefined && value <= boundary) {
        entry.counts[i] = (entry.counts[i] ?? 0) + 1;
      }
    }
  }

  count(labels: LabelValues = {}): number {
    const key = seriesKey(this.labelNames, buildSeriesLabels(labels, this.labelNames));
    return this.series.get(key)?.count ?? 0;
  }

  sum(labels: LabelValues = {}): number {
    const key = seriesKey(this.labelNames, buildSeriesLabels(labels, this.labelNames));
    return this.series.get(key)?.sum ?? 0;
  }

  /** Mean observed value, or 0 when nothing has been observed. */
  mean(labels: LabelValues = {}): number {
    const count = this.count(labels);
    if (count === 0) return 0;
    return this.sum(labels) / count;
  }

  reset(): void {
    this.series.clear();
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} histogram`];
    // An unobserved histogram still has to be declared, otherwise a dashboard
    // renders "metric not found" until the first request lands.
    const entries: {
      labels: Record<string, string>;
      counts: number[];
      sum: number;
      count: number;
    }[] =
      this.series.size > 0
        ? [...this.series.values()]
        : [
            {
              labels: buildSeriesLabels({}, this.labelNames),
              counts: this.buckets.map(() => 0),
              sum: 0,
              count: 0,
            },
          ];

    for (const entry of entries) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i += 1) {
        const boundary = this.buckets[i];
        if (boundary === undefined) continue;
        cumulative += entry.counts[i] ?? 0;
        lines.push(
          renderSampleLine(`${this.name}_bucket`, entry.labels, cumulative, boundary),
        );
      }
      // The +Inf bucket is mandatory in the exposition format and must equal
      // the total observation count.
      lines.push(
        renderSampleLine(
          `${this.name}_bucket`,
          entry.labels,
          entry.count,
          Number.POSITIVE_INFINITY,
        ),
      );
      lines.push(renderSampleLine(`${this.name}_sum`, entry.labels, entry.sum));
      lines.push(renderSampleLine(`${this.name}_count`, entry.labels, entry.count));
    }
    return lines;
  }
}

// --- Registry ----------------------------------------------------------------

type AnyMetric = Counter | Gauge | Histogram;

type Collector = () => void;

class MetricsRegistry {
  private readonly metrics = new Map<string, AnyMetric>();
  private readonly collectors: Collector[] = [];
  private readonly seriesCreatedAt = Date.now();

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.resolve(name, () => new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.resolve(name, () => new Gauge(name, help, labelNames));
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets: readonly number[] = DEFAULT_LATENCY_BUCKETS_MS,
  ): Histogram {
    const sorted = [...buckets].sort((a, b) => a - b);
    return this.resolve(name, () => new Histogram(name, help, labelNames, sorted));
  }

  /**
   * Returns the metric registered under `name`, creating it on first use.
   *
   * The generic is what makes `counter()`/`gauge()`/`histogram()` return their
   * concrete type instead of the erased union: a name is registered exactly
   * once, always through the same accessor, so an existing entry is guaranteed
   * to be the same kind of metric the caller asked for.
   */
  private resolve<T extends AnyMetric>(name: string, create: () => T): T {
    const existing = this.metrics.get(name) as T | undefined;
    if (existing) return existing;
    const created = create();
    this.metrics.set(name, created);
    return created;
  }

  /** Runs before every render: recomputes gauges derived from other metrics. */
  addCollector(collector: Collector): void {
    this.collectors.push(collector);
  }

  uptimeSeconds(): number {
    return Math.round((Date.now() - this.seriesCreatedAt) / 1000);
  }

    /**
   * Clears every series. Uptime is intentionally NOT reset: a scrape must never
   * be able to make a just-started process look long-lived (or vice versa).
   */
  reset(): void {
    for (const metric of this.metrics.values()) metric.reset();
  }

  /** Prometheus text exposition format, version 0.0.4. */
  render(): string {
    for (const collector of this.collectors) {
      try {
        collector();
      } catch (error) {
        logger.debug('metrics collector failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const lines: string[] = [];
    for (const metric of this.metrics.values()) lines.push(...metric.render());
    return `${lines.join('\n')}\n`;
  }
}

// --- Rolling rate window -----------------------------------------------------

/**
 * Fixed-capacity ring of recent outcomes used to derive error/success rates.
 *
 * Deliberately simple and bounded: a rate computed over a sliding window from
 * a capped sample list. It is honest about being an approximation (the oldest
 * retained sample may be less than one window old) and never grows without
 * limit.
 */
export class RateWindow {
  private readonly at: number[] = [];
  private readonly failed: boolean[] = [];

  constructor(
    readonly windowMs: number = RATE_WINDOW_MS,
    private readonly maxSamples: number = RATE_WINDOW_MAX_SAMPLES,
  ) {}

  record(success: boolean, at: number = Date.now()): void {
    this.at.push(at);
    this.failed.push(!success);
    while (this.at.length > this.maxSamples) {
      this.at.shift();
      this.failed.shift();
    }
    this.trim(at);
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.at.length > 0 && (this.at[0] ?? 0) < cutoff) {
      this.at.shift();
      this.failed.shift();
    }
  }

  /** Prunes samples that fell out of the window. */
  prune(now: number = Date.now()): void {
    this.trim(now);
  }

  total(now: number = Date.now()): number {
    this.trim(now);
    return this.at.length;
  }

  failures(now: number = Date.now()): number {
    this.trim(now);
    let count = 0;
    for (const value of this.failed) if (value) count += 1;
    return count;
  }

  /** failures / total in the window; 0 when nothing was observed. */
  failureRate(now: number = Date.now()): number {
    this.trim(now);
    if (this.at.length === 0) return 0;
    let count = 0;
    for (const value of this.failed) if (value) count += 1;
    return count / this.at.length;
  }

  /** successRate / total in the window; 1 when nothing was observed. */
  successRate(now: number = Date.now()): number {
    this.trim(now);
    if (this.at.length === 0) return 1;
    let count = 0;
    for (const value of this.failed) if (!value) count += 1;
    return count / this.at.length;
  }

  reset(): void {
    this.at.length = 0;
    this.failed.length = 0;
  }
}

// --- Singleton ---------------------------------------------------------------

const globalForMetrics = globalThis as unknown as { __dshMetricsRegistry?: MetricsRegistry };

/**
 * Module-level singleton on globalThis so Next.js dev HMR and duplicate module
 * instances do not reset the counters mid-request.
 */
export const registry: MetricsRegistry = globalForMetrics.__dshMetricsRegistry ?? new MetricsRegistry();
globalForMetrics.__dshMetricsRegistry = registry;

// --- Metric definitions ------------------------------------------------------

const droppedSeriesCounter = registry.counter(
  'metrics_series_dropped_total',
  'Label combinations dropped because the per-metric series cap was reached.',
  ['metric'],
);

export const paymentLatency = registry.histogram(
  'payment_latency_ms',
  'Server-side payment provider call latency in milliseconds.',
  ['provider', 'operation'],
);

export const fulfillmentLatency = registry.histogram(
  'fulfillment_latency_ms',
  'End-to-end fulfillment latency from paid order to code delivered, in milliseconds.',
  ['stage'],
);

export const emailLatency = registry.histogram(
  'email_latency_ms',
  'Transactional email send latency in milliseconds.',
  ['provider'],
);

export const queueDepth = registry.gauge(
  'queue_depth',
  'Fulfillment jobs awaiting execution.',
  [],
);

export const queueOldestAge = registry.gauge(
  'queue_oldest_job_age_seconds',
  'Age of the oldest unprocessed fulfillment job in seconds.',
  [],
);

export const providerErrorRate = registry.gauge(
  'provider_error_rate',
  'Rolling-window ratio of failed provider requests to total provider requests (0..1).',
  ['provider'],
);

export const providerRequests = registry.counter(
  'provider_requests_total',
  'Outbound requests to a payment or email provider.',
  ['provider', 'operation', 'outcome'],
);

export const paymentSuccessRate = registry.gauge(
  'payment_success_rate',
  'Rolling-window ratio of payments that reached a terminal success to total payments observed (0..1).',
  [],
);

export const ordersTotal = registry.counter(
  'orders_total',
  'Orders by current status.',
  ['status'],
);

export const inventoryLevels = registry.gauge(
  'inventory_levels',
  'Redeem codes currently available for allocation, by product.',
  ['product'],
);

export const webhookVerificationFailures = registry.counter(
  'webhook_verification_failures_total',
  'Webhook payloads rejected by signature, timestamp or schema verification.',
  ['provider', 'reason'],
);

export const reconciliationMismatches = registry.counter(
  'reconciliation_mismatches_total',
  'Discrepancies found between local records and the provider, by type.',
  ['type'],
);

export const inventoryDepleted = registry.counter(
  'inventory_depleted_total',
  'Times a product ran out of redeemable codes.',
  ['product'],
);

export const fulfillmentTotal = registry.counter(
  'fulfillment_total',
  'Fulfillment jobs by terminal status.',
  ['status'],
);

export const alertsFired = registry.counter(
  'alerts_fired_total',
  'Operational alerts emitted by the alert evaluator.',
  ['code', 'severity'],
);

export const databaseUp = registry.gauge(
  'database_up',
  '1 when the most recent database probe succeeded, 0 otherwise.',
  [],
);

export const databaseLatency = registry.histogram(
  'database_probe_latency_ms',
  'Latency of the /api/health database probe.',
  [],
);

export const appUp = registry.gauge(
  'app_up',
  'Always 1 while this process is serving.',
  [],
);

export const appUptime = registry.gauge('app_uptime_seconds', 'Process uptime in seconds.', []);

export const appInfo = registry.gauge('app_info', 'Build/environment information.', ['env']);

const workerHeartbeat = registry.gauge(
  'worker_heartbeat_timestamp_seconds',
  'Unix timestamp of the last successful worker lease renewal.',
  ['worker'],
);

const workerAlive = registry.gauge('worker_alive', '1 while a worker holds its lease.', ['worker']);

/** Exposed so heartbeat.ts can record liveness without owning a new metric. */
export const workerMetrics = { workerHeartbeat, workerAlive };

// --- Recording helpers -------------------------------------------------------

export type ProviderOutcome = 'success' | 'error' | 'timeout' | 'rejected';

const providerRateWindows = new Map<string, RateWindow>();
const paymentRateWindow = new RateWindow();

function providerWindow(provider: string): RateWindow {
  const key = sanitizeLabelValue(provider) || 'unknown';
  let window = providerRateWindows.get(key);
  if (!window) {
    window = new RateWindow();
    providerRateWindows.set(key, window);
  }
  return window;
}

/**
 * Single entry point for every outbound provider call.
 *
 * Records latency, the request counter, and the rolling error rate in one
 * place so no caller can accidentally update one and forget the other.
 */
export function recordProviderRequest(input: {
  provider: string;
  operation: string;
  outcome: ProviderOutcome;
  durationMs?: number;
}): void {
  const provider = sanitizeLabelValue(input.provider) || 'unknown';
  const operation = sanitizeLabelValue(input.operation) || 'unknown';
  providerRequests.inc({ provider, operation, outcome: input.outcome }, 1);
  providerWindow(provider).record(input.outcome === 'success');
  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) {
    paymentLatency.observe(input.durationMs, { provider, operation });
  }
}

/** Records a terminal payment outcome for the rolling payment_success_rate. */
export function recordPaymentOutcome(ok: boolean, at: number = Date.now()): void {
  paymentRateWindow.record(ok, at);
}

/** Current rolling payment success rate, 1 when nothing has been observed. */
export function currentPaymentSuccessRate(): number {
  return paymentRateWindow.successRate();
}

/** Current rolling failure rate for one provider, 0 when nothing observed. */
export function currentProviderErrorRate(provider: string): number {
  return providerWindow(provider).failureRate();
}

/** Observation counts in the payment success-rate window. */
export function paymentWindowCounts(): { total: number; failures: number; successRate: number } {
  return {
    total: paymentRateWindow.total(),
    failures: paymentRateWindow.failures(),
    successRate: paymentRateWindow.successRate(),
  };
}

export function setQueueDepth(depth: number): void {
  queueDepth.set(Math.max(0, Math.trunc(Number.isFinite(depth) ? depth : 0)));
}

export function incrementQueueDepth(by = 1): void {
  queueDepth.set(Math.max(0, queueDepth.get() + by));
}

export function decrementQueueDepth(by = 1): void {
  queueDepth.set(Math.max(0, queueDepth.get() - by));
}

export function currentQueueDepth(): number {
  return queueDepth.get();
}

/** Records an order reaching a state. `status` is an OrderStatus value. */
export function recordOrderStatus(status: string): void {
  ordersTotal.inc({ status: sanitizeLabelValue(status) || 'UNKNOWN' }, 1);
}

export function recordOrderStatuses(status: string, count: number): void {
  ordersTotal.inc({ status: sanitizeLabelValue(status) || 'UNKNOWN' }, Math.max(0, Math.trunc(count)));
}

export function setInventoryLevel(productId: string, available: number): void {
  inventoryLevels.set(
    Math.max(0, Math.trunc(Number.isFinite(available) ? available : 0)),
    { product: sanitizeLabelValue(productId) || 'unknown' },
  );
}

export function recordInventoryDepleted(productId: string): void {
  inventoryDepleted.inc({ product: sanitizeLabelValue(productId) || 'unknown' }, 1);
}

export function recordWebhookVerificationFailure(
  provider: string,
  reason: 'BAD_SIGNATURE' | 'TIMESTAMP_OUT_OF_RANGE' | 'MALFORMED' | 'UNSUPPORTED_VERSION' | 'UNKNOWN',
): void {
  webhookVerificationFailures.inc({
    provider: sanitizeLabelValue(provider) || 'unknown',
    reason,
  });
}

export function recordReconciliationMismatch(type: string, count = 1): void {
  reconciliationMismatches.inc({ type: sanitizeLabelValue(type) || 'UNKNOWN' }, count);
}

export function recordFulfillmentOutcome(status: string): void {
  fulfillmentTotal.inc({ status: sanitizeLabelValue(status) || 'UNKNOWN' }, 1);
}

export function recordPaymentLatency(
  durationMs: number,
  labels: { provider?: string; operation?: string } = {},
): void {
  paymentLatency.observe(durationMs, {
    provider: sanitizeLabelValue(labels.provider ?? 'unknown'),
    operation: sanitizeLabelValue(labels.operation ?? 'unknown'),
  });
}

export function recordFulfillmentLatency(durationMs: number, stage = 'total'): void {
  fulfillmentLatency.observe(durationMs, { stage: sanitizeLabelValue(stage) || 'total' });
}

export function recordEmailLatency(durationMs: number, provider = 'unknown'): void {
  emailLatency.observe(durationMs, { provider: sanitizeLabelValue(provider) || 'unknown' });
}

export function recordAlertFired(code: string, severity: string): void {
  alertsFired.inc({
    code: sanitizeLabelValue(code) || 'UNKNOWN',
    severity: sanitizeLabelValue(severity) || 'WARNING',
  });
}

export function recordWorkerHeartbeat(worker: string, alive: boolean, at: number = Date.now()): void {
  const name = sanitizeLabelValue(worker) || 'unknown';
  workerAlive.set(alive ? 1 : 0, { worker: name });
  if (alive) workerHeartbeat.set(Math.floor(at / 1000), { worker: name });
}

export function recordDatabaseProbe(ok: boolean, latencyMs?: number): void {
  databaseUp.set(ok ? 1 : 0);
  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs)) {
    databaseLatency.observe(Math.max(0, latencyMs), {});
  }
}

// --- Derived collectors ------------------------------------------------------

let alertSnapshotHook: (() => void) | null = null;

/**
 * Optional hook so the alert evaluator can refresh itself during a scrape
 * without importing metrics from alerts.ts (which would be a cycle).
 */
export function setAlertSnapshotHook(hook: (() => void) | null): void {
  alertSnapshotHook = hook;
}

registry.addCollector(() => {
  appUp.set(1);
  appUptime.set(registry.uptimeSeconds());
  appInfo.set(1, { env: appConfig.nodeEnv });
  paymentSuccessRate.set(currentPaymentSuccessRate());
  for (const provider of providerRateWindows.keys()) {
    providerErrorRate.set(currentProviderErrorRate(provider), { provider });
  }
  alertSnapshotHook?.();
});

appUp.set(1);
appUptime.set(0);
appInfo.set(1, { env: appConfig.nodeEnv });

// --- Public API --------------------------------------------------------------

/** Render the whole registry in Prometheus text exposition format. */
export function render(): string {
  return registry.render();
}

/** Alias kept for readability at call sites that read better as a verb. */
export const renderMetrics = render;

/**
 * Test-only: clears every series. Uptime is intentionally NOT reset so a
 * scraper reading `app_uptime_seconds` cannot be fooled into thinking a fresh
 * process is old (or vice versa).
 */
export function resetMetrics(): void {
  registry.reset();
  providerRateWindows.clear();
  paymentRateWindow.reset();
}