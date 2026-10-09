import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appConfig } from './env';
import { safeEqual } from './ids';

/**
 * Encryption at rest for redeem-code inventory (spec §13).
 *
 * Format: base64( iv[12] || authTag[16] || ciphertext ) using AES-256-GCM.
 * GCM is authenticated, so a tampered ciphertext fails to decrypt rather than
 * silently yielding a different "valid-looking" code — which matters because a
 * corrupted code that reaches a customer is an unredeemable paid order.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function loadKey(): Buffer {
  const raw = appConfig.encryptionKey;
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly 32 bytes, got ${key.length}. ` +
        'Generate a new one rather than padding an existing value.',
    );
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decrypt(payload: string): string {
  const key = loadKey();
  const raw = Buffer.from(payload, 'base64');
  if (raw.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext is too short to be valid');
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Deterministic HMAC of a redeem code.
 *
 * Purpose: detect duplicate codes at import time via the unique index on
 * (productId, codeFingerprint), without ever decrypting the whole inventory.
 * HMAC (not a bare hash) because codes have structure — a plain SHA-256 of a
 * short code is brute-forceable by anyone who guesses the code format.
 */
export function codeFingerprint(code: string): string {
  const key = appConfig.fingerprintKey;
  if (!key) throw new Error('FINGERPRINT_KEY or ENCRYPTION_KEY is required for codeFingerprint()');
  return createHmac('sha256', key).update(normalizeCode(code)).digest('hex');
}

/**
 * Codes arrive from suppliers in wildly inconsistent shapes:
 * "abcd-efgh-ijkl", "ABCD EFGH IJKL", " abcd efgh ijkl ".
 * Normalising before encrypt means the same code imported twice is detected
 * as a duplicate instead of being stored — and sold — twice.
 */
export function normalizeCode(code: string): string {
  return code.trim().replace(/\s+/g, '').toUpperCase();
}

/** Last 4 characters for masked admin display. */
export function codeLast4(code: string): string {
  return normalizeCode(code).slice(-4);
}

/**
 * HMAC-SHA256 of a raw webhook body, base64 encoded — the primitive behind
 * Whop's signature scheme. `timing` is enforced by the caller with safeEqual.
 */
export function hmacSha256Base64(secret: string, message: string | Buffer): string {
  return createHmac('sha256', secret).update(message).digest('base64');
}

export function hmacSha256(secret: string, message: string | Buffer): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Verifies an HMAC in constant time against a comma-separated list of
 * signatures, e.g. Whop's "v1,abc...,v1,def..." during secret rotation.
 */
export function verifySignatureList(
  headerValue: string,
  expected: string,
  prefix = 'v1',
): boolean {
  const candidates = headerValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let matched = false;
  for (const candidate of candidates) {
    const [scheme, value] = candidate.includes(',')
      ? [candidate.slice(0, candidate.indexOf(',')), candidate.slice(candidate.indexOf(',') + 1)]
      : [prefix, candidate];
    if (scheme !== prefix) continue;
    // safeEqual returns false for length mismatch without throwing; we still
    // OR the results so we always run a constant number of comparisons.
    if (safeEqual(value, expected)) matched = true;
  }
  return matched;
}

/** Byte-safe comparison used when checking decrypted material. */
export function bufferEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}