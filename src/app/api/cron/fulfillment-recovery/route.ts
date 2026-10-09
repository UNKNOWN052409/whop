import { runCronRoute } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import { recoverStalledJobs } from '@/fulfillment/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Fulfillment crash recovery (spec section 21).
 *
 * A worker that dies between reserving a code and sending the email leaves the
 * order paid but unfinished. This sweeps for FulfillmentJob rows that are
 * non-terminal and stale, and re-runs them.
 *
 * Runs every 5 minutes because the cost of being wrong is asymmetric: an
 * extra no-op sweep is a few queries, while a customer waiting 20 minutes for
 * an email they already paid for is a support ticket and often a chargeback.
 */
export async function GET(request: Request) {
  return runCronRoute(request, async () => {
    const result = await recoverStalledJobs();

    if (result.recovered > 0) {
      logger.warn('Fulfillment recovery re-ran stalled jobs', result as never);
    }

    return result as unknown as Record<string, unknown>;
  });
}