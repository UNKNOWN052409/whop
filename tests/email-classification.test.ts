/**
 * Email error classification and retry backoff.
 *
 * Getting this wrong in either direction costs money: treating a permanent
 * "mailbox full" as transient fills the queue with sends that can never
 * succeed and delays real orders behind them; treating a transient timeout as
 * permanent drops a paid customer's redeem code.
 */

import { describe, expect, it, vi } from 'vitest';
import { backoffDelayMs, classifyEmailError } from '@/email/types';

describe('classifyEmailError — permanent failures', () => {
  it('recognises hard bounces and full mailboxes', () => {
    for (const message of [
      '550 5.2.2 Mailbox full',
      'Mailbox full',
      '421 recipient does not exist',
      'Invalid email address',
      '550 blocked by recipient policy',
      'address is suppressed',
      '550 5.1.1 unrouteable address',
      'sender not allowed by the receiving domain',
    ]) {
      expect(classifyEmailError(new Error(message)).permanent).toBe(true);
    }
  });
});

describe('classifyEmailError — transient failures', () => {
  it('recognises timeouts, resets and rate limits as retryable', () => {
    for (const message of [
      'Connection timeout',
      'ETIMEDOUT',
      'socket hang up',
      'ECONNRESET',
      '429 rate limit exceeded',
      'Throttled by the provider',
      'Service temporarily unavailable',
      '503 backend unavailable',
    ]) {
      const result = classifyEmailError(new Error(message));
      expect(result.permanent).toBe(false);
      // Retryable failures are the ones that must keep the code alive.
      expect(result.message).toBe(message);
    }
  });

  it('defaults an unknown failure to TRANSIENT', () => {
    // Losing a paid customer's code is unrecoverable; a duplicate send is not.
    expect(classifyEmailError(new Error('something odd happened')).permanent).toBe(false);
    expect(classifyEmailError('bare string failure').permanent).toBe(false);
  });

  it('accepts non-Error values without throwing', () => {
    expect(classifyEmailError(undefined).permanent).toBe(false);
    expect(classifyEmailError(null).permanent).toBe(false);
    expect(classifyEmailError(42).message).toBe('42');
    expect(classifyEmailError({ toString: () => 'mailbox full' }).permanent).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(classifyEmailError(new Error('MAILBOX FULL')).permanent).toBe(true);
    expect(classifyEmailError(new Error('Connection TIMEOUT')).permanent).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially with the attempt number', () => {
    // With jitter stubbed out (see below) the ceiling is the attempt's cap.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    try {
      expect(backoffDelayMs(1, 1_000, 900_000)).toBeLessThan(backoffDelayMs(2, 1_000, 900_000));
      expect(backoffDelayMs(2, 1_000, 900_000)).toBeLessThan(backoffDelayMs(3, 1_000, 900_000));
    } finally {
      random.mockRestore();
    }
  });

  it('stays inside [exp/2, exp] for every attempt', () => {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const base = 1_000;
      const max = 15 * 60_000;
      const ceiling = Math.min(max, base * 2 ** (attempt - 1));
      for (let i = 0; i < 25; i += 1) {
        const delay = backoffDelayMs(attempt, base, max);
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(ceiling / 2));
        expect(delay).toBeLessThanOrEqual(ceiling);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is BOUNDED by the maximum, even at a large attempt number', () => {
    const maxMs = 15 * 60_000;
    for (const attempt of [1, 5, 12, 50, 500, 5_000]) {
      for (let i = 0; i < 50; i += 1) {
        const delay = backoffDelayMs(attempt, 1_000, maxMs);
        expect(delay).toBeLessThanOrEqual(maxMs);
      }
    }
    // Without an explicit cap, the documented 15-minute default still bounds it.
    for (let i = 0; i < 50; i += 1) {
      expect(backoffDelayMs(100, 1_000)).toBeLessThanOrEqual(15 * 60_000);
    }
  });

  it('VARIES — full jitter, so a thundering herd does not repeat itself', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i += 1) seen.add(backoffDelayMs(5, 1_000, 15 * 60_000));
    // 16 possible jitter buckets for a 5th-attempt delay of ~16s.
    expect(seen.size).toBeGreaterThan(1);
    expect(Math.max(...seen)).toBeGreaterThan(Math.min(...seen));
  });

  it('treats attempt 0 and negative attempts as the first attempt', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const first = backoffDelayMs(1, 1_000, 900_000);
      expect(backoffDelayMs(0, 1_000, 900_000)).toBe(first);
      expect(backoffDelayMs(-5, 1_000, 900_000)).toBe(first);
    } finally {
      random.mockRestore();
    }
  });

  it('never returns a negative delay', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(backoffDelayMs(1)).toBe(500);
      expect(backoffDelayMs(3)).toBe(2_000);
    } finally {
      random.mockRestore();
    }
  });
});