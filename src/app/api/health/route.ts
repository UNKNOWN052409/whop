/**
 * Liveness: is this process alive and are its dependencies in a known state?
 * (Readiness lives in the sibling `/api/ready`.)
 *
 * This endpoint is the proof that "unconfigured" is a first-class, visible
 * state: an integration with no credentials reports `NOT_CONFIGURED`, in
 * production, forever, until someone configures it. Nothing here probes a
 * provider with a fake key, nothing substitutes a stub, and nothing reports a
 * green light for a service that cannot take a payment.
 *
 * SECRET SAFETY
 *
 * Only three-valued statuses cross this boundary — REAL, SANDBOX or
 * NOT_CONFIGURED — plus booleans about whether a key is present. Free text
 * that could contain a DSN or a driver message is passed through `redact.ts`
 * before it is serialised, because this response is exactly the thing an
 * operator pastes into a support ticket.
 */

import { appConfig, integrationStatus, isProduction, whopConfig } from '@/lib/env';
import {
  evaluateAlerts,
  recentAlerts,
} from '@/observability/alerts';
import { registry, paymentWindowCounts } from '@/observability/metrics';
import { safeDiagnostic } from '@/observability/redact';
import { collectHeartbeatReport } from '@/observability/heartbeat';
// The probe itself lives in `_lib/probe.ts` so that /api/ready measures
// exactly what this endpoint measures. What to DO with the measurement is the
// policy below and stays here.
import { jsonProbe, notConfiguredIntegrations, probeDatabase } from '../_lib/probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type OverallStatus = 'ok' | 'degraded' | 'down';

/**
 * Verbose detail is for local debugging and CI. In production it is ignored
 * entirely: alert context, worker holders and process ids are operational
 * reconnaissance, and a public ?verbose=1 must not turn the health endpoint
 * into a second (unauthenticated) admin surface.
 */
function wantsVerbose(request: Request): boolean {
  if (isProduction) return false;
  const value = new URL(request.url).searchParams.get('verbose');
  return value === '1' || value === 'true';
}

export async function GET(request: Request): Promise<Response> {
  const integrations = integrationStatus();

  const database = await probeDatabase();

  const heartbeat = await collectHeartbeatReport();

  const notConfigured = notConfiguredIntegrations(integrations);

  // down      -> the process cannot serve a payment at all (no database).
  // degraded  -> serving, but something required is not configured.
  // ok        -> database reachable and every declared integration configured.
  let status: OverallStatus = 'ok';
  if (!database.ok) status = 'down';
  else if (notConfigured.length > 0) status = 'degraded';

  const body: Record<string, unknown> = {
    status,
    timestamp: new Date().toISOString(),
    version: {
      env: appConfig.nodeEnv,
      uptimeSeconds: registry.uptimeSeconds(),
    },
    integrations: {
      payments: integrations.payments,
      email: integrations.email,
      redis: integrations.redis,
      queue: integrations.queue,
      encryption: integrations.encryption,
      paymentMethods: integrations.paymentMethods,
    },
    notConfigured,
    database: {
      ok: database.ok,
      ...(database.latencyMs === undefined ? {} : { latencyMs: database.latencyMs }),
      // Redacted: a Prisma driver message can echo the connection string.
      ...(database.error === undefined ? {} : { error: safeDiagnostic(database.error) }),
    },
    queue: {
      ok: heartbeat.queue.ok,
      depth: heartbeat.queue.depth,
      pending: heartbeat.queue.pending,
      running: heartbeat.queue.running,
      oldestPendingAgeSeconds: heartbeat.queue.oldestPendingAgeSeconds,
      ...(heartbeat.queue.error === undefined
        ? {}
        : { error: safeDiagnostic(heartbeat.queue.error) }),
    },
    workers: heartbeat.workers.map((worker) => ({
      name: worker.name,
      held: worker.held,
      acquiredAt: worker.acquiredAt,
      expiresAt: worker.expiresAt,
      expiresInSeconds: worker.expiresInSeconds,
    })),
  };

  if (wantsVerbose(request)) {
    // `force` bypasses the once-a-minute evaluation throttle: an operator who
    // explicitly asked for detail wants current truth, not a cached verdict.
    const fired = evaluateAlerts({ force: true });
    body.verbose = {
      alertsFiredNow: fired.map((alert) => ({
        id: alert.id,
        code: alert.code,
        severity: alert.severity,
        message: alert.message,
        firedAt: alert.firedAt,
      })),
      recentAlerts: recentAlerts(10),
      payments: paymentWindowCounts(),
      provider: {
        kind: whopConfig.kind,
        // Booleans only. No key, no account id, no base URL with credentials.
        apiKeyConfigured: Boolean(whopConfig.apiKey),
        webhookSecretConfigured: Boolean(whopConfig.webhookSecret),
        accountConfigured: Boolean(whopConfig.accountId),
        apiVersionDate: whopConfig.apiVersionDate,
      },
      process: {
        pid: process.pid,
        nodeEnv: appConfig.nodeEnv,
        appUrl: appConfig.url,
      },
    };
  }

  // `degraded` stays 200 on purpose: the process is serving, and a load
  // balancer that restarts it would not fix a missing environment variable.
  // `down` is 503 because there genuinely is no database.
  return jsonProbe(body, status === 'down' ? 503 : 200);
}