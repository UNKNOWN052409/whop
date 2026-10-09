/**
 * Prometheus scrape endpoint.
 *
 * Unauthenticated metric endpoints are a real leak: they reveal revenue
 * volume, order counts and customer-visible failure rates to anyone who guesses
 * the path. This one is closed by default in the strongest way available:
 *
 *  - No METRICS_TOKEN configured -> 404, NOT 401. A 401 tells a prober that
 *    the endpoint exists and that auth would work; a 404 makes the deploy
 *    behave as though metrics were never built. Unconfigured = absent.
 *  - A configured token -> constant-time bearer comparison.
 *  - The response is always no-store, so an intermediary cache cannot hold
 *    operational telemetry.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { render } from '@/observability/metrics';
import { collectHeartbeatReport } from '@/observability/heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_STORE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Returns null when METRICS_TOKEN is unset — an absent endpoint, not an open one. */
function metricsToken(): string | null {
  const token = process.env.METRICS_TOKEN;
  return token && token.length > 0 ? token : null;
}

/**
 * Length-independent constant-time string comparison.
 *
 * Both sides are hashed to a fixed 32 bytes first: `timingSafeEqual` throws on
 * a length mismatch, and branching on length before comparing would leak the
 * token length through the response time.
 */
function constantTimeEquals(presented: string, expected: string): boolean {
  const presentedDigest = createHash('sha256').update(presented, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

export async function GET(request: Request): Promise<Response> {
  const expected = metricsToken();
  if (expected === null) {
    return new Response('Not Found', { status: 404, headers: NO_STORE_HEADERS });
  }

  // Header only. A query-string token would end up in access logs, proxy logs
  // and browser history — which is where most real credential leaks start.
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^bearer[ ]+(\S+)$/i.exec(authorization.trim());
  const presented = match?.[1] ?? '';

  if (presented.length === 0 || !constantTimeEquals(presented, expected)) {
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        ...NO_STORE_HEADERS,
        'WWW-Authenticate': 'Bearer realm="metrics"',
      },
    });
  }

  // Refresh the queue/worker gauges so `queue_depth` is a measurement taken at
  // scrape time rather than a process default of 0. Never fatal: metrics must
  // still render when the database is unreachable, and `database_up` is the
  // signal that says why.
  await collectHeartbeatReport();

  return new Response(render(), {
    status: 200,
    headers: { ...NO_STORE_HEADERS, 'Content-Type': PROMETHEUS_CONTENT_TYPE },
  });
}