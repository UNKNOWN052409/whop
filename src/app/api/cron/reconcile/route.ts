import { runCronRoute } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import { runReconciliation } from '@/reconcile/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Reconciliation pages through the provider API and compares every order in the
// window. Give it room; Vercel's default function timeout is far too short.
export const maxDuration = 300;

/**
 * Daily reconciliation (spec section 18).
 *
 * The window defaults to the last 72 hours rather than "since the last run".
 * Overlapping look-back is intentional: a fixed forward-only cursor silently
 * misses anything that arrived while a previous run was failing, which is
 * exactly when reconciliation matters most.
 */
export async function GET(request: Request) {
  return runCronRoute(request, async () => {
    const lookbackHours = Number(process.env.RECONCILIATION_LOOKBACK_HOURS ?? 72);
    const from = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
    const to = new Date();

    const result = await runReconciliation({ from, to });

    logger.info('Reconciliation run completed', {
      ...(result as unknown as Record<string, unknown>),
      windowFrom: from.toISOString(),
      windowTo: to.toISOString(),
    } as never);

    // A run that found discrepancies is still a successful run — the HTTP
    // status reports whether the JOB worked, not whether the data was clean.
    // The mismatch count is what alerting keys off.
    return result as unknown as Record<string, unknown>;
  });
}