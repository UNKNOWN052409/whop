/**
 * Vitest global setup.
 *
 * Runs BEFORE any application module is imported. That ordering matters:
 * `src/lib/env.ts` snapshots `process.env` at module-evaluation time, so a key
 * injected here is visible to `appConfig.encryptionKey` / `whopConfig` and a key
 * injected inside a test body would not be.
 *
 * Deliberate decisions:
 *
 *  - Test crypto keys are generated RANDOMLY at runtime rather than committed as
 *    constants. A committed key in a fixture file is a hard-coded secret, and the
 *    security suite (tests/unit/security.test.ts) fails the build on exactly that.
 *    Random per-run keys are also strictly better: they prove no module is
 *    accidentally caching a key across runs.
 *  - Nothing here fabricates an integration. WHOP_API_KEY / provider credentials
 *    are left exactly as the developer configured them; an unconfigured provider
 *    must report NOT_CONFIGURED (spec §24), and the suite asserts that.
 *  - DATABASE_URL is only set from TEST_DATABASE_URL, never invented. Suites
 *    that need a database are gated on it and skip cleanly when it is absent.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';

/**
 * Minimal .env parser. The project has no dotenv dependency and does not need
 * one for a test file: `KEY=value`, `#` comments, optional `export ` prefix and
 * optional surrounding quotes are the whole grammar used by .env.test.
 * Existing process.env values win — a developer's real shell always beats a file.
 */
function loadEnvFile(filePath: string): void {
  const raw = readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const envTestPath = path.resolve(process.cwd(), '.env.test');
if (existsSync(envTestPath)) loadEnvFile(envTestPath);

// --- Crypto / session material ---------------------------------------------
// Random per process. 32 bytes for AES-256-GCM and the fingerprint HMAC, 48 for
// the session cookie signing secret.
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.FINGERPRINT_KEY ??= randomBytes(32).toString('base64');
process.env.SESSION_SECRET ??= randomBytes(48).toString('base64');

// --- Database ---------------------------------------------------------------
// A dedicated test database. DATABASE_URL is pointed at it ONLY when the
// developer opted in, so an accidental `pnpm test` can never truncate a real
// database — see tests/helpers/db.ts, which refuses to run without this flag.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// --- Noise control ----------------------------------------------------------
// The structured logger is not the subject of most suites; keep stdout readable.
process.env.LOG_LEVEL ??= 'error';

// Vercel/etc. are never "production" under test: assertProductionConfig() must
// stay a no-op, and the dev-only Prisma query logging path is the one we want.
// NODE_ENV is declared read-only on ProcessEnv by @types/node, so it is set
// through vi.stubEnv (which writes the underlying process.env) rather than by
// assignment.
if (process.env.NODE_ENV === undefined) {
  vi.stubEnv('NODE_ENV', 'test');
}
