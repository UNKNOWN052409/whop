/**
 * Idempotency ledger (spec §20).
 *
 * The problem: a customer double-clicks "Pay", a mobile network retries, or a
 * proxy replays the request. Each replay must produce ONE payment, not N.
 *
 * The mechanism is the unique index on `IdempotencyKey(scope, key)`:
 *
 *   1. CLAIM   — INSERT (scope, key, requestHash). The index is the lock. The
 *                request whose INSERT wins owns the work; everyone else loses
 *                with Prisma P2002.
 *   2. EXECUTE — the winner runs the handler, then stores the response.
 *   3. REPLAY  — a loser reads the row. Same requestHash -> return the STORED
 *                response. Different requestHash -> DUPLICATE_REQUEST.
 *
 * The losing race (two requests arrive in the same millisecond, neither has
 * finished) is handled by a short bounded poll for the stored response rather
 * than by guessing. If the winner is still running past the poll we return 409
 * with a retry hint instead of executing twice.
 *
 * A CLAIM whose handler throws is RELEASED (the row is deleted) so the customer
 * can retry. The alternative — leaving the row behind — permanently burns the
 * key and turns a transient provider blip into "this customer can never pay".
 * The handler must therefore not have any side effect that outlives its own
 * throw; the checkout handler obeys that by creating the provider checkout
 * last, under an Idempotency-Key of its own.
 */

import { prisma, type Prisma } from '@/db/prisma';
import { AppError } from '@/lib/errors';
import { requestHash as hashRequestBody } from '@/lib/ids';
import { logger } from '@/lib/logger';

/** Keys older than this are forgotten. 24 hours, per spec. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Prisma's unique-constraint violation. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/** How long a loser waits for the winner's stored response, in milliseconds. */
const IN_FLIGHT_POLL_BUDGET_MS = 2_000;
const IN_FLIGHT_POLL_INTERVAL_MS = 120;

export interface IdempotencyHandlerResult<TResponse> {
  /** HTTP status to replay alongside the body. Defaults to 200. */
  statusCode?: number;
  body: TResponse;
}

export interface IdempotencyOptions<TResponse> {
  /**
   * Namespace, so the same key in two flows cannot collide. Use a stable
   * string like `'checkout'`.
   */
  scope: string;
  /** The client's key. Never empty; callers derive one when absent. */
  key: string;
  /**
   * The request body, hashed with a stable stringify so key ORDER does not
   * change the fingerprint. A different body under the same key is a client
   * bug and is rejected loudly.
   */
  requestBody: unknown;
  /** Bound the created key to an order once one exists. */
  orderId?: string;
  /** The work. Runs at most once per (scope, key). */
  handler: () => Promise<IdempotencyHandlerResult<TResponse>>;
}

export interface IdempotencyResult<TResponse> {
  /** True when the response came from the ledger rather than from `handler`. */
  replayed: boolean;
  statusCode: number;
  body: TResponse;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === PRISMA_UNIQUE_VIOLATION;
}

function expiresAtFrom(now: number): Date {
  return new Date(now + IDEMPOTENCY_TTL_MS);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Claim the key. Returns the stored row when we did NOT win the race.
 * `null` means the caller owns the work.
 */
async function tryClaim(
  scope: string,
  key: string,
  hash: string,
  orderId: string | undefined,
  now: number,
): Promise<{ won: boolean; claimId?: string }> {
  try {
    const created = await prisma.idempotencyKey.create({
      data: {
        scope,
        key,
        requestHash: hash,
        ...(orderId ? { orderId } : {}),
        lockedAt: new Date(now),
        expiresAt: expiresAtFrom(now),
      },
      select: { id: true },
    });
    return { won: true, claimId: created.id };
  } catch (error) {
    if (isUniqueViolation(error)) return { won: false };
    throw error;
  }
}

/** Release a claim whose handler failed, so the key is usable again. */
async function releaseClaim(id: string): Promise<void> {
  try {
    await prisma.idempotencyKey.delete({ where: { id } });
  } catch (error) {
    logger.warn('Could not release a failed idempotency claim', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type StoredRow = Prisma.IdempotencyKeyGetPayload<Record<string, never>>;

async function readStored(scope: string, key: string): Promise<StoredRow | null> {
  return prisma.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
}

function duplicateRequestError(detail: Record<string, unknown>): AppError {
  return new AppError(
    'This idempotency key was already used with a different request body.',
    409,
    'DUPLICATE_REQUEST',
    { details: detail },
  );
}

/**
 * Run `handler` at most once per (scope, key).
 *
 * A replay of the SAME request returns the stored response and a `replayed`
 * flag, so the caller can answer 200 rather than re-running side effects. A
 * different body under the same key throws DUPLICATE_REQUEST — replaying it
 * would be undefined behaviour, so we refuse rather than pick a winner.
 */
export async function withIdempotency<TResponse>(
  options: IdempotencyOptions<TResponse>,
): Promise<IdempotencyResult<TResponse>> {
  const { scope, key, requestBody, orderId, handler } = options;
  const trimmedKey = key.trim();
  if (trimmedKey.length === 0) {
    throw new AppError('Idempotency key must not be empty', 400, 'VALIDATION_FAILED');
  }

  const hash = hashRequestBody(requestBody);
  let now = Date.now();

  let claim = await tryClaim(scope, trimmedKey, hash, orderId, now);

  // An expired row is a leftover from >24h ago. The key is free again: drop it
  // and take it over. Bounded to a single takeover so a pathological race
  // cannot spin this function.
  if (!claim.won) {
    const existing = await readStored(scope, trimmedKey);
    if (existing && existing.expiresAt.getTime() <= now) {
      logger.info('Reclaiming an expired idempotency key', { scope, key: trimmedKey });
      await prisma.idempotencyKey
        .delete({ where: { id: existing.id } })
        .catch(() => undefined);
      now = Date.now();
      claim = await tryClaim(scope, trimmedKey, hash, orderId, now);
    }
  }

  if (!claim.won || claim.claimId === undefined) {
    return replayStored<TResponse>(scope, trimmedKey, hash);
  }

  const claimId = claim.claimId;

  // We own the work. If the handler throws, release the claim.
  try {
    const produced = await handler();
    const statusCode = produced.statusCode ?? 200;
    await prisma.idempotencyKey.update({
      where: { id: claimId },
      data: {
        responseJson: produced.body as unknown as Prisma.InputJsonValue,
        statusCode,
        completedAt: new Date(),
      },
    });
    return { replayed: false, statusCode, body: produced.body };
  } catch (error) {
    await releaseClaim(claimId);
    throw error;
  }
}

/**
 * The losing side of the race. Poll briefly for the winner's stored response;
 * return it when it lands, refuse otherwise.
 */
async function replayStored<TResponse>(
  scope: string,
  key: string,
  hash: string,
): Promise<IdempotencyResult<TResponse>> {
  const deadline = Date.now() + IN_FLIGHT_POLL_BUDGET_MS;

  for (;;) {
    const row = await readStored(scope, key);

    if (!row) {
      // The winner failed and released the key. Claim it ourselves rather than
      // tell the customer their request failed for no reason.
      const reclaimed = await tryClaim(scope, key, hash, undefined, Date.now());
      if (reclaimed.won) {
        throw new AppError(
          'The original request failed and released its idempotency claim. Retry the request.',
          409,
          'DUPLICATE_REQUEST',
          { details: { scope, retryable: true } },
        );
      }
      await sleep(IN_FLIGHT_POLL_INTERVAL_MS);
      continue;
    }

    if (row.requestHash !== hash) {
      throw duplicateRequestError({ scope, reason: 'request_hash_mismatch' });
    }

    if (row.completedAt && row.responseJson !== null && row.responseJson !== undefined) {
      return {
        replayed: true,
        statusCode: row.statusCode ?? 200,
        body: row.responseJson as TResponse,
      };
    }

    if (Date.now() >= deadline) {
      throw new AppError(
        'A request with this idempotency key is still being processed. Retry shortly.',
        409,
        'DUPLICATE_REQUEST',
        { details: { scope, reason: 'in_flight' }, retryAfterSeconds: 5 },
      );
    }

    await sleep(IN_FLIGHT_POLL_INTERVAL_MS);
  }
}

/**
 * Best-effort cleanup for expired rows. Safe to call from a cron; it only ever
 * deletes rows that can no longer be replayed.
 */
export async function purgeExpiredIdempotencyKeys(now = new Date()): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lte: now } } });
  if (result.count > 0) {
    logger.info('Purged expired idempotency keys', { count: result.count });
  }
  return result.count;
}