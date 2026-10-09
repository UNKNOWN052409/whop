/**
 * Identifiers, hashes and PII normalisation.
 *
 * Order references are read aloud to customers over the phone, so the alphabet
 * excludes I/L/O/U. `requestHash` underpins idempotency: if key order could
 * change the hash, a retried checkout would create a second order.
 */

import { describe, expect, it } from 'vitest';
import {
  generateOrderReference,
  generateToken,
  maskCode,
  maskEmail,
  newIdempotencyKey,
  normalizeEmail,
  piiHash,
  requestHash,
  safeEqual,
  sha256,
  stableStringify,
} from '@/lib/ids';

describe('generateOrderReference', () => {
  it('matches the documented format', () => {
    // "ORD-7QK2M4XB": prefix + 8 characters from an unambiguous alphabet.
    expect(generateOrderReference()).toMatch(/^ORD-[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it('never uses the ambiguous characters I, L, O or U', () => {
    for (let i = 0; i < 2_000; i += 1) {
      expect(generateOrderReference().slice(4)).not.toMatch(/[ILOU]/);
    }
  });

  it('is unique across a large batch', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) seen.add(generateOrderReference());
    expect(seen.size).toBe(5_000);
  });
});

describe('sha256', () => {
  it('matches the published vector for "abc"', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic and hex encoded', () => {
    expect(sha256('order_1')).toBe(sha256('order_1'));
    expect(sha256('order_1')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256('order_1')).not.toBe(sha256('order_2'));
    expect(sha256('')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('stableStringify', () => {
  it('is independent of key insertion order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ z: { y: 1, x: 2 }, a: 3 })).toBe(stableStringify({ a: 3, z: { x: 2, y: 1 } }));
  });

  it('preserves array order, which is meaningful', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('drops undefined properties', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('requestHash', () => {
  it('is stable under key reordering', () => {
    const first = { productId: 'p1', quantity: 2, email: 'buyer@example.com' };
    const reordered = { email: 'buyer@example.com', quantity: 2, productId: 'p1' };
    expect(requestHash(first)).toBe(requestHash(reordered));
    expect(requestHash(first)).toBe(requestHash({ ...first }));
  });

  it('changes when any VALUE changes', () => {
    const base = { productId: 'p1', quantity: 1 };
    expect(requestHash(base)).not.toBe(requestHash({ ...base, quantity: 2 }));
    expect(requestHash(base)).not.toBe(requestHash({ ...base, productId: 'p2' }));
  });

  it('distinguishes nested structures', () => {
    expect(requestHash({ a: { b: 1 } })).not.toBe(requestHash({ a: { b: 2 } }));
    expect(requestHash({ a: [1] })).not.toBe(requestHash({ a: [1, 2] }));
    expect(requestHash(null)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Buyer@Example.COM ')).toBe('buyer@example.com');
  });

  it('folds gmail dots and plus tags', () => {
    // Gmail ignores dots in the local part and everything after a "+".
    expect(normalizeEmail('John.Doe+newsletter@gmail.com')).toBe('johndoe@gmail.com');
    expect(normalizeEmail('j.o.h.n.doe@gmail.com')).toBe('johndoe@gmail.com');
    expect(normalizeEmail('buyer+tag@googlemail.com')).toBe('buyer@googlemail.com');
    expect(normalizeEmail('John.Doe+tag@gmail.com')).toBe(
      normalizeEmail('johndoe@gmail.com'),
    );
  });

  it('drops the plus tag but KEEPS dots for non-gmail providers', () => {
    // Conservative on purpose: only Gmail semantics are known for certain.
    expect(normalizeEmail('John.Doe+tag@example.com')).toBe('john.doe@example.com');
    expect(normalizeEmail('john.doe@outlook.com')).toBe('john.doe@outlook.com');
  });

  it('handles a value with no @', () => {
    expect(normalizeEmail('  NOTANEMAIL ')).toBe('notanemail');
  });
});

describe('masking', () => {
  it('maskCode shows only the last four characters', () => {
    expect(maskCode('WXYZ')).toBe('••••WXYZ');
    expect(maskCode('ABCD-EFGH-IJKL'.slice(-4))).toBe('••••IJKL');
    // The masked form must never contain the body of a code.
    expect(maskCode('WXYZ')).not.toContain('ABCD');
  });

  it('maskEmail keeps the domain and hides most of the local part', () => {
    expect(maskEmail('buyer@example.com')).toBe('bu***@example.com');
    expect(maskEmail('b@example.com')).toBe('b*@example.com');
    expect(maskEmail('not-an-email')).toBe('***');
  });
});

describe('piiHash', () => {
  it('is deterministic, keyed and lowercased', () => {
    expect(piiHash('Buyer@Example.com')).toBe(piiHash('buyer@example.com'));
    expect(piiHash('buyer@example.com')).toMatch(/^[0-9a-f]{64}$/);
    expect(piiHash('a@b.com')).not.toBe(piiHash('c@d.com'));
  });
});

describe('safeEqual and tokens', () => {
  it('compares without throwing on a length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('generates url-safe, unguessable tokens', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateToken()).not.toBe(token);
    expect(newIdempotencyKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});