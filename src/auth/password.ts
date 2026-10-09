/**
 * Password hashing (spec §15).
 *
 * bcrypt via bcryptjs, cost factor from `BCRYPT_COST` (default 12).
 *
 * THE TIMING RULE: `verifyPassword` performs exactly one bcrypt comparison for
 * EVERY call, including for an email address that does not exist and including
 * for an account with no password set. It does that by comparing against a
 * throw-away hash that is generated once, lazily, at the same cost factor. If
 * the "unknown user" path were cheap, response latency would tell an attacker
 * which addresses are registered — an enumeration oracle that no amount of
 * message wording can hide.
 */

import bcrypt from 'bcryptjs';
import { authConfig } from '@/auth/config';
import { errors } from '@/lib/errors';
import { logger } from '@/lib/logger';

/**
 * A value that is never a real password. Hashing/verifying against this is what
 * buys the timing symmetry. It must not be guessable as an actual credential
 * and must never be stored.
 */
const TIMING_EQUALISER_SECRET = 'rdm::auth::timing-equaliser::not-a-credential';

let timingEqualiserHash: Promise<string> | null = null;

/**
 * Lazily created, then memoised. Generated at the SAME cost factor as real
 * hashes so the timing profile matches.
 */
function getTimingEqualiserHash(): Promise<string> {
  timingEqualiserHash ??= (async () => {
    const salt = await bcrypt.genSalt(authConfig.bcryptCost);
    return bcrypt.hash(TIMING_EQUALISER_SECRET, salt);
  })();
  return timingEqualiserHash;
}

/**
 * Hard technical limits. Throws for input bcrypt cannot represent faithfully.
 * Policy (minimum length, character classes) is `validatePasswordStrength`.
 */
function assertStorablePassword(password: string): void {
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes === 0) {
    throw errors.validation('Password must not be empty');
  }
  if (bytes > authConfig.passwordMaxBytes) {
    // bcrypt ignores bytes past 72. Reject rather than truncate, so that two
    // different passwords can never authenticate as one another.
    throw errors.validation(
      `Password must be at most ${authConfig.passwordMaxBytes} bytes when UTF-8 encoded`,
    );
  }
}

/**
 * Hashes a password for storage. The returned value is the only thing that ever
 * touches the database — the plaintext must not be logged, audited or returned
 * to a client.
 */
export async function hashPassword(password: string): Promise<string> {
  assertStorablePassword(password);
  const salt = await bcrypt.genSalt(authConfig.bcryptCost);
  return bcrypt.hash(password, salt);
}

/**
 * Verifies a candidate password against a stored hash.
 *
 * `passwordHash` may be null/undefined (unknown account, or an OAuth/bootstrap
 * account with no password). In that case a comparison against the throw-away
 * hash is still performed so the caller cannot distinguish the cases by timing,
 * and the result is always `false`.
 *
 * The comparison itself is constant-time inside bcrypt; the leak we are closing
 * here is the *absence* of work, not the comparison.
 */
export async function verifyPassword(
  password: string,
  passwordHash: string | null | undefined,
): Promise<boolean> {
  const known = typeof passwordHash === 'string' && passwordHash.length > 0;
  const hash = known ? passwordHash : await getTimingEqualiserHash();

  let matched = false;
  try {
    matched = await bcrypt.compare(password, hash);
  } catch (error) {
    // A malformed stored hash must not become a 500 that distinguishes it from
    // "wrong password" by shape. Log, then fall through to `false`.
    logger.error('Password comparison failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    matched = false;
  }

  // Never let the equaliser hash ever authenticate anyone.
  return known && matched;
}

/**
 * True when a stored hash was produced with a weaker cost than we now require.
 * Callers should re-hash on the next successful login and keep the user
 * authenticated in the meantime (transparent upgrade).
 */
export function needsRehash(passwordHash: string): boolean {
  try {
    return bcrypt.getRounds(passwordHash) < authConfig.bcryptCost;
  } catch {
    return true;
  }
}

/**
 * Re-checks a password against a user's stored hash. Used by the MFA enrolment
 * and disable flows: possessing a session cookie is not enough to change the
 * account's second factor.
 */
export async function recheckPassword(
  userId: string,
  passwordHash: string | null,
  candidate: string,
): Promise<boolean> {
  const ok = await verifyPassword(candidate, passwordHash);
  if (!ok) {
    logger.warn('Password re-check failed', { userId });
  }
  return ok;
}

/**
 * Password policy for accounts that can reach money. Deliberately simple:
 * length first, then a class requirement that a 16-character passphrase
 * satisfies automatically.
 *
 * Returns a human-readable reason, or null when the password is acceptable.
 * Callers decide whether to throw.
 */
export function passwordPolicyViolation(password: string): string | null {
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes === 0) return 'Password must not be empty';
  if (password.length < authConfig.passwordMinLength) {
    return `Password must be at least ${authConfig.passwordMinLength} characters`;
  }
  if (bytes > authConfig.passwordMaxBytes) {
    return `Password must be at most ${authConfig.passwordMaxBytes} bytes`;
  }
  if (password.length >= 16) return null;

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    return 'Password must mix at least three of: lowercase, uppercase, digits, symbols — or be at least 16 characters';
  }
  return null;
}

/** Convenience wrapper for callers that prefer an exception. */
export function assertPasswordPolicy(password: string): void {
  const violation = passwordPolicyViolation(password);
  if (violation) throw errors.validation(violation);
}

/**
 * Normalises an email for account lookup. Deliberately NOT `normalizeEmail()`
 * from `@/lib/ids`: that one folds Gmail dots and +tags for fraud matching,
 * which would make `a.b+tag@gmail.com` and `ab@gmail.com` the same *login*.
 */
export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase();
}
