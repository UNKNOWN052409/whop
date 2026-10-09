/**
 * Diagnostic redaction for anything that may leave this process.
 *
 * /api/health and /api/metrics are the two unauthenticated-ish surfaces an
 * operator will paste into a ticket, so every string that reaches them passes
 * through here first. The rule is deliberately blunt: a diagnostic that gets
 * over-redacted is a minor annoyance, a connection string that does not is a
 * credential leak in a support thread.
 *
 * This is defence in depth. `logger.ts` already redacts by key name; this
 * module catches secrets that arrive inside free text (an error message that
 * quotes a URL, a driver message that echoes a DSN).
 */

/** `scheme://user:password@host` -> `scheme://[redacted]@host`. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)(:[^/\s@]*)?@/gi;

/** Provider-shaped secrets that are recognisable by prefix. */
const PREFIXED_SECRETS =
  /\b(ws_[A-Za-z0-9_-]{6,}|re_[A-Za-z0-9_-]{6,}|sk_(?:live|test)_[A-Za-z0-9_-]{6,}|whsec_[A-Za-z0-9_-]{6,}|AKIA[A-Z0-9]{10,})\b/g;

/** Long hex blobs: encryption keys, fingerprints, session hashes. */
const LONG_HEX = /\b[A-Fa-f0-9]{32,}\b/g;

/** Long base64url/base64 blobs: JWTs, signatures, session cookie values. */
const LONG_BASE64 = /\b[A-Za-z0-9+/=_-]{48,}\b/g;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export const REDACTED = '[redacted]';

/**
 * Strip anything that looks like a credential out of free text and normalise
 * control characters. Always returns a bounded-length string.
 */
export function redactText(input: string, maxLength = 300): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  const cleaned = input
    .replace(CONTROL_CHARS, ' ')
    .replace(URL_CREDENTIALS, (_match, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(PREFIXED_SECRETS, REDACTED)
    .replace(LONG_HEX, REDACTED)
    .replace(LONG_BASE64, REDACTED)
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/**
 * Safe message for an unknown thrown value. Never throws itself.
 *
 * `error.message` is the useful part; stack traces stay in the log sink, where
 * they are access-controlled, rather than in an HTTP response body.
 */
export function safeDiagnostic(error: unknown, maxLength = 300): string {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error === 'string') return redactText(error, maxLength) || 'unknown error';
  if (error instanceof Error) return redactText(`${error.name}: ${error.message}`, maxLength);
  if (typeof error === 'object') {
    try {
      const json = JSON.stringify(error);
      return redactText(json, maxLength) || 'unknown error';
    } catch {
      return 'unserialisable error';
    }
  }
  return redactText(String(error), maxLength);
}

/**
 * Recursively redact an arbitrary context object. Used for alert payloads,
 * which are persisted to AuditLog and may be surfaced on /api/health?verbose=1.
 */
export function redactContext<T>(value: T, depth = 0): T {
  if (depth > 4) return '[truncated]' as unknown as T;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value, 200) as unknown as T;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return safeDiagnostic(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactContext(item, depth + 1)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactContext(inner, depth + 1);
    }
    return out as unknown as T;
  }
  return String(value) as unknown as T;
}