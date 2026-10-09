/**
 * Crypto: encryption at rest, deterministic fingerprints, code normalisation.
 *
 * tests/setup.ts (configured as vitest `setupFiles`) generates a RANDOM
 * ENCRYPTION_KEY and FINGERPRINT_KEY into process.env BEFORE any module is
 * imported, so a static import of `@/lib/crypto` here is safe — `env.ts`
 * snapshots process.env at evaluation time, and a key set inside a test body
 * would arrive too late. A committed key literal would also fail this repo's
 * own security scan.
 */

import { describe, expect, it } from 'vitest';
import {
  bufferEqual,
  codeFingerprint,
  codeLast4,
  decrypt,
  encrypt,
  hmacSha256,
  hmacSha256Base64,
  normalizeCode,
  verifySignatureList,
} from '@/lib/crypto';

const SECRET_CODE = 'ABCD-EFGH-IJKL-MNPQ';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

describe('encrypt / decrypt', () => {
  it('round-trips a redeem code', () => {
    const ciphertext = encrypt(SECRET_CODE);
    expect(decrypt(ciphertext)).toBe(SECRET_CODE);
  });

  it('round-trips unicode and empty-ish payloads', () => {
    for (const plaintext of ['ünïcödé-cøde-🔑', 'a', 'x'.repeat(5_000)]) {
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    }
  });

  it('produces a different ciphertext every time (random IV)', () => {
    const a = encrypt(SECRET_CODE);
    const b = encrypt(SECRET_CODE);
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(decrypt(b));
  });

  it('never leaves the plaintext in the stored payload', () => {
    const ciphertext = encrypt(SECRET_CODE);
    expect(ciphertext).not.toContain(SECRET_CODE);
    expect(Buffer.from(ciphertext, 'base64').toString('utf8')).not.toContain(SECRET_CODE);
  });

  it('THROWS when a single ciphertext byte is tampered with', () => {
    const ciphertext = encrypt(SECRET_CODE);
    const raw = Buffer.from(ciphertext, 'base64');
    // Flip one bit inside the ciphertext body (past iv + auth tag).
    const index = IV_LENGTH + AUTH_TAG_LENGTH + 2;
    expect(raw.length).toBeGreaterThan(index);
    raw[index] = (raw[index]! ^ 0x01) & 0xff;

    // GCM is authenticated: a corrupted code must FAIL LOUDLY rather than
    // decrypt to a different, plausible-looking code and ship it to a customer.
    expect(() => decrypt(raw.toString('base64'))).toThrow();
  });

  it('THROWS when the IV is tampered with', () => {
    const raw = Buffer.from(encrypt(SECRET_CODE), 'base64');
    raw[0] = (raw[0]! ^ 0xff) & 0xff;
    expect(() => decrypt(raw.toString('base64'))).toThrow();
  });

  it('THROWS when the auth tag is tampered with', () => {
    const raw = Buffer.from(encrypt(SECRET_CODE), 'base64');
    raw[IV_LENGTH] = (raw[IV_LENGTH]! ^ 0xff) & 0xff;
    expect(() => decrypt(raw.toString('base64'))).toThrow();
  });

  it('THROWS on truncated or non-base64 payloads', () => {
    expect(() => decrypt('')).toThrow();
    expect(() => decrypt(Buffer.alloc(8).toString('base64'))).toThrow();
    expect(() => decrypt('not-a-ciphertext')).toThrow();
  });

  it('compares buffers in constant time by length first', () => {
    expect(bufferEqual(Buffer.from('ab'), Buffer.from('ab'))).toBe(true);
    expect(bufferEqual(Buffer.from('ab'), Buffer.from('abc'))).toBe(false);
  });
});

describe('codeFingerprint', () => {
  it('is deterministic', () => {
    expect(codeFingerprint(SECRET_CODE)).toBe(codeFingerprint(SECRET_CODE));
    expect(codeFingerprint(SECRET_CODE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different codes', () => {
    expect(codeFingerprint('CODE-A')).not.toBe(codeFingerprint('CODE-B'));
    // One character is enough to change the fingerprint.
    expect(codeFingerprint('CODE-A')).not.toBe(codeFingerprint('CODE-B'));
  });

  it('is computed over the NORMALISED code, so duplicate imports dedupe', () => {
    // Same supplier code, three different shapes -> one fingerprint, therefore
    // one row blocked by @@unique([productId, codeFingerprint]) instead of
    // being stored (and sold) twice.
    const fingerprint = codeFingerprint(' abcd-efgh ');
    expect(codeFingerprint('ABCD-EFGH')).toBe(fingerprint);
    // Extra inner padding around the SAME hyphenated code.
    expect(codeFingerprint('  abcd-efgh  ')).toBe(fingerprint);
    // A space where the hyphen is a genuinely DIFFERENT code — it must not
    // collide with the hyphenated one, or distinct codes would dedupe together.
    expect(codeFingerprint('abcd efgh')).not.toBe(fingerprint);
    expect(fingerprint).not.toBe(codeFingerprint('ABCD-EFGI'));
  });
});

describe('normalizeCode', () => {
  it('collapses surrounding whitespace, inner whitespace and case', () => {
    const expected = 'ABCD-EFGH';
    expect(normalizeCode(' abcd-efgh ')).toBe(expected);
    expect(normalizeCode('ABCD-EFGH')).toBe(expected);
    // Repeated inner padding collapses to nothing, leaving the hyphen intact.
    expect(normalizeCode('  abcd-efgh  ')).toBe(expected);
    expect(normalizeCode('\tabcd-efgh\n')).toBe(expected);
    // A space instead of a hyphen is a different character: normalisation
    // removes whitespace, it does not rewrite separators.
    expect(normalizeCode('abcd efgh')).toBe('ABCDEFGH');
  });

  it('is idempotent', () => {
    const once = normalizeCode('  abcd-efgh ');
    expect(normalizeCode(once)).toBe(once);
  });
});

describe('codeLast4', () => {
  it('returns the final four characters of the normalised code', () => {
    expect(codeLast4('abcd-efgh-ijkl')).toBe('IJKL');
    expect(codeLast4(' abcd-efgh-ijkl ')).toBe('IJKL');
    expect(codeLast4('ABCD-EFGH-IJKL-MNPQ')).toBe('MNPQ');
    // Short input still returns the final four characters, NORMALISED (upper).
    expect(codeLast4('short')).toBe('HORT');
  });
});

describe('HMAC primitives', () => {
  it('produces base64 digests for webhook signatures', () => {
    expect(hmacSha256Base64('secret', 'message')).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(hmacSha256Base64('secret', 'message')).toBe(hmacSha256Base64('secret', 'message'));
    expect(hmacSha256Base64('secret', 'message')).not.toBe(hmacSha256Base64('other', 'message'));
  });

  it('produces hex digests', () => {
    expect(hmacSha256('secret', 'message')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies a signature list, including rotation', () => {
    const expected = hmacSha256Base64('secret', 'message');
    const rotated = hmacSha256Base64('previous-secret', 'message');

    expect(verifySignatureList(`v1,${expected}`, expected)).toBe(true);
    expect(verifySignatureList(`v1,${rotated},v1,${expected}`, expected)).toBe(true);
    expect(verifySignatureList(`${expected}`, expected)).toBe(true);
    expect(verifySignatureList(`v1,${rotated}`, expected)).toBe(false);
    expect(verifySignatureList('v1,', expected)).toBe(false);
    expect(verifySignatureList('', expected)).toBe(false);
    // A signature of the wrong length must not throw.
    expect(verifySignatureList('v1,short', expected)).toBe(false);
  });
});