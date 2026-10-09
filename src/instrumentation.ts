/**
 * Next.js instrumentation — runs exactly once when the server process starts.
 *
 * Everything expensive, global and fatal belongs here rather than in a route:
 *
 *  - `assertProductionConfig()` makes a half-configured production deploy fail
 *    at BOOT, not at the first customer's payment. A missing ENCRYPTION_KEY is
 *    a deploy-time error; discovering it while someone waits for a redeem code
 *    is an outage.
 *  - The alert evaluator is wired in so a metrics scrape refreshes operational
 *    thresholds without an interval turning into a log flood.
 *
 * WHAT DELIBERATELY DOES NOT HAPPEN HERE
 * --------------------------------------
 * The Inngest serve handler is NOT registered from this file.
 *
 * Next compiles `instrumentation.ts` for the Edge runtime as well as Node, and
 * webpack follows every import reachable from it. The durable-workflow graph
 * (@/inngest -> fulfillment -> email -> nodemailer) pulls in Node-only builtins
 * (`crypto`, `tls`, `net`, `node:module`) that the Edge compiler cannot
 * resolve, which fails the ENTIRE production build with "Module not found:
 * Can't resolve 'crypto'".
 *
 * A runtime guard does not help — the bundler resolves modules at build time,
 * before any guard runs. The serve handler therefore lives in
 * src/app/api/inngest/route.ts, which is Node-only and is where Inngest
 * actually calls. A malformed function graph still fails loudly, just at
 * route-module load rather than at boot.
 *
 * IF YOU ever need to reference server-only modules from here, check
 * `process.env.NEXT_RUNTIME === 'nodejs'` AND confirm the import does not
 * transitively pull a Node-only package.
 */

import { assertProductionConfig } from '@/lib/env';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

export async function register(): Promise<void> {
  // The edge runtime cannot load Prisma. Failing here would break the build for
  // no benefit, since no edge route uses this file.
  if (process.env.NEXT_RUNTIME !== undefined && process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Fail fast. Throws with the list of missing variables; a boot failure here
  // is strictly better than a silent failure at the first checkout.
  assertProductionConfig();

  // Lazily imported: alerts.ts reaches Prisma for persistence, and instrument
  // must not pull the database graph into the bundler's entry chunk.
  const { initAlerts } = await import('@/observability/alerts');
  initAlerts();

  logger.info('Instrumentation registered', {
    paymentsConfigured: Boolean(process.env.WHOP_API_KEY && process.env.WHOP_WEBHOOK_SECRET),
    durableQueueConfigured: Boolean(process.env.INNGEST_EVENT_KEY),
  });
}