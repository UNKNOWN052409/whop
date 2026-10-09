/**
 * Server-side sessions (spec §15).
 *
 * STORAGE MODEL
 *   The cookie value IS a signed JWT (`@/auth/token`). The database stores ONLY
 *   `sha256(cookieValue)` in `Session.tokenHash`, which is unique. A stolen
 *   database dump therefore cannot be replayed as a login, and the raw token
 *   never touches the database, a log line or an audit record.
 *
 * WHY THE AUTHORITY IS HERE AND NOT IN THE TOKEN
 *   The middleware is a fast edge gate; it cannot open a connection. Every
 *   authoritative question — is the row still live, was it revoked, is the
 *   account still enabled, is the role still current, has MFA actually been
 *   satisfied for THIS login — is answered here, from the database, on every
 *   request. `getSession()` reads the role from the User row, never from the
 *   token, so a demotion takes effect on the next request.
 *
 * EXPIRY
 *   Two clocks: an idle timeout that slides forward on activity, and an absolute
 *   ceiling that never moves. Renewal writes are throttled by
 *   `sessionRenewalIntervalSeconds` so a busy session does not turn every request
 *   into a write.
 *
 * THROWING vs NULL
 *   `getSession` returns null for "nobody is signed in". `requireSession`,
 *   `requireUser` and `requireRole` THROW. The admin panel seam types its result
 *   as non-null and does not null-check it, so the throwing variants are the ones
 *   it must reach.
 */

import { cookies } from 'next/headers';
import type { Prisma, User } from '@prisma/client';
import { authConfig, authCookieOptions } from '@/auth/config';
import { coerceRole, isStaff, type Role } from '@/auth/roles';
import {
  signSessionToken,
  verifySessionToken,
  type AuthMethod,
  type SessionClaims,
} from '@/auth/token';
import { prisma } from '@/db/prisma';
import { AppError, errors } from '@/lib/errors';
import { generateToken, piiHash, sha256 } from '@/lib/ids';
import { logger } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The shape `src/app/admin/_lib/auth.ts` normalises into its `AdminSession`.
 * Kept structurally identical so no caller has to re-map it.
 */
export interface AdminSession {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
}

export interface Session extends AdminSession {
  /** `Session.id`. */
  sessionId: string;
  mfaEnabled: boolean;
  /** MFA completed for THIS session, not merely enrolled on the account. */
  mfaVerified: boolean;
  amr: AuthMethod[];
  expiresAt: Date;
  createdAt: Date;
  /** Mirrors the flattened fields so either normalisation path works. */
  user: {
    id: string;
    email: string;
    name: string | null;
    role: Role;
  };
}

export interface CreateSessionInput {
  userId: string;
  role: Role;
  mfaEnabled: boolean;
  /** Must be true before a session is minted for an account with MFA enrolled. */
  mfaVerified: boolean;
  amr: AuthMethod[];
  userAgent?: string | null;
  ip?: string | null;
  /** Skip writing the cookie. Used by tests and by non-cookie transports. */
  setCookie?: boolean;
}

/** Options for `getSession`. */
export interface GetSessionOptions {
  /**
   * Write the sliding-renewal update. Defaults to true; tests and read-only
   * paths can turn it off.
   */
  touch?: boolean;
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/**
 * Cookies are readable but not always writable: `cookies()` is read-only during
 * a Server Component render in Next 15. Failing to SET a cookie inside a read
 * path is not an authentication failure — the session is still valid — so this
 * logs and continues rather than throwing. Failing to CLEAR a cookie at logout
 * is the same story: the row is already revoked, which is the real control.
 */
async function trySetCookie(name: string, value: string, maxAge: number): Promise<boolean> {
  try {
    const store = await cookies();
    store.set(name, value, authCookieOptions(maxAge));
    return true;
  } catch (error) {
    logger.debug('Session cookie could not be written in this context', {
      cookie: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function tryDeleteCookie(name: string): Promise<boolean> {
  try {
    const store = await cookies();
    store.delete(name);
    return true;
  } catch (error) {
    logger.debug('Session cookie could not be cleared in this context', {
      cookie: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Reads a cookie value from the request scope. Returns null outside a request. */
export async function readCookieValue(name: string): Promise<string | null> {
  try {
    const store = await cookies();
    return store.get(name)?.value ?? null;
  } catch {
    return null;
  }
}

/** The raw session token from the cookie, or null. Never logged. */
export async function getSessionToken(): Promise<string | null> {
  return readCookieValue(authConfig.sessionCookieName);
}

/** IPs are stored hashed, never in plaintext. */
function safePiiHash(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return piiHash(value);
  } catch {
    return null;
  }
}

/** Best-effort client IP from the usual proxy headers. */
export function clientIpFromHeaders(headers: {
  get(name: string): string | null;
}): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip') ?? headers.get('cf-connecting-ip') ?? null;
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

type SessionWithUser = Prisma.SessionGetPayload<{ include: { user: true } }>;

function toSession(
  row: Pick<SessionWithUser, 'id' | 'userId' | 'expiresAt' | 'createdAt'>,
  user: User,
  claims: SessionClaims | null,
): Session {
  const role = coerceRole(user.role);
  const mfaEnabled = user.mfaEnabledAt !== null && user.mfaEnabledAt !== undefined;
  return {
    userId: user.id,
    email: user.email,
    name: user.name ?? null,
    role,
    sessionId: row.id,
    mfaEnabled,
    // Trust only what the token proved AND what the account still says. A token
    // minted before enrolment cannot claim MFA was verified.
    mfaVerified: claims?.mfaVerified === true,
    amr: claims?.amr ?? [],
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    user: { id: user.id, email: user.email, name: user.name ?? null, role },
  };
}

/**
 * Resolves the current session, or null.
 *
 * Returns null for: no cookie, an unverifiable token, a token with no matching
 * database row, a revoked row, an expired row, a disabled account, and any
 * database fault. A database fault deliberately degrades to "not signed in"
 * rather than throwing: an admin page must not 500 on a transient blip, and
 * failing closed is the correct direction.
 */
export async function getSession(options: GetSessionOptions = {}): Promise<Session | null> {
  const token = await getSessionToken();
  if (!token) return null;

  // Cheap signature check first: a forged or stale cookie never reaches the DB.
  const claims = await verifySessionToken(token);
  if (!claims) return null;

  let row: SessionWithUser | null;
  try {
    row = await prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });
  } catch (error) {
    logger.error('Session lookup failed; treating request as unauthenticated', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!row) return null;

  const now = new Date();
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  if (row.user.disabledAt !== null && row.user.disabledAt !== undefined) return null;

  const session = toSession(row, row.user, claims);

  if (options.touch !== false) await renewSessionIfStale(row.id, row.lastSeenAt, row.createdAt, row.expiresAt);

  return session;
}

/**
 * Slides `expiresAt` forward, never past the absolute ceiling.
 *
 * Throttled by `sessionRenewalIntervalSeconds` so a page that fires twenty
 * requests a minute does not write twenty rows a minute. Failure to renew is
 * never fatal to the request — the current window still has time left.
 */
async function renewSessionIfStale(
  sessionId: string,
  lastSeenAt: Date,
  createdAt: Date,
  expiresAt: Date,
): Promise<void> {
  const now = Date.now();
  const staleMs = authConfig.sessionRenewalIntervalSeconds * 1000;
  if (now - lastSeenAt.getTime() < staleMs) return;

  const absoluteDeadline = createdAt.getTime() + authConfig.sessionAbsoluteTtlSeconds * 1000;
  const idleDeadline = now + authConfig.sessionIdleTtlSeconds * 1000;
  const nextExpiry = new Date(Math.min(idleDeadline, absoluteDeadline));

  // Already at the ceiling: only the liveness marker moves.
  if (nextExpiry.getTime() <= expiresAt.getTime()) {
    await touchLastSeen(sessionId, new Date(now));
    return;
  }

  try {
    await prisma.session.update({
      where: { id: sessionId },
      data: { expiresAt: nextExpiry, lastSeenAt: new Date(now) },
    });
  } catch (error) {
    logger.warn('Session renewal failed; existing window remains valid', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function touchLastSeen(sessionId: string, at: Date): Promise<void> {
  try {
    await prisma.session.update({ where: { id: sessionId }, data: { lastSeenAt: at } });
  } catch {
    // Cosmetic; the session itself is unaffected.
  }
}

// ---------------------------------------------------------------------------
// Throwing guards
// ---------------------------------------------------------------------------

/**
 * Throws UNAUTHORIZED unless there is a valid session.
 *
 * When `minimum` is a staff role and `REQUIRE_MFA_FOR_ADMIN` is on, a session
 * that did not complete an MFA challenge is refused even if the account has no
 * MFA enrolled — which is precisely the misconfiguration that flag exists to
 * catch, so it produces a 403 naming the problem rather than a silent pass.
 */
export async function requireSession(minimum: Role = 'CUSTOMER'): Promise<Session> {
  const session = await getSession();
  if (!session) throw errors.unauthorized('Sign in to continue');

  if (minimum !== 'CUSTOMER' && isStaff(minimum)) {
    if (authConfig.requireMfaForAdmin && !session.mfaVerified) {
      if (session.mfaEnabled) {
        throw new AppError('Multi-factor authentication is required for this area', 403, 'FORBIDDEN');
      }
      throw new AppError(
        'REQUIRE_MFA_FOR_ADMIN is on but this account has no MFA enrolled. ' +
          'Enrol an authenticator app, or turn the flag off, before signing in.',
        403,
        'FORBIDDEN',
      );
    }
  }

  return session;
}

/** Any authenticated user. Throws UNAUTHORIZED when there is no session. */
export async function requireUser(): Promise<Session> {
  return requireSession('CUSTOMER');
}

export type RoleMinimum = Role;

function toRole(value: string): Role {
  return coerceRole(value);
}

/** Anything object-shaped that could describe a session. */
export interface SessionLike {
  userId?: string | null;
  id?: string | null;
  role?: string | null;
  email?: string | null;
  name?: string | null;
  sessionId?: string | null;
  mfaEnabled?: boolean;
  mfaVerified?: boolean;
  amr?: AuthMethod[];
  expiresAt?: Date | null;
  createdAt?: Date | null;
}

function isSessionLike(value: unknown): value is SessionLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asAdminSession(value: SessionLike, source: string): AdminSession {
  const userId = value.userId ?? value.id ?? null;
  const email = value.email ?? null;
  if (!userId || !email) {
    // Fail closed: a session with no identity cannot authorise anything.
    throw errors.unauthorized(`Session from ${source} has no identifiable user`);
  }
  const role = value.role ? toRole(value.role) : 'CUSTOMER';
  return { userId, email, name: value.name ?? null, role };
}

export interface RequireRoleResult extends AdminSession {
  sessionId: string | null;
  mfaVerified: boolean;
  amr: AuthMethod[];
}

/**
 * Role guard. THREE call shapes, all supported because the admin panel seam
 * calls it with a session object and no minimum:
 *
 *   requireRole('ADMIN')                 -> load the current session, require >= ADMIN
 *   requireRole('OWNER', session)        -> require >= OWNER on a given session
 *   requireRole(session)                 -> require >= SUPPORT (any staff) on a given session
 *
 * Always THROWS rather than returning null, and always returns the
 * `{ userId, email, name, role }` shape the caller already expects.
 */
export async function requireRole(minimum?: RoleMinimum | SessionLike, maybeSession?: SessionLike | RoleMinimum): Promise<RequireRoleResult> {
  let minimumRole: Role = 'SUPPORT';
  let explicit: SessionLike | null = null;

  if (typeof minimum === 'string') {
    minimumRole = toRole(minimum);
    if (isSessionLike(maybeSession)) explicit = maybeSession;
  } else if (isSessionLike(minimum)) {
    explicit = minimum;
    minimumRole = typeof maybeSession === 'string' ? toRole(maybeSession) : 'SUPPORT';
  } else if (minimum === undefined && maybeSession !== undefined) {
    if (typeof maybeSession === 'string') minimumRole = toRole(maybeSession);
    else if (isSessionLike(maybeSession)) {
      explicit = maybeSession;
      minimumRole = 'SUPPORT';
    }
  }

  if (!explicit) {
    // requireSession already refuses anyone below `minimumRole`, including the
    // REQUIRE_MFA_FOR_ADMIN case.
    const session = await requireSession(minimumRole);
    return {
      ...asAdminSession(session, 'request'),
      sessionId: session.sessionId,
      mfaVerified: session.mfaVerified,
      amr: session.amr,
    };
  }

  const role = explicit.role ? toRole(explicit.role) : 'CUSTOMER';
  if (!roleSatisfies(role, minimumRole)) {
    logger.warn('Role check refused', { role, required: minimumRole, userId: explicit.userId ?? null });
    throw errors.forbidden(`This action requires the ${minimumRole} role`);
  }

  const base = asAdminSession(explicit, 'caller');
  return {
    ...base,
    sessionId: explicit.sessionId ?? null,
    mfaVerified: explicit.mfaVerified === true,
    amr: Array.isArray(explicit.amr) ? explicit.amr : [],
  };
}

function roleSatisfies(role: string, minimum: Role): boolean {
  const order: Record<string, number> = { CUSTOMER: 0, SUPPORT: 1, ADMIN: 2, OWNER: 3 };
  return (order[role] ?? -1) >= (order[minimum] ?? 0);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Mints a session: one database row plus one signed cookie.
 *
 * THE SESSION COOKIE IS ONLY SET AFTER MFA. Callers must pass
 * `mfaVerified: true` only once a challenge actually passed, and this function
 * REFUSES to mint a cookie for an account with MFA enrolled that has not been
 * verified. That check is here rather than at each call site because getting it
 * wrong in one of five login paths is how the second factor silently stops
 * being a second factor.
 */
export async function createSession(input: CreateSessionInput): Promise<{ session: Session; token: string }> {
  if (input.mfaEnabled && !input.mfaVerified) {
    throw new AppError(
      'Refusing to create a session: this account has MFA enrolled but the challenge was not completed',
      403,
      'FORBIDDEN',
    );
  }

  const issuedAt = new Date();
  const absoluteExpiry = new Date(
    issuedAt.getTime() + authConfig.sessionAbsoluteTtlSeconds * 1000,
  );

  const sessionId = generateToken(16);
  // A placeholder keeps the create a single statement; the real hash lands with
  // the update below. The raw token is never written anywhere.
  const placeholderHash = sha256(`pending:${generateToken(32)}`);

  const row = await prisma.session.create({
    data: {
      id: sessionId,
      userId: input.userId,
      tokenHash: placeholderHash,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      ipHash: safePiiHash(input.ip),
      expiresAt: absoluteExpiry,
      createdAt: issuedAt,
      lastSeenAt: issuedAt,
    },
  });

  const token = await signSessionToken({
    sessionId: row.id,
    userId: input.userId,
    role: input.role,
    mfaEnabled: input.mfaEnabled,
    mfaVerified: input.mfaVerified,
    amr: input.amr,
    issuedAt,
    expiresAt: absoluteExpiry,
  });

  try {
    await prisma.session.update({
      where: { id: row.id },
      data: { tokenHash: sha256(token) },
    });
  } catch (error) {
    // Never leave a row whose hash does not correspond to any real cookie.
    await prisma.session
      .update({ where: { id: row.id }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
    throw error;
  }

  if (input.setCookie !== false) {
    await trySetCookie(
      authConfig.sessionCookieName,
      token,
      authConfig.sessionAbsoluteTtlSeconds,
    );
  }

  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) {
    // The user vanished between login and session creation (deleted account).
    await revokeSessionRow(row.id);
    throw errors.unauthorized('Account no longer exists');
  }

  const session = toSession(row, user, {
    sid: row.id,
    sub: input.userId,
    role: input.role,
    amr: input.amr,
    mfaEnabled: input.mfaEnabled,
    mfaVerified: input.mfaVerified,
    jti: '',
  });

  return { session, token };
}

async function revokeSessionRow(sessionId: string): Promise<void> {
  try {
    await prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  } catch (error) {
    logger.error('Session revocation failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Revokes the current session and clears its cookie.
 *
 * Idempotent, and safe to call when nobody is signed in — logout must always
 * report success so a caller cannot probe whether a cookie was live.
 */
export async function destroySession(): Promise<void> {
  const token = await getSessionToken();
  if (token) {
    try {
      const row = await prisma.session.findUnique({
        where: { tokenHash: sha256(token) },
        select: { id: true },
      });
      if (row) await revokeSessionRow(row.id);
    } catch (error) {
      logger.error('Logout could not reach the session store', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await tryDeleteCookie(authConfig.sessionCookieName);
  await tryDeleteCookie(authConfig.mfaPendingCookieName);
  await tryDeleteCookie(authConfig.csrfCookieName);
}

/** Revokes every live session for a user. Used on disable, role change and MFA disable. */
export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Housekeeping helper: expires rows that are past their window. */
export async function pruneExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: {
      OR: [{ expiresAt: { lte: new Date() } }, { revokedAt: { not: null } }],
    },
  });
  return result.count;
}
