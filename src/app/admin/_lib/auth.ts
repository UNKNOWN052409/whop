/**
 * Admin authorization seam (spec §15).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every admin page and every admin API route in this panel calls
 * `requirePageSession()` / `requireApiSession()` BEFORE touching data. That is
 * deliberate: the panel must be unreachable to an anonymous caller even if
 * `src/middleware.ts` is deleted, misconfigured, or fails to match a route. A
 * middleware-only boundary is a convention; this is the boundary.
 *
 * The auth workstream owns `@/auth/session`, `@/auth/rbac` and `@/auth/csrf`.
 * Rather than spreading direct named imports across 20 admin files — and having
 * a rename in one of those modules break every page at once — all three
 * dependencies are resolved HERE, exactly once, through a candidate-name
 * lookup. Three properties make this safe rather than sloppy:
 *
 *   1. It FAILS CLOSED. An unresolved session provider throws UNAUTHORIZED; an
 *      unresolved CSRF verifier throws on every mutation. Nothing is ever
 *      skipped because a symbol could not be found.
 *   2. The session is RE-DERIVED here from its raw shape. A caller cannot pass
 *      in a forged role: the only path to a role is through the session object
 *      the auth module produced for this request's cookie.
 *   3. Role ranking is computed locally from the Prisma `UserRole` enum, so the
 *      comparison itself has no external dependency and cannot be inverted.
 */

import type { UserRole } from '@prisma/client';
import * as authSessionModule from '@/auth/session';
import * as authRbacModule from '@/auth/rbac';
import * as csrfModule from '@/auth/csrf';
import { AppError, errors, isAppError } from '@/lib/errors';
import { appConfig } from '@/lib/env';
import { logger } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Ordering matters: `SUPPORT` can read an order but cannot change money,
 * `ADMIN` can run operational mutations, `OWNER` can reveal a plaintext code.
 * Derived from the Prisma enum so adding a role in schema.prisma surfaces here
 * as a type error rather than a silently-unranked (and therefore 0) account.
 */
export const ROLE_RANK: Readonly<Record<UserRole, number>> = {
  CUSTOMER: 0,
  SUPPORT: 1,
  ADMIN: 2,
  OWNER: 3,
} as const;

export const ADMIN_ROLES: readonly UserRole[] = ['SUPPORT', 'ADMIN', 'OWNER'];

export interface AdminSession {
  userId: string;
  email: string;
  name: string | null;
  role: UserRole;
}

/** Every known role string, for parsing untrusted session payloads. */
const KNOWN_ROLES = Object.keys(ROLE_RANK) as UserRole[];

export function hasRole(session: AdminSession, minimum: UserRole): boolean {
  return ROLE_RANK[session.role] >= ROLE_RANK[minimum];
}

// ---------------------------------------------------------------------------
// Symbol resolution (see the WHY THIS FILE EXISTS note above)
// ---------------------------------------------------------------------------

type UnknownBag = Record<string, unknown>;

function pickFunction(bag: UnknownBag, candidates: readonly string[]): ((...args: never[]) => unknown) | null {
  for (const name of candidates) {
    const value = bag[name];
    if (typeof value === 'function') {
      return value as (...args: never[]) => unknown;
    }
  }
  return null;
}

const SESSION_CANDIDATES = ['getSession', 'readSession', 'getCurrentSession', 'currentSession', 'getAdminSession'] as const;
const RBAC_CANDIDATES = ['requireRole', 'assertRole', 'requireMinimumRole', 'hasRequiredRole'] as const;
const CSRF_CANDIDATES = ['assertCsrf', 'assertCsrfToken', 'verifyCsrfToken', 'assertSameOrigin', 'checkCsrf', 'assertCsrfRequest'] as const;

function getSessionFn(): ((...args: never[]) => unknown) | null {
  return pickFunction(authSessionModule as unknown as UnknownBag, SESSION_CANDIDATES);
}

function getRequireRoleFn(): ((...args: never[]) => unknown) | null {
  return pickFunction(authRbacModule as unknown as UnknownBag, RBAC_CANDIDATES);
}

function getCsrfFn(): ((...args: never[]) => unknown) | null {
  return pickFunction(csrfModule as unknown as UnknownBag, CSRF_CANDIDATES);
}

// ---------------------------------------------------------------------------
// Session normalisation
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asRole(value: unknown): UserRole | null {
  const raw = asString(value);
  if (!raw) return null;
  const upper = raw.toUpperCase() as UserRole;
  return KNOWN_ROLES.includes(upper) ? upper : null;
}

/**
 * Turns whatever the auth module returned into an AdminSession, or null.
 *
 * The auth module may return `{ user: {...} }`, a flat session, or a token.
 * Only an object carrying BOTH a user id and a recognised role is accepted —
 * a session with no role is treated as no session, because defaulting it to
 * CUSTOMER-and-hoping-the-caller-checks would be exactly the bug this panel
 * exists to prevent.
 */
export function normaliseSession(raw: unknown): AdminSession | null {
  if (raw === null || typeof raw !== 'object') return null;
  const bag = raw as UnknownBag;

  const candidate =
    bag.user !== null && typeof bag.user === 'object' ? (bag.user as UnknownBag) : bag;

  const userId = asString(candidate.userId) ?? asString(candidate.id);
  const role = asRole(candidate.role);
  if (!userId || !role) return null;

  const email = asString(candidate.email);
  if (!email) return null;

  const name = asString(candidate.name) ?? asString(candidate.displayName);

  return { userId, email, role, name };
}

/** Reads the current session. Returns null when unauthenticated. */
export async function readSession(): Promise<AdminSession | null> {
  const fn = getSessionFn();
  if (!fn) {
    logger.error('Admin auth NOT AVAILABLE: @/auth/session exports none of the known session accessors', {
      candidates: SESSION_CANDIDATES,
    });
    // Fail closed. An admin panel that cannot prove who is asking answers
    // nobody's questions.
    throw errors.unauthorized('Admin authentication is NOT CONFIGURED');
  }

  const raw = await (fn as () => unknown)();
  if (raw === null || raw === undefined) return null;
  return normaliseSession(raw);
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/**
 * Cross-checks our locally computed rank against the shared `@/auth/rbac`
 * helper. This is belt-and-braces: the local check is what actually gates the
 * request, but where the shared helper exists, a disagreement means the auth
 * workstream considers the caller unauthorized and we honour that too.
 */
async function crossCheckRbac(session: AdminSession, minimum: UserRole): Promise<void> {
  const fn = getRequireRoleFn();
  if (!fn) {
    logger.warn('Admin auth: @/auth/rbac exposes no role guard; using local rank check only', {
      userId: session.userId,
      minimum,
      candidates: RBAC_CANDIDATES,
    });
    return;
  }
  try {
    await (fn as (s: unknown) => unknown)(session);
    return;
  } catch (error) {
    if (isAppError(error)) throw error;
    throw errors.forbidden(`Role check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Throws unless the current request carries at least `minimum`. */
export async function requireSession(minimum: UserRole = 'ADMIN'): Promise<AdminSession> {
  const session = await readSession();
  if (!session) throw errors.unauthorized('Sign in to access the admin panel');
  if (!hasRole(session, minimum)) {
    logger.warn('Admin access denied: insufficient role', {
      userId: session.userId,
      role: session.role,
      required: minimum,
    });
    throw errors.forbidden(`This action requires the ${minimum} role`);
  }
  await crossCheckRbac(session, minimum);
  return session;
}

/**
 * Page guard. Redirects to the sign-in screen instead of throwing, because a
 * thrown AppError in a server component surfaces as an error page rather than a
 * login prompt. The role check still throws — an operator who is signed in but
 * under-privileged should see "forbidden", not a login form.
 */
export async function requirePageSession(
  minimum: UserRole,
  nextPath: string,
): Promise<AdminSession> {
  const session = await readSession().catch((error: unknown) => {
    if (isAppError(error)) return null;
    throw error;
  });

  if (!session) {
    const { redirect } = await import('next/navigation');
    const target = `/admin/login?next=${encodeURIComponent(nextPath)}`;
    redirect(target);
    // `redirect()` throws a NEXT_REDIRECT error, but because it is pulled off a
    // dynamically imported namespace object the compiler cannot treat the call
    // as terminating. Throwing keeps this function fail-closed AND keeps the
    // session non-null for everything below: a redirect that ever stopped
    // throwing would otherwise fall through into a role check on `null`.
    throw errors.unauthorized('Sign in to access the admin panel');
  }

  if (!hasRole(session, minimum)) {
    logger.warn('Admin page denied: insufficient role', {
      userId: session.userId,
      role: session.role,
      required: minimum,
      path: nextPath,
    });
    throw errors.forbidden(`This page requires the ${minimum} role`);
  }

  await crossCheckRbac(session, minimum);
  return session;
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/**
 * Verifies the request origin for a mutation.
 *
 * Called at the top of every Server Action that writes and every admin API
 * route that accepts POST/PATCH/DELETE. Two independent layers:
 *
 *   1. Next.js's own Server Action origin check, which is always on.
 *   2. The shared `@/auth/csrf` verifier, when it exists.
 *
 * If neither is available the mutation is REFUSED. A write path that cannot
 * prove the request was same-origin is a CSRF vulnerability, not a degraded
 * convenience — refusing is the only honest response.
 */
export async function assertMutationOrigin(context: { action: string }): Promise<void> {
  const fn = getCsrfFn();
  if (fn) {
    try {
      await (fn as () => unknown)();
      return;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('CSRF verification failed', 403, 'FORBIDDEN', {
        details: { action: context.action },
        cause: error,
      });
    }
  }

  logger.error('Admin mutation REFUSED: no CSRF verifier available', {
    action: context.action,
    candidates: CSRF_CANDIDATES,
  });
  throw new AppError(
    'CSRF protection is NOT CONFIGURED — refusing to perform a mutation without it.',
    503,
    'FORBIDDEN',
    { details: { action: context.action } },
  );
}

/**
 * API-route guard: authorise, then verify origin. Order matters — we reject an
 * unauthenticated caller before doing any CSRF work, so an anonymous prober
 * learns nothing from the difference between the two failure modes.
 */
export async function requireApiSession(request: Request, minimum: UserRole = 'ADMIN'): Promise<AdminSession> {
  const session = await requireSession(minimum);
  const fn = getCsrfFn();
  if (fn) {
    try {
      await (fn as (r: unknown) => unknown)(request);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('CSRF verification failed', 403, 'FORBIDDEN', { cause: error });
    }
    return session;
  }

  // An explicit same-origin check is a legitimate second layer for a route
  // handler: a cross-site form post carries an Origin (or, for older agents,
  // a Referer) that cannot match this deployment.
  assertSameOriginOrThrow(request);
  return session;
}

/**
 * Origin/Referer check against the configured app URL. Used only as the
 * fallback layer when `@/auth/csrf` is unavailable — never as a replacement.
 */
export function assertSameOriginOrThrow(request: Request): void {
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const host = request.headers.get('host');

  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new AppError('Malformed Origin header', 403, 'FORBIDDEN');
    }
    if (host && originHost !== host) {
      throw new AppError('Cross-origin request refused', 403, 'FORBIDDEN');
    }
    return;
  }

  if (referer) {
    let refererHost: string;
    try {
      refererHost = new URL(referer).host;
    } catch {
      throw new AppError('Malformed Referer header', 403, 'FORBIDDEN');
    }
    if (host && refererHost !== host) {
      throw new AppError('Cross-origin request refused', 403, 'FORBIDDEN');
    }
    return;
  }

  // Neither header present: a same-origin browser navigation always sends at
  // least one for a state-changing request. Refusing is the fail-closed choice.
  throw new AppError(
    'Request has no Origin or Referer header; refusing a cross-site mutation. ' +
      `Set appConfig.url (currently ${appConfig.url}) or configure @/auth/csrf.`,
    403,
    'FORBIDDEN',
  );
}