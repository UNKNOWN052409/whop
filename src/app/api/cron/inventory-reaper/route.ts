import { runCronRoute } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import { releaseExpiredReservations } from '@/inventory/release';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Hourly inventory reservation reaper (spec sections 11 and 21).
 *
 * A reservation that is never delivered — because a worker crashed mid-flight,
 * or the email provider was down — would otherwise strand valuable codes in
 * RESERVED forever. This returns them to AVAILABLE once their lease expires.
 *
 * Safe to run concurrently on multiple instances: the release query is
 * conditional on reservationExpiresAt < now and each row update is atomic.
 */
export async function GET(request: Request) {
  return runCronRoute(request, async () => {
    const result = await releaseExpiredReservations();

    if (result.released > 0) {
      logger.warn('Inventory reaper released expired reservations', result as never);
    } else {
      logger.info('Inventory reaper completed', result as never);
    }

    return result as unknown as Record<string, unknown>;
  });
}