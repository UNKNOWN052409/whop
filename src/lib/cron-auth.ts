import { timingSafeEqual } from 'node:crypto';
import { errors } from './errors';

/**
 * Vercel Cron authentication (spec section 23).
 *
 * Vercel sends the secret as the Authorization header verbatim, e.g.
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Two deliberate behaviours:
 *
 *  - If CRON_SECRET is unset the route returns 404, not 401. A deployed cron
 *    route with no secret is an unauthenticated endpoint that can trigger
 *    refunds and reconciliation runs, so it must not merely "fail closed" —
 *    it must not exist to an attacker. 404 also stops Vercel retry noise.
 *
 *  - The comparison is constant-time. A timing-oracle on a cron secret is a
 *    real, if low-severity, issue and costs nothing to avoid.
 */
export function assertCronAuthorized(request: Request): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    throw new CronNotConfiguredError();
  }

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing cron authorization');
  }

  const provided = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(secret, 'utf8');

  const matches =
    provided.length === expected.length && timingSafeEqual(provided, expected);

  if (!matches) throw errors.unauthorized('Invalid cron authorization');
}

/** Distinguishes "not configured" from "not authorized" so the route can 404. */
export class CronNotConfiguredError extends Error {
  constructor() {
    super('CRON_SECRET is not set; this cron route is disabled.');
    this.name = 'CronNotConfiguredError';
  }
}

export function isCronNotConfigured(error: unknown): boolean {
  return error instanceof CronNotConfiguredError;
}

/**
 * Wraps a cron handler with auth, timing, and uniform error shaping.
 *
 * Cron endpoints are long-running and provider-backed, so the response carries
 * a durationMs field — a reconciliation run that suddenly takes 40s is the
 * early signal that something is wrong upstream.
 */
export async function runCronRoute(
  request: Request,
  handler: () => Promise<Record<string, unknown>>,
): Promise<Response> {
  const started = Date.now();

  try {
    assertCronAuthorized(request);
  } catch (error) {
    if (isCronNotConfigured(error)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await handler();
    return Response.json(
      { ok: true, durationMs: Date.now() - started, ...result },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    // A 500 makes Vercel surface the failure and retry, which is correct: a
    // failed reaper or reconciliation run is not a success.
    return Response.json(
      {
        ok: false,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}