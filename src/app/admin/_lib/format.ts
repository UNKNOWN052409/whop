/**
 * Presentation helpers for the admin panel.
 *
 * Two rules encoded here rather than repeated across templates:
 *
 *  1. `displayPriceValue()` is the ONLY way this panel renders a product's
 *     commercial terms. It emits "Price $3.00 · Value $1.00". There is no code
 *     path in this panel that produces "$3 redeem code for $1", because the
 *     catalog is a MARKUP business and the premium is the product.
 *
 *  2. Nothing in this file can render a redeem code. Codes arrive here as the
 *     already-truncated `codeLast4` column and leave as "••••WXYZ".
 */

import { formatMoney } from '@/lib/money';
import { maskCode } from '@/lib/ids';

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** The single sanctioned product presentation: price first, value second. */
export function displayPriceValue(
  sellingPriceMinor: number,
  faceValueMinor: number,
  currency: string,
): string {
  return `Price ${formatMoney(sellingPriceMinor, currency)} · Value ${formatMoney(faceValueMinor, currency)}`;
}

/** Signed basis points rendered as a percentage with its direction in words. */
export function describeDiscountBps(discountBps: number): string {
  const magnitude = (Math.abs(discountBps) / 100).toFixed(2);
  if (discountBps < 0) return `${magnitude}% premium over face value`;
  if (discountBps > 0) return `${magnitude}% below face value`;
  return 'priced at face value';
}

export function describeMarginBps(marginBps: number): string {
  const magnitude = (Math.abs(marginBps) / 100).toFixed(2);
  if (marginBps < 0) return `${magnitude}% gross margin (LOSING MONEY)`;
  return `${magnitude}% gross margin`;
}

/** Basis points as a plain signed number, e.g. "-20000" -> "-200.00%". */
export function bpsLabel(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/**
 * The only representation of a redeem code that leaves this module.
 * `codeLast4` is the last four characters stored in plaintext alongside the
 * ciphertext; the rest of the code is never loaded into a page.
 */
export function maskedCode(codeLast4: string | null | undefined): string {
  if (!codeLast4 || codeLast4.length === 0) return '—';
  return maskCode(codeLast4);
}

// ---------------------------------------------------------------------------
// Dates & numbers
// ---------------------------------------------------------------------------

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${DATE_TIME.format(date)} UTC`;
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 10);
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** Signed integer minor units with an explicit + for gains. */
export function signedMoney(minor: number, currency: string): string {
  return minor > 0 ? `+${formatMoney(minor, currency)}` : formatMoney(minor, currency);
}

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-800 text-slate-200 ring-slate-700',
  good: 'bg-emerald-900/60 text-emerald-200 ring-emerald-700',
  warn: 'bg-amber-900/60 text-amber-200 ring-amber-700',
  bad: 'bg-rose-900/60 text-rose-200 ring-rose-700',
  info: 'bg-sky-900/60 text-sky-200 ring-sky-700',
};

export function badgeClass(tone: BadgeTone): string {
  return `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${TONE_CLASSES[tone]}`;
}

const ORDER_TONES: Record<string, BadgeTone> = {
  CREATED: 'neutral',
  PAYMENT_PENDING: 'info',
  PAYMENT_VERIFIED: 'info',
  FULFILLMENT_PENDING: 'info',
  CODE_RESERVED: 'info',
  CODE_DELIVERED: 'good',
  COMPLETED: 'good',
  PAYMENT_FAILED: 'bad',
  PAYMENT_EXPIRED: 'warn',
  PAYMENT_REVERSED: 'bad',
  FULFILLMENT_FAILED: 'bad',
  REFUND_PENDING: 'warn',
  REFUNDED: 'warn',
  MANUAL_REVIEW: 'warn',
  CANCELLED: 'neutral',
};

const PAYMENT_TONES: Record<string, BadgeTone> = {
  CREATED: 'neutral',
  PENDING: 'info',
  REQUIRES_ACTION: 'info',
  AUTHORIZED: 'info',
  PAID: 'good',
  FAILED: 'bad',
  CANCELED: 'neutral',
  EXPIRED: 'warn',
  PARTIALLY_REFUNDED: 'warn',
  REFUNDED: 'warn',
  DISPUTED: 'bad',
  REVERSED: 'bad',
};

const FULFILLMENT_TONES: Record<string, BadgeTone> = {
  PENDING: 'neutral',
  RUNNING: 'info',
  SUCCEEDED: 'good',
  FAILED: 'bad',
  DEAD_LETTER: 'bad',
};

const EMAIL_TONES: Record<string, BadgeTone> = {
  QUEUED: 'neutral',
  SENT: 'info',
  DELIVERED: 'good',
  FAILED: 'bad',
  SUPPRESSED: 'warn',
};

const INVENTORY_TONES: Record<string, BadgeTone> = {
  AVAILABLE: 'good',
  RESERVED: 'info',
  ASSIGNED: 'info',
  DELIVERED: 'neutral',
  REVOKED: 'bad',
};

export function orderTone(status: string): BadgeTone {
  return ORDER_TONES[status] ?? 'neutral';
}
export function paymentTone(status: string): BadgeTone {
  return PAYMENT_TONES[status] ?? 'neutral';
}
export function fulfillmentTone(status: string): BadgeTone {
  return FULFILLMENT_TONES[status] ?? 'neutral';
}
export function emailTone(status: string): BadgeTone {
  return EMAIL_TONES[status] ?? 'neutral';
}
export function inventoryTone(status: string): BadgeTone {
  return INVENTORY_TONES[status] ?? 'neutral';
}

/** Turns SCREAMING_SNAKE into "Screaming snake" for a table column header. */
export function humaniseToken(token: string): string {
  return token
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Renders an unknown JSON field without ever dumping it into the page. */
export function shortJson(value: unknown, maxLength = 160): string {
  if (value === null || value === undefined) return '—';
  try {
    const text = JSON.stringify(value);
    if (!text) return '—';
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return '[unserialisable]';
  }
}