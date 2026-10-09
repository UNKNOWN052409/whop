/**
 * Authentication configuration (spec §15).
 *
 * EDGE-SAFE MODULE. `src/middleware.ts` runs on the Edge runtime, so this file
 * (and `roles.ts` / `token.ts`) must never import `node:*`, Prisma, bcrypt or
 * anything else that only exists in the Node runtime. If you add an import here,
 * the middleware bundle breaks at build time — which is at least loud.
 *
 * Every knob is read from the environment with a safe default. Nothing secret is
 * ever defined here; `SESSION_SECRET` is read through `appConfig` so that
 * `src/lib/env.ts` stays the single place that knows how configuration is
 * loaded (hard rule 4).
 */

import { appConfig } from '@/lib/env';

/** Reads a positive integer env var, clamped to [min, max]. */
function intEnv(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

/**
 * Minimum acceptable length of SESSION_SECRET. Below this an HS256 key is
 * brute-forceable from a stolen cookie, so we refuse to sign at all rather than
 * issue a weak token.
 */
const MIN_SESSION_SECRET_LENGTH = 32;

export const authConfig = {
  // --- Cookies ---------------------------------------------------------------
  /**
   * Cookie names. Kept stable across environments so a mis-set `NODE_ENV`
   * cannot silently produce two incompatible sessions; `secure` is what varies.
   */
  sessionCookieName: 'rdm_session',
  /** Short-lived grant proving "password already checked, MFA outstanding". */
  mfaPendingCookieName: 'rdm_mfa_pending',
  /**
   * Double-submit CSRF cookie. Deliberately NOT httpOnly: the browser client
   * has to read it to echo it back in the `x-csrf-token` header. It is useless
   * on its own because the value is HMAC-bound to SESSION_SECRET (see csrf.ts).
   */
  csrfCookieName: 'rdm_csrf',

  // --- Password hashing ------------------------------------------------------
  /** bcrypt cost factor. OWASP's floor for bcrypt is 10; 12 is the default. */
  bcryptCost: intEnv('BCRYPT_COST', 12, 4, 16),
  /**
   * Recovery codes carry ~50 bits of entropy from a CSPRNG, so they are far
   * less valuable to attack than a human-chosen password. They are also
   * compared in a loop (up to 10 hashes), so the cost factor is kept lower to
   * keep the MFA challenge responsive.
   */
  recoveryCodeBcryptCost: intEnv('RECOVERY_BCRYPT_COST', 10, 4, 16),
  passwordMinLength: intEnv('PASSWORD_MIN_LENGTH', 12, 8, 128),
  /**
   * bcrypt only consumes the first 72 bytes of a password and silently ignores
   * the rest. We reject longer passwords instead of truncating, otherwise
   * "correct horse battery staple…<extra>" and "correct horse battery staple"
   * would be the same credential.
   */
  passwordMaxBytes: 72,

  // --- Sessions --------------------------------------------------------------
  /**
   * Idle timeout. The database row's `expiresAt` slides forward on activity but
   * never past `sessionAbsoluteTtlSeconds`.
   */
  sessionIdleTtlSeconds: intEnv('SESSION_IDLE_TTL_SECONDS', 8 * 60 * 60, 300),
  /** Hard ceiling for a single login, regardless of activity. Also the JWT exp. */
  sessionAbsoluteTtlSeconds: intEnv('SESSION_ABSOLUTE_TTL_SECONDS', 7 * 24 * 60 * 60, 600),
  /** How stale `lastSeenAt` may get before we write a renewal. Keeps writes rare. */
  sessionRenewalIntervalSeconds: intEnv('SESSION_RENEWAL_INTERVAL_SECONDS', 15 * 60, 30),
  /** Minimum accepted length of SESSION_SECRET before we will sign anything. */
  minSessionSecretLength: MIN_SESSION_SECRET_LENGTH,

  // --- MFA -------------------------------------------------------------------
  /** How long a "password already verified, MFA outstanding" grant lives. */
  mfaGrantTtlSeconds: intEnv('MFA_GRANT_TTL_SECONDS', 5 * 60, 60),
  /** Issuer label shown in the authenticator app. */
  totpIssuer: process.env.MFA_ISSUER ?? 'Redeem Store',
  /** Number of recovery codes issued when MFA is enabled. */
  recoveryCodeCount: intEnv('MFA_RECOVERY_CODE_COUNT', 10, 1, 20),
  /**
   * TOTP drift tolerance in 30-second steps. 1 => accept the previous, current
   * and next step (~90 s of validity) so a slow phone clock does not lock an
   * admin out of their own payment platform.
   */
  totpWindowSteps: intEnv('MFA_TOTP_WINDOW_STEPS', 1, 0, 3),
  /**
   * When true, an ADMIN/OWNER session is refused unless it carries a completed
   * MFA challenge EVEN IF the account has not enrolled. Useful once the admin
   * surface is live. Defaults off so bootstrap login still works.
   */
  requireMfaForAdmin: boolEnv('REQUIRE_MFA_FOR_ADMIN', false),

  // --- Rate limiting ---------------------------------------------------------
  /** Max login attempts per IP per window. */
  loginIpLimit: intEnv('LOGIN_IP_LIMIT', 20),
  /** Max login attempts per account per window. */
  loginAccountLimit: intEnv('LOGIN_ACCOUNT_LIMIT', 5),
  /** Max MFA challenge attempts per user per window. A 6-digit TOTP is only 20 bits. */
  mfaAttemptLimit: intEnv('MFA_ATTEMPT_LIMIT', 5),
  /** Max MFA-enrolment / password re-check attempts per user per window. */
  passwordRecheckLimit: intEnv('PASSWORD_RECHECK_LIMIT', 5),
  /** Window shared by every auth rate-limit rule. */
  rateLimitWindowSeconds: intEnv('AUTH_RATE_LIMIT_WINDOW_SECONDS', 15 * 60, 10),

  // --- Routing ---------------------------------------------------------------
  loginPath: '/login',
  /** Query flag the middleware adds when it bounces an admin for MFA. */
  mfaRequiredReason: 'mfa_required',
} as const;

/** Cookie attributes shared by every auth cookie we set. */
export function authCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: appConfig.isProduction,
    // Lax, not Strict: Strict would drop the cookie on the redirect back from
    // Whop checkout, and Strict is not what protects these endpoints anyway —
    // state-changing calls are POSTs, which Lax already blocks cross-site.
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  } as const;
}

/** Cookie attributes for the CSRF cookie (must be readable by the client). */
export function csrfCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: false,
    secure: appConfig.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  } as const;
}

/**
 * True when we can actually mint a verifiable session token. When this is false
 * the auth endpoints report NOT CONFIGURED (503) instead of pretending to log
 * anyone in, and the middleware treats every cookie as invalid.
 */
export function sessionSigningAvailable(): boolean {
  const secret = appConfig.sessionSecret;
  return typeof secret === 'string' && secret.length >= MIN_SESSION_SECRET_LENGTH;
}

/** The secret material itself. Callers must have checked availability first. */
export function sessionSecret(): string {
  const secret = appConfig.sessionSecret;
  if (!secret || secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET is not set, or is shorter than ${MIN_SESSION_SECRET_LENGTH} characters. ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  }
  return secret;
}
