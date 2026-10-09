/**
 * Typed application errors.
 *
 * `code` is stable and machine-readable for the client and for alerting;
 * `message` is safe to show a human. Anything thrown that is not an AppError
 * is treated as an unexpected fault and returned as a generic 500 — internal
 * detail (stack traces, SQL, provider URLs) never crosses the boundary.
 */

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INSUFFICIENT_INVENTORY'
  | 'PRODUCT_UNAVAILABLE'
  | 'PAYMENT_NOT_CONFIGURED'
  | 'PAYMENT_METHOD_UNSUPPORTED'
  | 'PAYMENT_CREATE_FAILED'
  | 'PAYMENT_VERIFICATION_FAILED'
  | 'INVALID_SIGNATURE'
  | 'REPLAY_DETECTED'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'DUPLICATE_REQUEST'
  | 'EMAIL_NOT_CONFIGURED'
  | 'EMAIL_SEND_FAILED'
  | 'RATE_LIMITED'
  | 'INVALID_STATE_TRANSITION'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'CRITICAL_FULFILLMENT_ERROR'
  | 'INTERNAL_ERROR';

export interface AppErrorOptions {
  /** Structured, redacted context for logs and for the client in dev only. */
  details?: Record<string, unknown>;
  /** Seconds to wait before retrying, surfaced for 429s. */
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(message: string, statusCode: number, code: ErrorCode, options?: AppErrorOptions) {
    super(message, { cause: options?.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = options?.details;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  /** True for faults that should page a human rather than just log. */
  get isCritical(): boolean {
    return (
      this.code === 'CRITICAL_FULFILLMENT_ERROR' ||
      this.code === 'PROVIDER_UNAVAILABLE' ||
      this.code === 'INVALID_SIGNATURE' ||
      this.code === 'AMOUNT_MISMATCH' ||
      this.code === 'CURRENCY_MISMATCH' ||
      this.code === 'INSUFFICIENT_INVENTORY'
    );
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      ...(this.retryAfterSeconds ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
    };
  }
}

export const errors = {
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError(message, 400, 'VALIDATION_FAILED', { details }),

  notFound: (what: string) => new AppError(`${what} not found`, 404, 'NOT_FOUND'),

  unauthorized: (message = 'Authentication required') =>
    new AppError(message, 401, 'UNAUTHORIZED'),

  forbidden: (message = 'You do not have access to this resource') =>
    new AppError(message, 403, 'FORBIDDEN'),

  rateLimited: (retryAfterSeconds = 60) =>
    new AppError('Too many requests', 429, 'RATE_LIMITED', { retryAfterSeconds }),

  providerNotConfigured: (provider: string) =>
    new AppError(
      `${provider} is NOT CONFIGURED. Set its environment variables to enable it.`,
      503,
      'PAYMENT_NOT_CONFIGURED',
      { details: { provider } },
    ),

  insufficientInventory: (productId: string) =>
    new AppError('This product is temporarily out of stock', 409, 'INSUFFICIENT_INVENTORY', {
      details: { productId },
    }),

  criticalFulfillment: (message: string, details?: Record<string, unknown>) =>
    new AppError(message, 500, 'CRITICAL_FULFILLMENT_ERROR', { details }),
};

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}