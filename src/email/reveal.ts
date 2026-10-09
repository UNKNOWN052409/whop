/**
 * Reveal adapter: the single seam between email delivery and the inventory
 * workstream's decryption module.
 *
 * The email service must not know how a code is stored, which supplier issued
 * it, or whether a reservation has expired — it only needs "the plaintext code
 * plus the fields the customer email has to display". This adapter isolates
 * that contract, so a change in src/inventory/reveal.ts touches one file here
 * instead of the delivery pipeline.
 *
 * SECURITY: values returned from here are plaintext redeem codes. They live in
 * memory for the duration of one send and go nowhere else — not to the logger,
 * not to the database, not to an error message.
 */

import { revealCodeForOrder } from '@/inventory/reveal';
import { codeLast4 } from '@/lib/crypto';
import { AppError } from '@/lib/errors';
import type { DeliveryCodeView } from './templates/delivery';

export type { DeliveryCodeView };

function toNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toMinorUnits(value: unknown): number | null {
  // Integer minor units only. A float here would mean the upstream module is
  // doing money math wrong, and we refuse to carry that into an email.
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function normalizeOne(value: unknown): DeliveryCodeView | null {
  if (typeof value === 'string') {
    const code = value.trim();
    return code ? { code, last4: codeLast4(code), redemptionInstructions: null, region: null, currency: null, faceValueMinor: null, expiresAt: null } : null;
  }

  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const code =
    toNonEmptyString(record.code) ??
    toNonEmptyString(record.redeemCode) ??
    toNonEmptyString(record.plainCode) ??
    toNonEmptyString(record.plaintext);
  if (!code) return null;

  return {
    code,
    last4: toNonEmptyString(record.last4) ?? codeLast4(code),
    redemptionInstructions:
      toNonEmptyString(record.redemptionInstructions) ?? toNonEmptyString(record.instructions),
    region: toNonEmptyString(record.region),
    currency: toNonEmptyString(record.currency),
    faceValueMinor: toMinorUnits(record.faceValueMinor),
    expiresAt: toDate(record.expiresAt),
  };
}

/**
 * Turns whatever `revealCodeForOrder` resolved with into a list of displayable
 * codes. Anything unrecognised is dropped rather than coerced — a code field
 * that is not a string is a bug we want surfaced, not an email containing
 * "[object Object]".
 */
export function normalizeRevealedCodes(value: unknown): DeliveryCodeView[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value
      .map(normalizeOne)
      .filter((code): code is DeliveryCodeView => code !== null);
  }
  if (typeof value === 'object' && Array.isArray((value as Record<string, unknown>).codes)) {
    return normalizeRevealedCodes((value as Record<string, unknown>).codes);
  }
  const single = normalizeOne(value);
  return single ? [single] : [];
}

/**
 * Reveal every redeem code assigned to an order.
 *
 * Throws CRITICAL_FULFILLMENT_ERROR when the order has paid but nothing can be
 * delivered — a customer must never receive a "thanks for your order" email
 * containing no code, and the fulfillment job must not advance to CODE_DELIVERED.
 */
export async function revealCodesForOrder(orderId: string): Promise<DeliveryCodeView[]> {
  let raw: unknown;
  try {
    raw = await revealCodeForOrder(orderId);
  } catch (error) {
    // Never surface the underlying message: a decryption failure can echo the
    // ciphertext, and the inventory module's error text is not ours to publish.
    throw new AppError(
      'Failed to decrypt the redeem code for this order.',
      500,
      'CRITICAL_FULFILLMENT_ERROR',
      { details: { stage: 'reveal' }, cause: error },
    );
  }

  const codes = normalizeRevealedCodes(raw);
  if (codes.length === 0) {
    throw new AppError(
      'No redeem code is assigned to this order, so the delivery email cannot be produced.',
      409,
      'CRITICAL_FULFILLMENT_ERROR',
      { details: { stage: 'reveal', reason: 'no-assigned-code' } },
    );
  }
  return codes;
}