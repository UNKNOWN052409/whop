/**
 * Edge middleware: a fast gate in front of `/admin/*`.
 *
 * WHAT THIS DOES
 *   Verifies the session cookie's signature and reads the role / MFA claims out
 *   of it, then decides whether to let the request through. That is ALL it does.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   It does not touch the database. Middleware runs on every admin request at
 *   the edge, where opening a Postgres connection would add latency to every
 *   page load and exhaust the connection pool. It is therefore NOT the
 *   authority on "is this person still an admin": a role revoked thirty seconds
 *   ago is still honoured by this gate for the length of the token's window.
 *   Every admin page and route handler calls `requirePageSession` /
 *   `requireApiSession` from `src/app/admin/_lib/auth.ts`, which does the real
 *   database-backed check. If this file is deleted the panel is still closed —
 *   it is a fast lane, not the door.
 *
 * EDGE SAFETY
 *   Only `@/auth/config`, `@/auth/token` and `@/auth/roles` are imported. Those
 *   three use WebCrypto and nothing from `node:*`. Importing Prisma, bcrypt,
 *   pino or anything else here breaks the Edge bundle at build time.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { authConfig, sessionSigningAvailable } from '@/auth/config';
import { isStaff } from '@/auth/roles';
import { verifySessionToken } from '@/auth/token';

export const config = {
  matcher: ['/admin/:path*'],
};

/**
 * Admin responses carry operational data — customer emails, order references,
 * refund state. A cached copy in a shared proxy would be a data leak, so every
 * admin response is marked uncacheable, including the redirect itself.
 */
const NO_STORE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

/**
 * The admin sign-in page. Hard-coded rather than taken from config because the
 * middleware and `src/app/admin/_lib/auth.ts` must agree on exactly one URL.
 */
const LOGIN_PATH = '/admin/login';

/** Reachable without a session; everything else under /admin is gated. */
const PUBLIC_ADMIN_PATHS: ReadonlySet<string> = new Set([LOGIN_PATH]);

function withNoStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(name, value);
  return response;
}

/** API-ish admin paths get a JSON 401 rather than a redirect to an HTML page. */
function wantsJson(pathname: string): boolean {
  return pathname.startsWith('/admin/api/') || pathname.endsWith('/route');
}

function unauthorizedJson(reason: string): NextResponse {
  return withNoStore(
    NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED', reason },
      { status: 401, headers: { 'X-Redirect-By': 'middleware' } },
    ),
  );
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_ADMIN_PATHS.has(pathname)) {
    return withNoStore(NextResponse.next());
  }

  // An unconfigured SESSION_SECRET means every cookie is unverifiable. Treat
  // that exactly as "not signed in" — never as a pass.
  if (!sessionSigningAvailable()) {
    if (wantsJson(pathname)) return unauthorizedJson('auth_not_configured');
    const url = request.nextUrl.clone();
    url.pathname = LOGIN_PATH;
    url.search = '';
    url.searchParams.set('error', 'not_configured');
    return withNoStore(NextResponse.redirect(url, 307));
  }

  const token = request.cookies.get(authConfig.sessionCookieName)?.value;
  if (!token) {
    if (wantsJson(pathname)) return unauthorizedJson('no_session');
    return withNoStore(redirectToLogin(request));
  }

  const claims = await verifySessionToken(token);
  if (!claims) {
    if (wantsJson(pathname)) return unauthorizedJson('invalid_session');
    return withNoStore(redirectToLogin(request));
  }

  if (!isStaff(claims.role)) {
    if (wantsJson(pathname)) return unauthorizedJson('insufficient_role');
    // Deliberately the same destination as "not signed in": the login page must
    // not become a way to probe which addresses are admins.
    return withNoStore(redirectToLogin(request));
  }

  if (authConfig.requireMfaForAdmin && !claims.mfaVerified) {
    if (wantsJson(pathname)) return unauthorizedJson('mfa_required');
    const url = request.nextUrl.clone();
    url.pathname = LOGIN_PATH;
    url.search = '';
    url.searchParams.set(authConfig.mfaRequiredReason, '1');
    url.searchParams.set('next', `${pathname}${search}`);
    return withNoStore(NextResponse.redirect(url, 307));
  }

  // Downstream handlers may need to distinguish an edge-verified request from a
  // direct one; it is a hint, not a credential, and nothing authorises on it.
  const response = NextResponse.next();
  response.headers.set('X-Auth-Edge', 'verified');
  return withNoStore(response);
}

function redirectToLogin(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = LOGIN_PATH;
  url.search = '';
  // Only same-site, path-absolute targets: an open redirect on the login page
  // turns "you must sign in" into a convincing phishing link.
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  url.searchParams.set('next', next);
  return NextResponse.redirect(url, 307);
}
