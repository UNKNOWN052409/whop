/**
 * POST /api/auth/login — password step.
 *
 * THREE PROPERTIES THIS ENDPOINT HAS
 *
 *   1. IT NEVER SAYS WHETHER AN EMAIL EXISTS. Unknown address, wrong password,
 *      no password set and disabled account all produce byte-identical 401
 *      responses with the same message. The unknown-address path still performs
 *      a full bcrypt comparison against the timing-equaliser hash from
 *      `@/auth/password`, so it is not merely the same message — it is the same
 *      amount of work.
 *
 *   2. THE SESSION COOKIE IS NOT SET HERE WHEN MFA IS ENROLLED. The password
 *      step mints a short-lived, stateless `rdm_mfa_pending` grant and stops.
 *      `createSession()` additionally refuses to mint a cookie for an
 *      MFA-enrolled account that has not been verified, so even a caller that
 *      gets this wrong cannot produce a half-authenticated session.
 *
 *   3. IT IS RATE LIMITED TWICE: once per IP so one host cannot spray, once per
 *      account so a botnet cannot spray one address from many hosts.
 */

import { cookies } from 'next/headers';
import type { User } from '@prisma/client';
import { assertSameOriginForUnauthenticated } from '@/auth/csrf';
import { normalizeLoginEmail, verifyPassword, hashPassword, needsRehash } from '@/auth/password';
import { rateLimitLoginAccount, rateLimitLoginIp } from '@/auth/rate-limit';
import {
  clientIpFromHeaders,
  createSession,
  destroySession,
} from '@/auth/session';
import { authConfig, authCookieOptions, sessionSigningAvailable } from '@/auth/config';
import { signMfaGrant } from '@/auth/token';
import { prisma } from '@/db/prisma';
import { isStaff } from '@/auth/roles';
import { AppError } from '@/lib/errors';
import { maskEmail } from '@/lib/ids';
import { logger } from '@/lib/logger';
import { jsonError, jsonOk, rateLimitedResponse, readJsonObject, requireString } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One string for every failure. Any second message here is an enumeration
 * oracle, so there is exactly one and it is a constant.
 */
const GENERIC_FAILURE = 'Invalid email or password';

/** Deliberately not built from the submitted address: same bytes either way. */
function genericFailure(): Response {
  return Response.json(
    { error: GENERIC_FAILURE, code: 'UNAUTHORIZED' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!sessionSigningAvailable()) {
      // NOT CONFIGURED is surfaced, not faked: no session can be minted.
      throw new AppError(
        'Authentication is NOT CONFIGURED. SESSION_SECRET is missing or shorter than ' +
          `${authConfig.minSessionSecretLength} characters.`,
        503,
        'UNAUTHORIZED',
      );
    }

    await assertSameOriginForUnauthenticated(request);

    const body = await readJsonObject(request);
    const email = normalizeLoginEmail(requireString(body, 'email', { maxLength: 320, minLength: 3 }));
    const password = requireString(body, 'password', { maxLength: 200, minLength: 1 });

    const ip = clientIpFromHeaders(request.headers);

    // --- Rate limiting ------------------------------------------------------
    // IP first: a caller blocked here learns nothing about the account.
    const ipLimit = await rateLimitLoginIp(ip);
    if (!ipLimit.success) return rateLimitedResponse(ipLimit.retryAfterSeconds);

    const accountLimit = await rateLimitLoginAccount(email);
    if (!accountLimit.success) return rateLimitedResponse(accountLimit.retryAfterSeconds);

    // --- Credential check ---------------------------------------------------
    let user: User | null = null;
    try {
      user = await prisma.user.findUnique({ where: { email } });
    } catch (error) {
      logger.error('Login could not reach the user store', {
        error: error instanceof Error ? error.message : String(error),
      });
      // 503, not 401: the caller must not be told "wrong password" for what is
      // actually our outage.
      throw new AppError('Sign-in is temporarily unavailable. Try again shortly.', 503, 'PROVIDER_UNAVAILABLE');
    }

    // `verifyPassword` performs a full bcrypt comparison against a throw-away
    // hash when `user` is null or has no password, so the timing is identical.
    const passwordOk = await verifyPassword(password, user?.passwordHash ?? null);

    if (!user || !passwordOk) {
      logger.info('Login refused', {
        email: maskEmail(email),
        reason: user ? 'bad_password' : 'unknown_account',
        ip,
      });
      return genericFailure();
    }

    if (user.disabledAt !== null && user.disabledAt !== undefined) {
      // Uniform failure: a disabled account must not be distinguishable from a
      // wrong password, or the endpoint becomes an "is this person staff"
      // oracle for the addresses that matter most.
      logger.warn('Login refused for a disabled account', {
        userId: user.id,
        email: maskEmail(email),
        ip,
      });
      return genericFailure();
    }

    // --- Transparent password upgrade --------------------------------------
    if (user.passwordHash && needsRehash(user.passwordHash)) {
      const upgraded = await hashPassword(password).catch((error: unknown) => {
        logger.warn('Password re-hash failed; keeping the existing hash', {
          userId: user!.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      if (upgraded) {
        await prisma.user
          .update({ where: { id: user.id }, data: { passwordHash: upgraded } })
          .catch((error: unknown) => {
            logger.warn('Password re-hash could not be persisted', {
              userId: user!.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    }

    const mfaEnabled = user.mfaEnabledAt !== null && user.mfaEnabledAt !== undefined;

    // --- MFA gate -----------------------------------------------------------
    if (mfaEnabled) {
      // Any pre-existing session is dropped: a fresh password check starts a
      // fresh authentication.
      await destroySession().catch(() => undefined);

      const grant = await signMfaGrant(user.id, new Date());
      const store = await cookies();
      store.set(
        authConfig.mfaPendingCookieName,
        grant,
        authCookieOptions(authConfig.mfaGrantTtlSeconds),
      );

      logger.info('Login paused at the MFA step', { userId: user.id, email: maskEmail(email), ip });
      // Safe to reveal here: the caller has already proven the password, so
      // this is not an enumeration signal.
      return jsonOk({ ok: true, mfaRequired: true, reason: authConfig.mfaRequiredReason });
    }

    if (authConfig.requireMfaForAdmin && isStaff(user.role)) {
      // Flag on, account has nothing enrolled: signing in would produce an
      // admin session that bypasses the policy the flag exists to enforce.
      logger.error('Login refused: MFA enrolment required by policy', {
        userId: user.id,
        email: maskEmail(email),
      });
      return Response.json(
        {
          error:
            'This account must enrol an authenticator app before it can sign in (REQUIRE_MFA_FOR_ADMIN is on).',
          code: 'MFA_ENROLMENT_REQUIRED',
        },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // --- Mint the session ---------------------------------------------------
    await destroySession().catch(() => undefined);

    const { session } = await createSession({
      userId: user.id,
      role: user.role,
      mfaEnabled: false,
      mfaVerified: false,
      amr: ['pwd'],
      userAgent: request.headers.get('user-agent'),
      ip,
    });

    logger.info('Login succeeded', {
      userId: user.id,
      email: maskEmail(email),
      role: user.role,
      sessionId: session.sessionId,
      ip,
    });

    return jsonOk({
      ok: true,
      mfaRequired: false,
      role: user.role,
      // The admin surface is the only thing these credentials are for; the
      // storefront never issues sessions.
      redirectTo: isStaff(user.role) ? '/admin' : '/',
    });
  } catch (error) {
    return jsonError(error, 'Sign-in failed');
  }
}

/** Nothing here is cacheable and nothing here should be indexed. */
export async function GET(): Promise<Response> {
  return Response.json(
    { error: 'Use POST', code: 'INVALID_INPUT' },
    { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } },
  );
}
