/**
 * POST /api/auth/mfa/enrol — enable or disable TOTP.
 *
 * Three actions on one route, because they share the same two guards:
 *
 *   start   `{ password }`    -> re-check the password, mint a secret, store it
 *                                ENCRYPTED but NOT enabled, return the otpauth
 *                                URI for the QR code.
 *   confirm `{ code }`        -> prove the authenticator app holds the same
 *                                secret, flip `mfaEnabledAt`, issue recovery
 *                                codes (returned ONCE, stored only as hashes).
 *   disable `{ password }`    -> OWNER-only. Clears MFA and revokes every
 *                                session, including the caller's own.
 *
 * WHY "START" DOES NOT ENABLE MFA
 *   Enrolment is only real once the account holder has demonstrated they can
 *   produce a code. Enabling on `start` would let an attacker who has a stolen
 *   session cookie lock the owner out of their own account by enrolling their
 *   own authenticator.
 *
 * SECRET HANDLING
 *   The base32 secret and the recovery codes exist in plaintext only in this
 *   route's memory and in the single response that must deliver them. Neither
 *   is ever logged, audited or stored in plaintext: the secret goes into
 *   `User.mfaSecretCiphertext` (AES-256-GCM) and the recovery codes into
 *   `User.mfaRecoveryHashes` (bcrypt).
 */

import { cookies } from 'next/headers';
import { assertCsrf } from '@/auth/csrf';
import { authConfig, authCookieOptions, sessionSigningAvailable } from '@/auth/config';
import {
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCodes,
  totpUri,
  verifyTotp,
} from '@/auth/mfa';
import { recheckPassword } from '@/auth/password';
import { rateLimitPasswordRecheck } from '@/auth/rate-limit';
import { requireOwnerAction } from '@/auth/rbac';
import { requireSession, revokeAllSessions, type Session } from '@/auth/session';
import { signMfaEnrolGrant, verifyMfaEnrolGrant } from '@/auth/token';
import { decrypt, encrypt } from '@/lib/crypto';
import { prisma } from '@/db/prisma';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { jsonError, jsonOk, rateLimitedResponse, readJsonObject, requireString } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['start', 'confirm', 'disable'] as const;
type Action = (typeof ACTIONS)[number];

/**
 * Grant proving the password re-check for THIS enrolment attempt. A separate
 * cookie from the login MFA grant, and a separate JWT audience, so a login grant
 * can never be replayed here to confirm a secret somebody else injected.
 */
const MFA_ENROL_COOKIE = 'rdm_mfa_enrol';

export async function POST(request: Request): Promise<Response> {
  try {
    if (!sessionSigningAvailable()) {
      throw new AppError('Authentication is NOT CONFIGURED. SESSION_SECRET is missing.', 503, 'UNAUTHORIZED');
    }

    const body = await readJsonObject(request);
    const action = requireString(body, 'action', { maxLength: 16 });
    if (!ACTIONS.includes(action as Action)) {
      throw new AppError(`action must be one of: ${ACTIONS.join(', ')}`, 400, 'VALIDATION_FAILED');
    }

    // Every branch mutates security state, so every branch is CSRF-checked.
    await assertCsrf(request);

    switch (action as Action) {
      case 'start':
        return jsonOk(await handleStart(request, body));
      case 'confirm':
        return jsonOk(await handleConfirm(request, body));
      case 'disable':
        return jsonOk(await handleDisable(request, body));
      default:
        throw new AppError('Unsupported action', 400, 'INVALID_INPUT');
    }
  } catch (error) {
    return jsonError(error, 'MFA request failed');
  }
}

/** Loads the authenticated caller. Any logged-in role may enrol their own MFA. */
async function requireEnrollingSession(): Promise<Session> {
  return requireSession('CUSTOMER');
}

async function assertPasswordRecheck(session: Session, password: string): Promise<void> {
  const limit = await rateLimitPasswordRecheck(session.userId);
  if (!limit.success) {
    throw new AppError('Too many attempts. Try again later.', 429, 'RATE_LIMITED', {
      retryAfterSeconds: limit.retryAfterSeconds,
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { passwordHash: true },
  });
  if (!user) throw new AppError('Account not found', 401, 'UNAUTHORIZED');

  const ok = await recheckPassword(session.userId, user.passwordHash, password);
  if (!ok) {
    // Uniform 401: not "wrong password for an account that exists" vs
    // "no such account" vs "account has no password".
    throw new AppError('That password was not accepted', 401, 'UNAUTHORIZED');
  }
}

// --- start -------------------------------------------------------------------

async function handleStart(request: Request, body: Record<string, unknown>) {
  const session = await requireEnrollingSession();
  const password = requireString(body, 'password', { maxLength: 200, minLength: 1 });
  await assertPasswordRecheck(session, password);

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) throw new AppError('Account not found', 401, 'UNAUTHORIZED');

  if (user.mfaEnabledAt !== null && user.mfaEnabledAt !== undefined) {
    throw new AppError('MFA is already enabled on this account', 409, 'DUPLICATE_REQUEST');
  }

  const secret = generateSecret();
  const secretBase32 = secret.base32;

  // Stored encrypted and NOT enabled. `mfaEnabledAt` stays null until `confirm`.
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaSecretCiphertext: encrypt(secretBase32) },
  });

  // Short-lived grant proving the password step, so `confirm` does not need the
  // password again and an attacker cannot confirm a secret they injected.
  const grant = await signMfaEnrolGrant(user.id, new Date());
  const store = await cookies();
  store.set(MFA_ENROL_COOKIE, grant, authCookieOptions(authConfig.mfaGrantTtlSeconds));

  // The VALUE is never logged — only the fact that a secret was issued.
  logger.warn('MFA enrolment started: a new TOTP secret was issued to an existing account', {
    userId: user.id,
    sessionId: session.sessionId,
  });

  return {
    ok: true,
    action: 'start',
    // The enrolment artifact. It contains the shared secret and is returned
    // exactly once, to the account holder, over the authenticated channel.
    uri: totpUri(secret, user.email),
    issuer: authConfig.totpIssuer,
    digits: 6,
    periodSeconds: 30,
  };
}

// --- confirm -----------------------------------------------------------------

async function handleConfirm(_request: Request, body: Record<string, unknown>) {
  const session = await requireEnrollingSession();
  const code = requireString(body, 'code', { maxLength: 12, minLength: 6 });

  const store = await cookies();
  const grantToken = store.get(MFA_ENROL_COOKIE)?.value;
  if (!grantToken) {
    throw new AppError('Start enrolment again before confirming', 400, 'INVALID_INPUT');
  }
  const grant = await verifyMfaEnrolGrant(grantToken);
  if (!grant || grant.sub !== session.userId) {
    throw new AppError('Start enrolment again before confirming', 400, 'INVALID_INPUT');
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) throw new AppError('Account not found', 401, 'UNAUTHORIZED');
  if (user.mfaEnabledAt !== null && user.mfaEnabledAt !== undefined) {
    throw new AppError('MFA is already enabled on this account', 409, 'DUPLICATE_REQUEST');
  }
  if (!user.mfaSecretCiphertext) {
    throw new AppError('Start enrolment again before confirming', 400, 'INVALID_INPUT');
  }

  let secretBase32: string;
  try {
    secretBase32 = decrypt(user.mfaSecretCiphertext);
  } catch (error) {
    logger.error('Pending MFA secret could not be decrypted', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new AppError('Start enrolment again before confirming', 400, 'INVALID_INPUT');
  }

  if (!verifyTotp(code, secretBase32)) {
    // The submitted code is never logged.
    logger.info('MFA enrolment confirm refused', { userId: user.id });
    throw new AppError('That code was not accepted. Check it and try again.', 400, 'VALIDATION_FAILED');
  }

  // Recovery codes exist once, in plaintext, only in this response.
  const recoveryCodes = generateRecoveryCodes();
  const recoveryHashes = await hashRecoveryCodes(recoveryCodes);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaEnabledAt: new Date(),
      mfaSecretCiphertext: encrypt(secretBase32),
      mfaRecoveryHashes: recoveryHashes,
    },
  });

  try {
    store.delete(MFA_ENROL_COOKIE);
  } catch {
    // The grant expires on its own; leaving it costs nothing once MFA is on.
  }

  logger.warn('MFA enabled on an account; recovery codes were issued and are shown once', {
    userId: user.id,
    recoveryCodeCount: recoveryCodes.length,
  });

  // Every OTHER session is dropped: enabling a second factor must not leave
  // already-compromised sessions alive.
  const revoked = await revokeAllSessions(user.id, session.sessionId);

  return {
    ok: true,
    action: 'confirm',
    mfaEnabled: true,
    revokedOtherSessions: revoked,
    // SHOWN ONCE. Stored only as bcrypt hashes; there is no way to recover them.
    recoveryCodes,
  };
}

// --- disable -----------------------------------------------------------------

async function handleDisable(_request: Request, body: Record<string, unknown>) {
  // Disabling MFA is an OWNER-only action: it is the control that stops an
  // attacker who has a password from staying in, so changing it must not be in
  // reach of anyone who has already been breached once.
  const ownerSession = await requireOwnerAction('mfa.disable');

  const password = requireString(body, 'password', { maxLength: 200, minLength: 1 });
  const caller = await requireEnrollingSession();
  if (caller.userId !== ownerSession.userId) {
    // An OWNER may disable MFA on another account only by re-proving THEIR OWN
    // password first; this route never accepts another account's credentials.
    throw new AppError('This action requires the OWNER role', 403, 'FORBIDDEN');
  }
  await assertPasswordRecheck(caller, password);

  const user = await prisma.user.findUnique({ where: { id: caller.userId } });
  if (!user) throw new AppError('Account not found', 401, 'UNAUTHORIZED');
  if (user.mfaEnabledAt === null && user.mfaRecoveryHashes.length === 0 && !user.mfaSecretCiphertext) {
    throw new AppError('MFA is not enabled on this account', 409, 'INVALID_STATE_TRANSITION');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { mfaEnabledAt: null, mfaSecretCiphertext: null, mfaRecoveryHashes: [] },
  });

  try {
    (await cookies()).delete(MFA_ENROL_COOKIE);
  } catch {
    // Cookie clearing is hygiene; the server-side state is already cleared.
  }

  // INCLUDING the caller's own session: after this response the only way back
  // in is a password-only login.
  const revoked = await revokeAllSessions(user.id);

  logger.warn('MFA disabled on an account by its OWNER', {
    userId: user.id,
    revokedSessions: revoked,
  });

  return { ok: true, action: 'disable', mfaEnabled: false, revokedSessions: revoked };
}

/** Separate audience from the login grant, so one cannot be replayed as the other. */
export async function GET(): Promise<Response> {
  return Response.json(
    { error: 'Use POST', code: 'INVALID_INPUT' },
    { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } },
  );
}
