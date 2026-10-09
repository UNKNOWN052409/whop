/**
 * Structured logging (spec §22).
 *
 * Emits one JSON object per line so Vercel/Datadog/Honeycomb can parse it
 * without a transport agent. Every record carries an orderId or correlation id
 * when one exists — a log line that can't be tied to an order is close to
 * useless during a payment incident.
 */

import { appConfig } from './env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MIN_LEVEL: Level =
  (process.env.LOG_LEVEL as Level) ?? (appConfig.isProduction ? 'info' : 'debug');

/** Keys whose values must never reach a log sink. */
const REDACT_KEYS = new Set([
  'code',
  'codeciphertext',
  'redeemcode',
  'password',
  'passwordhash',
  'token',
  'apikey',
  'api_key',
  'secret',
  'webhooksecret',
  'authorization',
  'cookie',
  'cvv',
  'cvc',
  'pan',
  'cardnumber',
  'mfasecret',
  'totpsecret',
  'mfasecretciphertext',
  'privatekey',
]);

const MAX_DEPTH = 6;

function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface LogContext {
  orderId?: string;
  paymentId?: string;
  productId?: string;
  eventId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

function emit(level: Level, message: string, context?: LogContext) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;

  const record: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    msg: message,
    service: 'redeem-store',
    env: appConfig.nodeEnv,
  };

  // Promote known correlation fields to the top level for log search.
  if (context?.orderId) record.orderId = context.orderId;
  if (context?.paymentId) record.paymentId = context.paymentId;
  if (context?.eventId) record.eventId = context.eventId;

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context ?? {})) {
    if (k === 'orderId' || k === 'paymentId' || k === 'eventId') continue;
    rest[k] = v;
  }
  if (Object.keys(rest).length > 0) record.ctx = redact(rest);

  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, context?: LogContext) => emit('debug', message, context),
  info: (message: string, context?: LogContext) => emit('info', message, context),
  warn: (message: string, context?: LogContext) => emit('warn', message, context),
  error: (message: string, context?: LogContext) => emit('error', message, context),

  /** Returns a logger that merges the given context into every subsequent line. */
  child(base: LogContext) {
    return {
      debug: (m: string, c?: LogContext) => emit('debug', m, { ...base, ...c }),
      info: (m: string, c?: LogContext) => emit('info', m, { ...base, ...c }),
      warn: (m: string, c?: LogContext) => emit('warn', m, { ...base, ...c }),
      error: (m: string, c?: LogContext) => emit('error', m, { ...base, ...c }),
      child: (extra: LogContext) => logger.child({ ...base, ...extra }),
    };
  },
};

/**
 * Measures an async operation, logging duration on completion. Payment and
 * fulfillment latency are required metrics (spec §22).
 */
export async function timed<T>(
  operation: string,
  fn: () => Promise<T>,
  context?: LogContext,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - started;
    logger.info(`${operation} completed`, { ...context, durationMs, ok: true });
    return result;
  } catch (error) {
    const durationMs = Date.now() - started;
    logger.error(`${operation} failed`, {
      ...context,
      durationMs,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}