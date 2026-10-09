/**
 * Audit trail for every admin mutation (spec §15 / §22).
 *
 * The rule the panel enforces: an operator can change money, stock or an
 * order's state, and afterwards there is no question of who did it or why.
 * That is only true if the audit row is written in the SAME transaction as the
 * mutation — a separate write can be lost exactly when it matters most (a
 * rollback, a crash, a pool exhaustion during an incident).
 *
 * `appendAudit(tx, …)` therefore takes a transaction client. `writeAuditLog(…)`
 * exists for events that are not tied to a business mutation at all: a denied
 * authorisation, a code reveal, a read of sensitive material.
 *
 * REDACTION IS NOT OPTIONAL. Metadata is persisted as JSON and read by humans,
 * so anything that could be a redeem code, a card number, a CVV, an OTP or a
 * session token is replaced before it reaches the database. The key list is
 * deliberately aggressive: over-redacting an operator's note is a far smaller
 * harm than persisting a plaintext code in a table that backups copy around.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/db/prisma';
import { logger } from '@/lib/logger';
import { piiHash } from '@/lib/ids';

type AuditClient = Prisma.TransactionClient | PrismaClient;
type MetadataValue = Prisma.InputJsonValue;

/** Key fragments that must never survive into the audit log. */
const SENSITIVE_KEY_FRAGMENTS = [
  'code',
  'ciphertext',
  'password',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'cvv',
  'cvc',
  'pan',
  'cardnumber',
  'card_number',
  'otp',
  'mfasecret',
  'privatekey',
  'credential',
];

export const REDACTED = '[redacted]';
const MAX_DEPTH = 5;
const MAX_STRING = 512;
const MAX_ARRAY = 50;

/**
 * Replaces sensitive values with a fixed marker. Structure and length class are
 * preserved so the log stays readable ("code" -> "[redacted]", not a deleted
 * key), which is what makes the audit trail useful during an investigation.
 */
export function redactAuditValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((entry) => redactAuditValue(entry, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const lowered = key.toLowerCase();
      if (SENSITIVE_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment))) {
        out[key] = REDACTED;
      } else {
        out[key] = redactAuditValue(inner, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function redactAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): MetadataValue | undefined {
  if (!metadata) return undefined;
  return redactAuditValue(metadata) as MetadataValue;
}

export interface AuditEntry {
  /** Human-readable actor label, e.g. "admin:owner@example.com" or "system". */
  actor: string;
  /** The admin's User.id, when the actor is a signed-in operator. */
  actorId?: string | null;
  /** Dotted verb, e.g. "order.refund.requested". */
  action: string;
  /** Entity table name, e.g. "Order". */
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  /** Hashed client IP. Never the raw address. */
  ipHash?: string | null;
}

/** Actor label helper — the audit table's `actor` is a free-text string. */
export function actorLabel(actor: { userId: string; email: string }): string {
  return `admin:${actor.email}`;
}

/**
 * Writes an audit row inside an existing transaction. Use this for every
 * mutation so the audit entry and the change commit or roll back together.
 */
export async function appendAudit(
  tx: AuditClient,
  entry: AuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actor: entry.actor,
      actorId: entry.actorId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      metadata: redactAuditMetadata(entry.metadata),
      ipHash: entry.ipHash ?? null,
    },
  });
}

/**
 * Standalone audit write for events with no accompanying mutation — denied
 * authorisation attempts in particular, which are exactly the ones you want
 * recorded even though nothing else changed.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    await appendAudit(prisma, entry);
  } catch (error) {
    // An audit failure must not mask the original error that triggered it, but
    // it must never be silent either.
    logger.error('Failed to write audit log', {
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Never throws — for paths that are already failing and must not be masked. */
export async function tryWriteAuditLog(entry: AuditEntry): Promise<void> {
  try {
    await appendAudit(prisma, entry);
  } catch (error) {
    logger.error('Failed to write audit log', {
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Hashed client IP for the audit row. Returns null rather than a raw address —
 * the schema has no column for the plaintext and adding one would be the wrong
 * fix for an audit convenience.
 */
export function hashRequestIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  const raw = forwarded?.split(',')[0]?.trim() || headers.get('x-real-ip');
  if (!raw) return null;
  try {
    return piiHash(raw).slice(0, 32);
  } catch {
    // FINGERPRINT_KEY/ENCRYPTION_KEY absent in a local dev shell: the audit row
    // is still written, just without an IP.
    return null;
  }
}