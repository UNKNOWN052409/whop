import { describe, expect, it } from 'vitest';

import { redactText, safeDiagnostic } from '@/observability/redact';

/**
 * `/api/health` is unauthenticated and is polled by the platform's own
 * monitoring. Anything a driver or a stack frame can put into a message that
 * reaches it is a standing disclosure of internal topology.
 *
 * The asymmetry these tests encode: infrastructure identifiers (hosts, ports,
 * absolute build paths, provider and region) MUST NOT survive, while the
 * information an operator needs to act (the file name, the line number, the
 * nature of the failure) MUST.
 */
describe('redactText — infrastructure disclosure', () => {
  const mustNotContain = [
    // The literal addresses and hosts observed leaking in practice.
    '127.0.0.1',
    '5999',
    '10.0.5.4',
    '5432',
    'db.internal.example.com',
    '6432',
    'aws-0-us-east-1',
    'supabase.com',
    '6543',
    // Build layout.
    'Unkno',
    'Videos',
    'NVIDIA',
    'Desktop',
    'payment',
    'var/task',
    'observability',
  ];

  const cases: [string, string][] = [
    [
      'Prisma cannot-reach message',
      "Invalid prisma.$queryRaw() invocation: Can't reach database server at `127.0.0.1:5999`",
    ],
    ['Node ECONNREFUSED with private IP', 'connect ECONNREFUSED 10.0.5.4:5432'],
    ['internal hostname and port', 'db.internal.example.com:6432'],
    ['managed pooler host names provider and region', 'aws-0-us-east-1.pooler.supabase.com:6543'],
    ['localhost and port', 'postgres unavailable at localhost:5999'],
    ['full DSN', 'postgres://postgres.PROJ:PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres'],
    ['windows build path with frame', 'C:\\Users\\Unkno\\Videos\\NVIDIA\\Desktop\\payment\\src\\observability\\heartbeat.ts:146:3'],
    ['posix bundle root', '/var/task/src/observability/heartbeat.ts:146'],
  ];

  for (const [label, input] of cases) {
    it(`removes internal addresses from: ${label}`, () => {
      const output = redactText(input, 300);
      for (const forbidden of mustNotContain) {
        expect(output, `"${forbidden}" survived redaction of ${label}`).not.toContain(forbidden);
      }
    });
  }

  it('keeps the file name and line so a diagnostic is still actionable', () => {
    expect(redactText('C:\\Users\\Unkno\\Videos\\payment\\src\\observability\\heartbeat.ts:146:3')).toContain(
      'heartbeat.ts',
    );
    expect(redactText('/var/task/src/observability/heartbeat.ts:146')).toContain('heartbeat.ts');
  });

  it('keeps the nature of the failure', () => {
    const output = redactText("Can't reach database server at `127.0.0.1:5999`");
    expect(output).toContain("Can't reach database server");
    expect(output).toContain(REDACTED_TOKEN);
  });
});

describe('redactText — must not over-redact', () => {
  /**
   * Each of these contains `number:number`-shaped or dotted text that is NOT an
   * address. If any of it disappears the output stops being usable for its
   * actual purpose, which is the failure mode this file explicitly warns about.
   */
  const survivors: [string, string][] = [
    ['a wall-clock timestamp', 'generated at 09:18:41'],
    ['a semver', 'whop api version 2026-10-07-2'],
    ['a plain sentence with a dotted word', 'That code was not accepted'],
    ['an application error message', 'Encryption key is not set'],
    ['a validation message', 'Enter the 6-digit code from your authenticator app'],
    ['a short lowercase token', 'invalid input'],
    ['a money amount', 'charged 300 minor units of USD'],
  ];

  for (const [label, input] of survivors) {
    it(`leaves intact: ${label}`, () => {
      expect(redactText(input, 300)).toBe(input);
    });
  }

  it('does not redact a port number when it stands alone in prose', () => {
    const output = redactText('connection limit exceeded for pool port 5432 configuration');
    expect(output).toContain('5432');
  });
});

describe('safeDiagnostic', () => {
  it('redacts an Error carrying a private address', () => {
    const output = safeDiagnostic(new Error('connect ECONNREFUSED 127.0.0.1:5999'));
    expect(output).not.toContain('127.0.0.1');
    expect(output).not.toContain('5999');
    expect(output).toContain('Error');
  });

  it('redacts a string reason', () => {
    expect(safeDiagnostic('db.internal.example.com:6432')).not.toContain('internal.example.com');
  });

  it('redacts addresses inside an arbitrary object', () => {
    const output = safeDiagnostic({ host: 'db.internal.example.com:6432', port: 6432 });
    expect(output).not.toContain('internal.example.com');
  });

  it('still returns a usable string for nullish input', () => {
    expect(safeDiagnostic(null)).toBe('unknown error');
    expect(safeDiagnostic(undefined)).toBe('unknown error');
  });
});

const REDACTED_TOKEN = '[redacted]';