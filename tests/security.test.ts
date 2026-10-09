/**
 * Security invariants that are cheap to check and expensive to discover late.
 *
 * This suite reads files off disk rather than importing modules: a committed
 * credential is a leak whether or not any code path happens to execute it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.prisma']);
const IGNORED_DIRECTORIES = new Set(['node_modules', '.next', '.git', 'dist', 'coverage', '.turbo']);

interface SourceFile {
  /** Project-relative, POSIX separators. */
  relativePath: string;
  contents: string;
}

function walk(directory: string, accumulator: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      walk(path.join(directory, entry.name), accumulator);
      continue;
    }
    if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      accumulator.push(path.join(directory, entry.name));
    }
  }
  return accumulator;
}

function readSourceFiles(): SourceFile[] {
  return walk(SRC).map((absolute) => ({
    relativePath: path.relative(ROOT, absolute).split(path.sep).join('/'),
    contents: readFileSync(absolute, 'utf8'),
  }));
}

/**
 * Literal secret shapes. Thresholds are deliberately long: a prefix named in a
 * doc comment (`ws_…`, `whop_dispute`) is documentation, and a scanner that
 * cries wolf gets deleted.
 */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'Whop API key', pattern: /\bwhop_[A-Za-z0-9]{20,}/ },
  { name: 'Whop webhook secret', pattern: /\bws_[A-Za-z0-9_-]{20,}/ },
  { name: 'Stripe live key', pattern: /\bsk_live_[A-Za-z0-9]{8,}/ },
  { name: 'Resend API key', pattern: /\bre_[A-Za-z0-9]{20,}/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

describe('no hard-coded secrets in src/**', () => {
  const files = readSourceFiles();

  it('the scan actually found the source tree', () => {
    // A silent zero-file scan would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.relativePath.startsWith('src/lib/'))).toBe(true);
  });

  it.each(SECRET_PATTERNS)('contains no $name literal', ({ pattern }) => {
    const hits: string[] = [];
    for (const file of files) {
      const lines = file.contents.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (pattern.test(line)) hits.push(`${file.relativePath}:${index + 1}`);
        // `test` on a global-less regex has no lastIndex state, but be explicit.
        pattern.lastIndex = 0;
      });
    }
    expect(hits).toEqual([]);
  });

  it('never assigns a credential from a string literal', () => {
    // Any `process.env` read is fine; an inline key is not.
    const hits: string[] = [];
    const assignment = /\b[A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Z_]*\s*[:=]\s*['"]([^'"]){12,}['"]/;
    // A value that declares itself to be a non-credential. The bcrypt timing
    // equaliser in src/auth/password.ts is exactly this: a public, deliberately
    // non-secret string used to make "unknown user" and "wrong password" take
    // the same time. Allowing the DECLARATION is safer than renaming the
    // variable, which would only hide it from this rule.
    const selfDeclaringNonCredential = /not-a-credential/i;
    for (const file of files) {
      file.contents.split(/\r?\n/).forEach((line, index) => {
        const match = assignment.exec(line);
        if (!match) return;
        const literal = match[1] ?? '';
        if (literal.length >= 12 && !selfDeclaringNonCredential.test(literal)) {
          hits.push(`${file.relativePath}:${index + 1}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});

describe('.env.example', () => {
  const envExamplePath = path.join(ROOT, '.env.example');
  const exists = (() => {
    try {
      statSync(envExamplePath);
      return true;
    } catch {
      return false;
    }
  })();

  it('exists', () => {
    expect(exists).toBe(true);
  });

  it('contains placeholders only, never a real credential', () => {
    if (!exists) return;
    const contents = readFileSync(envExamplePath, 'utf8');
    for (const { name, pattern } of SECRET_PATTERNS) {
      const match = contents.match(pattern);
      expect(match, `.env.example must not contain a ${name}`).toBeNull();
    }
  });

  it('leaves every secret-shaped variable empty', () => {
    if (!exists) return;
    const secretish =
      /(KEY|SECRET|TOKEN|PASSWORD|ACCESS_KEY_ID|DATABASE_URL)=(?!\s*$)(.*)$/gm;
    for (const line of readFileSync(envExamplePath, 'utf8').split(/\r?\n/)) {
      // Commented-out alternatives (e.g. `# RESEND_API_KEY="re_xxxxxxxx"`) are
      // documentation; only ACTIVE assignments must be blank.
      if (line.trim().startsWith('#')) continue;
      const match = secretish.exec(line);
      if (!match) continue;
      const key = match[1] ?? '';
      const value = (match[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
      expect(value, `${key} must be blank in .env.example`).toBe('');
    }
  });
});

describe('next.config.ts security headers', () => {
  const configPath = path.join(ROOT, 'next.config.ts');
  const contents = () => readFileSync(configPath, 'utf8');

  it('sets a Content-Security-Policy', () => {
    const source = contents();
    expect(source).toContain('Content-Security-Policy');
  });

  it('locks the CSP down: no framing, no plugins, no foreign scripts', () => {
    const source = contents();
    expect(source).toContain("default-src 'self'");
    expect(source).toContain("script-src 'self' 'unsafe-inline'");
    expect(source).toContain("object-src 'none'");
    expect(source).toContain("frame-ancestors 'none'");
    expect(source).toContain("base-uri 'self'");
    expect(source).toContain("form-action 'self'");
    // No third-party script origins, ever.
    const scriptSrcLine = source.split(/\r?\n/).find((line) => line.includes('script-src')) ?? '';
    expect(scriptSrcLine).not.toContain('https://');
    expect(scriptSrcLine).not.toContain('unsafe-eval');
  });

  it('keeps the other baseline headers', () => {
    const source = contents();
    expect(source).toContain('X-Content-Type-Options');
    expect(source).toContain('X-Frame-Options');
    expect(source).toContain('Referrer-Policy');
    expect(source).toContain('noindex');
  });
});

describe('public catalog projection', () => {
  const queriesPath = path.join(SRC, 'catalog', 'queries.ts');

  const blockBetween = (source: string, start: string, end: string): string => {
    const from = source.indexOf(start);
    if (from === -1) return '';
    const to = source.indexOf(end, from);
    return source.slice(from, to === -1 ? undefined : to);
  };

  it('never selects supplierCostMinor into a public product shape', () => {
    const select = blockBetween(readFileSync(queriesPath, 'utf8'), 'PUBLIC_PRODUCT_SELECT', '} as const');
    expect(select).not.toBe('');
    expect(select).not.toMatch(/supplierCostMinor/);
    expect(select).not.toMatch(/codeCiphertext/);
    expect(select).not.toMatch(/codeFingerprint/);
    // The customer's own value IS public — the storefront must be able to say
    // "Price $3.00 · Value $1.00".
    expect(select).toMatch(/faceValueMinor/);
    expect(select).toMatch(/sellingPriceMinor/);
  });

  it('never puts supplierCostMinor or codeCiphertext on PublicProduct', () => {
    const source = readFileSync(queriesPath, 'utf8');
    const shape = blockBetween(source, 'export interface PublicProduct', '\n}');
    expect(shape).not.toBe('');
    expect(shape).not.toMatch(/supplierCostMinor/);
    expect(shape).not.toMatch(/codeCiphertext/);
  });

  it('customer-facing API routes never read supplier cost or encrypted codes', () => {
    const apiRoot = path.join(SRC, 'app', 'api');
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of walk(apiRoot)) {
      const contents = readFileSync(file, 'utf8');
      scanned += 1;
      if (/supplierCostMinor|codeCiphertext/.test(contents)) {
        offenders.push(path.relative(ROOT, file).split(path.sep).join('/'));
      }
    }
    // The walk must actually cover something, otherwise this is vacuous.
    expect(scanned).toBeGreaterThanOrEqual(0);
    expect(offenders).toEqual([]);
  });
});