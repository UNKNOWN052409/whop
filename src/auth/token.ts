/**
 * Signed session tokens (spec §15).
 *
 * EDGE-SAFE MODULE — imported by `src/middleware.ts`. Uses `jose`, which runs
 * on WebCrypto and therefore works unchanged in the Edge runtime.
 *
 * WHY A SIGNED TOKEN WHEN THERE IS ALREADY A SESSION TABLE?
 *   Middleware runs on every /admin request at the edge and cannot open a
 *   database connection. It verifies the signature and reads the role / MFA
 *   claims to make a fast routing decision. The authoritative check — is the row
 *   still live, was it revoked, is the account still enabled, is the role still
 *   current — happens in `getSession()` on the server. Middleware is a cheap
 *   gate, not the authority; every server component and route handler must still
 *   call `requireUser()` / `requireRole()`.
 *
 * The cookie value IS the JWT. The database stores only sha256(cookie value) in
 * `Session.tokenHash`, so a database dump cannot be replayed as a login.
 */

import { SignJWT, jwtVerify } from 'jose';
import { authConfig, sessionSecret } from '@/auth/config';
import { isRole, type Role } from '@/auth/roles';

const ISSUER = 'redeem-store';
const SESSION_AUDIENCE = 'redeem-store:session';
const MFA_GRANT_AUDIENCE = 'redeem-store:mfa-grant';

/** How the caller proved who they are, in order. */
export type AuthMethod = 'pwd' | 'totp' | 'recovery-code';

const ALGORITHM = 'HS256';

/** Cryptographically random, URL-safe. WebCrypto only — works on Edge and Node. */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  // base64url without padding, hand-rolled so this module needs no Buffer.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signingKey(): Uint8Array {
  return new TextEncoder().encode(sessionSecret());
}

export interface SessionClaims {
  /** `Session.id`. Binds the cookie to exactly one database row. */
  sid: string;
  /** User id. */
  sub: string;
  role: Role;
  /** Proofs accumulated during THIS login. */
  amr: AuthMethod[];
  /** Whether MFA is enrolled on the account as of mint time. */
  mfaEnabled: boolean;
  /**
   * Whether an MFA challenge was completed for THIS session. Never true for a
   * password-only session on an account with MFA enrolled — the session cookie
   * is not minted at all until the challenge passes.
   */
  mfaVerified: boolean;
  /** Unique token id, for correlation and future revocation lists. */
  jti: string;
}

export interface SignSessionInput {
  sessionId: string;
  userId: string;
  role: Role;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  amr: AuthMethod[];
  issuedAt: Date;
  /** Absolute hard ceiling; becomes the JWT `exp`. */
  expiresAt: Date;
}

export async function signSessionToken(input: SignSessionInput): Promise<string> {
  const nowSeconds = Math.floor(input.issuedAt.getTime() / 1000);
  const expSeconds = Math.floor(input.expiresAt.getTime() / 1000);

  return new SignJWT({
    sid: input.sessionId,
    role: input.role,
    amr: input.amr,
    mfaEnabled: input.mfaEnabled,
    mfaVerified: input.mfaVerified,
  })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(input.userId)
    .setIssuer(ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setJti(randomToken(16))
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expSeconds)
    .sign(signingKey());
}

/**
 * Verifies signature, issuer, audience and expiry.
 *
 * Returns null for every failure mode — including a misconfigured SESSION_SECRET
 * — because callers (middleware, route handlers) treat "cannot verify" and "not
 * authenticated" identically, and neither should produce a distinguishable
 * error for an attacker.
 */
export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  let payload;
  try {
    const verified = await jwtVerify(token, signingKey(), {
      issuer: ISSUER,
      audience: SESSION_AUDIENCE,
      algorithms: [ALGORITHM],
    });
    payload = verified.payload;
  } catch {
    return null;
  }

  const { sid, sub, role, amr, mfaEnabled, mfaVerified, jti } = payload as Record<string, unknown>;
  if (typeof sid !== 'string' || sid.length === 0) return null;
  if (typeof sub !== 'string' || sub.length === 0) return null;
  if (!isRole(role)) return null;
  if (typeof jti !== 'string' || jti.length === 0) return null;

  return {
    sid,
    sub,
    role,
    amr: Array.isArray(amr) ? amr.filter((m): m is AuthMethod => m === 'pwd' || m === 'totp' || m === 'recovery-code') : [],
    mfaEnabled: mfaEnabled === true,
    mfaVerified: mfaVerified === true,
    jti,
  };
}

// --- MFA pending grant ------------------------------------------------------

export interface MfaGrantClaims {
  /** User id that cleared the password step. */
  sub: string;
  jti: string;
  /** When the password step completed, unix seconds. */
  pwdAt: number;
}

/**
 * A short-lived, self-contained proof that the password step already passed.
 *
 * Deliberately NOT persisted: nothing is written to the Session table until the
 * MFA challenge succeeds, so there is no half-authenticated row to reconcile,
 * and the session cookie — the only credential that matters — is never set
 * before MFA completes. The trade-off is that a grant cannot be revoked before
 * it expires; a 5-minute window on a value that is useless without the TOTP
 * secret is the right side of that trade.
 */
export async function signMfaGrant(userId: string, issuedAt: Date): Promise<string> {
  const nowSeconds = Math.floor(issuedAt.getTime() / 1000);
  return new SignJWT({ pwdAt: nowSeconds })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(MFA_GRANT_AUDIENCE)
    .setJti(randomToken(16))
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + authConfig.mfaGrantTtlSeconds)
    .sign(signingKey());
}

export async function verifyMfaGrant(token: string): Promise<MfaGrantClaims | null> {
  let payload;
  try {
    const verified = await jwtVerify(token, signingKey(), {
      issuer: ISSUER,
      audience: MFA_GRANT_AUDIENCE,
      algorithms: [ALGORITHM],
    });
    payload = verified.payload;
  } catch {
    return null;
  }

  const { sub, jti, pwdAt } = payload as Record<string, unknown>;
  if (typeof sub !== 'string' || sub.length === 0) return null;
  if (typeof jti !== 'string' || jti.length === 0) return null;
  if (typeof pwdAt !== 'number') return null;

  return { sub, jti, pwdAt };
}

/**
 * Short-lived grant used by the MFA enrolment flow, which runs from an
 * already-authenticated session and only needs to prove a password re-check.
 * Separate audience so it cannot be replayed as a login MFA grant.
 */
/** Same shape; kept as a distinct name so call sites read honestly. */
export type MfaEnrolGrantClaims = MfaGrantClaims;

export async function signMfaEnrolGrant(userId: string, issuedAt: Date): Promise<string> {
  const nowSeconds = Math.floor(issuedAt.getTime() / 1000);
  return new SignJWT({ pwdAt: nowSeconds })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(`${MFA_GRANT_AUDIENCE}:enrol`)
    .setJti(randomToken(16))
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + authConfig.mfaGrantTtlSeconds)
    .sign(signingKey());
}

export async function verifyMfaEnrolGrant(token: string): Promise<MfaEnrolGrantClaims | null> {
  let payload;
  try {
    const verified = await jwtVerify(token, signingKey(), {
      issuer: ISSUER,
      audience: `${MFA_GRANT_AUDIENCE}:enrol`,
      algorithms: [ALGORITHM],
    });
    payload = verified.payload;
  } catch {
    return null;
  }

  const { sub, jti, pwdAt } = payload as Record<string, unknown>;
  if (typeof sub !== 'string' || sub.length === 0) return null;
  if (typeof jti !== 'string' || jti.length === 0) return null;
  if (typeof pwdAt !== 'number') return null;

  return { sub, jti, pwdAt };
}
