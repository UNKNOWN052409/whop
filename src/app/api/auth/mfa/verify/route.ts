/**
 * POST /api/auth/mfa/verify — second step of a login that has MFA enrolled.
 *
 * The only credential required here is the short-lived `rdm_mfa_pending` grant
 * that `/api/auth/login` issued after a successful password check. It carries no
 * privileges of its own: without the TOTP (or a recovery code) it proves
 * nothing, and it expires in `MFA_GRANT_TTL_SECONDS`.
 *
 * A 6-digit TOTP is roughly 20 bits of entropy, so this endpoint is the most
 * attractive thing to attack on the whole platform. It is limited per user, a
 * wrong code does not extend the grant, and every failure returns the same
 * message.
 */

import { cookies } from 'next/headers';
import { assertSameOriginForUnauthenticated } from '@/auth/csrf';
import { consumeRecoveryCode, looksLikeTotp, verifyTotp } from '@/auth/mfa';
import { rateLimitLoginIp, rateLimitMfaAttempt } from '@/auth/rate-limit';
import { clientIpFromHeaders, createSession, destroySession } from '@/auth/session';
import { authConfig, sessionSigningAvailable } from '@/auth/config';
import { verifyMfaGrant, type AuthMethod } from '@/auth/token';
import { decrypt } from '@/lib/crypto';
import { prisma } from '@/db/prisma';
import { AppError } from '@/lib/errors';
import { maskEmail } from '@/lib/ids';
import { logger } from '@/lib/logger';
import { jsonError, jsonOk, rateLimitedResponse, readJsonObject, requireString } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One message for every failure mode: no grant, unknown user, wrong code. */
const GENERIC_FAILURE = 'That code was not accepted. Check it and try again.';

function failure(status = 401): Response {
  return Response.json(
    { error: GENERIC_FAILURE, code: 'UNAUTHORIZED' },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!sessionSigningAvailable()) {
      throw new AppError('Authentication is NOT CONFIGURED. SESSION_SECRET is missing.', 503, 'UNAUTHORIZED');
    }

    await assertSameOriginForUnauthenticated(request);

    const body = await readJsonObject(request);
    // The submitted code is NEVER logged, never returned and never stored.
    const submitted = requireString(body, 'code', { maxLength: 32, minLength: 6 });

    const ip = clientIpFromHeaders(request.headers);

    const ipLimit = await rateLimitLoginIp(ip);
    if (!ipLimit.success) return rateLimitedResponse(ipLimit.retryAfterSeconds);

    const store = await cookies();
    const grantToken = store.get(authConfig.mfaPendingCookieName)?.value;
    if (!grantToken) return failure();

    const grant = await verifyMfaGrant(grantToken);
    if (!grant) return failure();

    const userId = grant.sub;

    const userLimit = await rateLimitMfaAttempt(userId);
    if (!userLimit.success) return rateLimitedResponse(userLimit.retryAfterSeconds);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.mfaEnabledAt === null || user.mfaEnabledAt === undefined) {
      // The account was enrolled-then-unenrolled, or disabled, between steps.
      return failure();
    }
    if (user.disabledAt !== null && user.disabledAt !== undefined) {
      logger.warn('MFA challenge refused for a disabled account', { userId: user.id });
      return failure();
    }

    // --- Verify -------------------------------------------------------------
    let method: AuthMethod | null = null;

    if (looksLikeTotp(submitted)) {
      let secret: string;
      try {
        secret = decrypt(user.mfaSecretCiphertext ?? '');
      } catch (error) {
        // A corrupt or key-rotated secret must not read as "wrong code": it is
        // an operator problem and has to be visible in the logs.
        logger.error('Stored MFA secret could not be decrypted', {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return failure();
      }
      if (verifyTotp(submitted, secret)) method = 'totp';
    } else {
      const remaining = await consumeRecoveryCode(user.mfaRecoveryHashes, submitted);
      if (remaining) {
        method = 'recovery-code';
        await prisma.user
          .update({ where: { id: user.id }, data: { mfaRecoveryHashes: remaining } })
          .catch((error: unknown) => {
            logger.error('Recovery code could not be marked as used', {
              userId: user.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        logger.warn('MFA challenge satisfied with a recovery code', {
          userId: user.id,
          email: maskEmail(user.email),
          recoveryCodesLeft: remaining.length,
        });
      }
    }

    if (!method) {
      logger.info('MFA challenge refused', { userId: user.id, ip });
      // The pending grant is deliberately NOT extended or refreshed here.
      return failure();
    }

    // --- Mint the real session ---------------------------------------------
    // Only NOW does a session row exist. Nothing was written before this point.
    await destroySession().catch(() => undefined);

    const { session } = await createSession({
      userId: user.id,
      role: user.role,
      mfaEnabled: true,
      mfaVerified: true,
      amr: ['pwd', method],
      userAgent: request.headers.get('user-agent'),
      ip,
    });

    try {
      store.delete(authConfig.mfaPendingCookieName);
    } catch {
      // The grant is stateless and short-lived; a leftover copy is inert once
      // the account's MFA has already been satisfied by this login.
    }

    logger.info('MFA challenge succeeded', {
      userId: user.id,
      email: maskEmail(user.email),
      method,
      sessionId: session.sessionId,
      ip,
    });

    return jsonOk({ ok: true, mfaRequired: false, role: user.role, redirectTo: '/admin' });
  } catch (error) {
    return jsonError(error, 'Verification failed');
  }
}

export async function GET(): Promise<Response> {
  return Response.json(
    { error: 'Use POST', code: 'INVALID_INPUT' },
    { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } },
  );
}
