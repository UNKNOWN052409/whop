/**
 * POST /api/auth/logout — revoke the current session.
 *
 * Idempotent by design: signing out when nobody is signed in succeeds. A logout
 * that fails differently depending on whether a cookie was live turns the
 * endpoint into a "is this session still valid?" oracle.
 *
 * The database revocation is the control; clearing the cookie is hygiene. The
 * order is deliberate — revoke first, so a cookie that survives a client-side
 * failure is already dead server-side.
 */

import { assertCsrf } from '@/auth/csrf';
import { destroySession } from '@/auth/session';
import { logger } from '@/lib/logger';
import { jsonError, jsonOk } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    // Authenticated, so a full double-submit check applies. A cross-site page
    // must not be able to sign a user out.
    await assertCsrf(request);

    await destroySession();
    logger.info('Logout completed');

    return jsonOk({ ok: true });
  } catch (error) {
    return jsonError(error, 'Sign-out failed');
  }
}

/** GET is not a logout. Someone's link prefetcher must not end their session. */
export async function GET(): Promise<Response> {
  return Response.json(
    { error: 'Use POST', code: 'INVALID_INPUT' },
    { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } },
  );
}
