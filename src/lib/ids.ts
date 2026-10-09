import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appConfig } from './env';

/** Crockford-ish alphabet: no I, L, O, U — unambiguous when read aloud. */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Customer-facing order reference, e.g. "ORD-7QK2M4XB".
 * Unambiguous alphabet so support can read it over the phone without confusion.
 */
export function generateOrderReference(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length] ?? '0';
  return `ORD-${out}`;
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function newIdempotencyKey(): string {
  return randomUUID();
}

/**
 * SHA-256, hex. Used for session token hashing and request fingerprints.
 * Note: for high-entropy random inputs (session tokens) plain SHA-256 is
 * correct and preferable to bcrypt — there is no low-entropy guessing attack
 * when the input is 32 bytes of CSPRNG output.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function requestHash(value: unknown): string {
  return sha256(stableStringify(value));
}

/** Deterministic JSON so key order does not change the hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Constant-time string comparison for signature/secret checks. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still perform a comparison to keep timing flat, then fail.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * One-way hash for PII used in fraud analytics (emails, IPs). Deterministic so
 * velocity checks can count "how many times has THIS email been seen" without
 * storing the address in the fraud tables.
 */
export function piiHash(value: string): string {
  const key = appConfig.fingerprintKey;
  if (!key) throw new Error('FINGERPRINT_KEY / ENCRYPTION_KEY is required for piiHash()');
  return createHash('sha256').update(`${key}:${value.toLowerCase()}`).digest('hex');
}

export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  // Gmail-style dots and +tags: conservative only, applied for fraud matching
  // and never for delivery.
  const at = trimmed.lastIndexOf('@');
  if (at === -1) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${(local.split('+')[0] ?? local).replace(/\./g, '')}@${domain}`;
  }
  return `${local.split('+')[0] ?? local}@${domain}`;
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}@${domain}`;
}

/** Masked code for admin list views, e.g. "ABCD-••••-WXYZ" -> "••••WXYZ". */
export function maskCode(last4: string): string {
  return `••••${last4}`;
}