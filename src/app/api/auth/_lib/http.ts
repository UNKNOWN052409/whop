/**
 * Shared plumbing for the `/api/auth/*` routes.
 *
 * Local to the auth route tree on purpose: nothing outside it should depend on
 * how these endpoints phrase an error.
 */

import { AppError, isAppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

/**
 * Turns anything thrown into a JSON response.
 *
 * Only an `AppError`'s own message crosses the boundary. Anything else becomes a
 * flat 500 with no detail: stack traces, SQL and provider URLs must not reach a
 * client, and an auth endpoint's error shape must not vary with its cause.
 */
export function jsonError(error: unknown, fallbackMessage = 'Something went wrong'): Response {
  if (isAppError(error)) {
    if (error.statusCode >= 500) {
      logger.error('Auth endpoint failed', {
        code: error.code,
        status: error.statusCode,
        error: error.message,
      });
    }
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (error.retryAfterSeconds) headers['Retry-After'] = String(error.retryAfterSeconds);
    return Response.json(error.toJSON(), { status: error.statusCode, headers });
  }

  logger.error('Auth endpoint threw an unexpected error', {
    error: error instanceof Error ? error.message : String(error),
  });
  return Response.json(
    { error: fallbackMessage, code: 'INTERNAL_ERROR' },
    { status: 500, headers: { 'Cache-Control': 'no-store' } },
  );
}

export function jsonOk(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Parses a JSON body, refusing anything that is not a plain object. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new AppError('Request body must be JSON', 400, 'VALIDATION_FAILED');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('Request body must be a JSON object', 400, 'VALIDATION_FAILED');
  }
  return parsed as Record<string, unknown>;
}

/** A trimmed string field, or validation failure. Never echoes the input back. */
export function requireString(
  body: Record<string, unknown>,
  field: string,
  options: { maxLength?: number; minLength?: number } = {},
): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new AppError(`${field} is required`, 400, 'VALIDATION_FAILED');
  }
  const trimmed = value.trim();
  const max = options.maxLength ?? 512;
  if (trimmed.length < (options.minLength ?? 1) || trimmed.length > max) {
    throw new AppError(
      `${field} must be between ${options.minLength ?? 1} and ${max} characters`,
      400,
      'VALIDATION_FAILED',
    );
  }
  return trimmed;
}

/** A 429 with the standard shape, built from a rate-limit result. */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: 'Too many attempts. Try again later.', code: 'RATE_LIMITED', retryAfterSeconds },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds), 'Cache-Control': 'no-store' } },
  );
}
