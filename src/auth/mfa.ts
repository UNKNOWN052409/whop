/**
 * TOTP second factor + hashed recovery codes (spec §15).
 *
 * TOTP via `otpauth` (RFC 6238, SHA-1 / 6 digits / 30 s — the profile every
 * authenticator app supports). A +/-1 step window is accepted so a phone clock
 * that is 30 s out does not lock an admin out of the payment platform.
 *
 * SECRET HANDLING
 *   The shared secret is a long-lived credential. It is stored ONLY as
 *   AES-256-GCM ciphertext in `User.mfaSecretCiphertext` (see `@/lib/crypto`)
 *   and is never logged. `verifyTotp` takes the base32 secret as an argument
 *   precisely so callers must consciously decrypt it.
 *
 * RECOVERY CODES
 *   Plaintext codes exist for exactly one moment: the response that returns them
 *   to the user immediately after enrolment. They are stored as bcrypt hashes in
 *   `User.mfaRecoveryHashes`, are never logged, and each is single-use.
 */

import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { authConfig } from '@/auth/config';
import { errors } from '@/lib/errors';
import { logger } from '@/lib/logger';

/** The parameters every mainstream authenticator app expects. */
export const TOTP_ALGORITHM = 'SHA1';
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** 20 bytes = 160 bits, the RFC 4226 recommendation. */
const TOTP_SECRET_BYTES = 20;

/**
 * Crockford-style alphabet without I, L, O, U so a code read aloud or copied
 * from a screenshot is unambiguous.
 */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_CODE_GROUPS = 2;
const RECOVERY_CODE_GROUP_LENGTH = 5;

// --- Secret generation -------------------------------------------------------

/** Fresh 160-bit TOTP secret. */
export function generateSecret(): Secret {
  return new Secret({ size: TOTP_SECRET_BYTES });
}

/** Convenience wrapper for callers holding a base32 string. */
export function secretFromBase32(base32: string): Secret {
  return Secret.fromBase32(base32);
}

/** A TOTP instance bound to an account label, ready to generate/validate. */
export function buildTotp(secret: Secret, email: string): TOTP {
  return new TOTP({
    issuer: authConfig.totpIssuer,
    // The authenticator app shows "issuer: account". Keep the label short and
    // stable so it does not overflow on a phone.
    label: email,
    issuerInLabel: true,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret,
  });
}

/**
 * The `otpauth://` URI the QR code encodes.
 *
 * This value CONTAINS the shared secret and is returned only during enrolment,
 * only to the account holder, and is never logged. The bare base32 secret is not
 * returned anywhere.
 */
export function totpUri(secret: Secret, email: string): string {
  return buildTotp(secret, email).toString();
}

/** The 6-digit code for right now. Test/QR helpers only — never for a response. */
export function currentTotp(secretBase32: string, at: number = Date.now()): string {
  return TOTP.generate({
    secret: secretFromBase32(secretBase32),
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    timestamp: at,
  });
}

// --- Verification ------------------------------------------------------------

/** Normalises what a human types: spaces and dashes stripped. */
export function normalizeTotpInput(code: string): string {
  return code.replace(/[\s-]/g, '');
}

export function looksLikeTotp(code: string): boolean {
  return /^\d{6}$/.test(normalizeTotpInput(code));
}

/**
 * Verifies a 6-digit TOTP with a +/-1 step window (`MFA_TOTP_WINDOW_STEPS`,
 * default 1 => the previous, current and next steps are accepted, ~90 s of
 * validity).
 *
 * Returns false — never throws — for every failure so callers cannot
 * distinguish "wrong code" from "secret missing" from "malformed input".
 * A malformed non-6-digit input short-circuits without doing HMAC work; it
 * carries no information an attacker does not already have, since the length of
 * a TOTP code is public.
 */
export function verifyTotp(
  code: string,
  secretBase32: string | null | undefined,
  options: { timestamp?: number; window?: number } = {},
): boolean {
  const normalized = normalizeTotpInput(code ?? '');
  if (!/^\d{6}$/.test(normalized)) return false;
  if (typeof secretBase32 !== 'string' || secretBase32.length === 0) return false;

  let secret: Secret;
  try {
    secret = secretFromBase32(secretBase32);
  } catch (error) {
    logger.error('Stored TOTP secret is not valid base32', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  const window = Math.max(0, Math.min(3, options.window ?? authConfig.totpWindowSteps));
  try {
    // Returns the delta from the current step, or null when nothing matched.
    const delta = TOTP.validate({
      token: normalized,
      secret,
      algorithm: TOTP_ALGORITHM,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      timestamp: options.timestamp ?? Date.now(),
      window,
    });
    return delta !== null;
  } catch (error) {
    logger.error('TOTP validation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// --- Recovery codes ----------------------------------------------------------

function randomRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_GROUPS * RECOVERY_CODE_GROUP_LENGTH);
  const characters: string[] = [];
  for (const byte of bytes) {
    characters.push(RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length] ?? '0');
  }
  const groups: string[] = [];
  for (let i = 0; i < characters.length; i += RECOVERY_CODE_GROUP_LENGTH) {
    groups.push(characters.slice(i, i + RECOVERY_CODE_GROUP_LENGTH).join(''));
  }
  return groups.join('-');
}

/**
 * Plaintext recovery codes. ~10 characters from a 32-symbol alphabet ≈ 50 bits.
 *
 * The RETURN VALUE IS A SECRET: it must go straight into the enrolment response
 * and must never be logged, stored or echoed back again.
 */
export function generateRecoveryCodes(count: number = authConfig.recoveryCodeCount): string[] {
  const total = Math.max(1, Math.min(20, Math.floor(count)));
  const codes: string[] = [];
  const seen = new Set<string>();
  // Collision is astronomically unlikely at this entropy, but a duplicate code
  // would silently reduce the number of usable codes, so we refuse to emit one.
  while (codes.length < total) {
    const code = randomRecoveryCode();
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

/** Normalises a typed recovery code: case-insensitive, separators stripped. */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, '');
}

async function hashRecoveryCode(code: string): Promise<string> {
  const salt = await bcrypt.genSalt(authConfig.recoveryCodeBcryptCost);
  return bcrypt.hash(normalizeRecoveryCode(code), salt);
}

/** bcrypt hashes for `User.mfaRecoveryHashes`. Plaintext is discarded here. */
export async function hashRecoveryCodes(codes: readonly string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => hashRecoveryCode(code)));
}

/**
 * Finds `candidate` among `storedHashes` and returns the remaining hashes, or
 * null when it did not match.
 *
 * Every hash is compared, even after a match, so the response time does not
 * reveal which position matched. The used code is removed, making it
 * single-use. Plaintext is never logged.
 */
export async function consumeRecoveryCode(
  storedHashes: readonly string[],
  candidate: string,
): Promise<string[] | null> {
  if (storedHashes.length === 0) return null;
  const normalized = normalizeRecoveryCode(candidate ?? '');
  if (normalized.length === 0) return null;

  let matchedIndex = -1;
  for (let index = 0; index < storedHashes.length; index += 1) {
    const hash = storedHashes[index];
    if (typeof hash !== 'string' || hash.length === 0) continue;
    let ok = false;
    try {
      ok = await bcrypt.compare(normalized, hash);
    } catch {
      // A corrupt hash row must not lock the user out of their own account.
      ok = false;
    }
    // Keep comparing after a match so the loop count does not leak position.
    if (ok && matchedIndex === -1) matchedIndex = index;
  }

  if (matchedIndex === -1) return null;
  return storedHashes.filter((_, index) => index !== matchedIndex);
}

/** Throws a uniform validation error. Used when a 6-digit code is badly shaped. */
export function assertTotpShape(code: string): void {
  if (!looksLikeTotp(code)) {
    throw errors.validation('Enter the 6-digit code from your authenticator app');
  }
}
