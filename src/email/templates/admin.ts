/**
 * Internal operator notifications.
 *
 * These fire when the machine cannot finish a job: a paid order whose code was
 * never assigned, an order parked for risk review, a reconciliation mismatch,
 * or a product that has run out of inventory. They are the alert that turns a
 * silent failure into a caught one.
 *
 * REDEEM CODES NEVER APPEAR HERE. An internal notification is forwarded to
 * Slack/Teams/PagerDuty by most operators, which would leak a live code into a
 * third-party system. `stripSensitiveFields` is a runtime guard against a
 * future caller passing one in through `summary` or `details`.
 */

import { appConfig } from '@/lib/env';
import {
  buttonHtml,
  calloutHtml,
  detailRowsHtml,
  escapeHtml,
  headingHtml,
  mutedParagraphHtml,
  paragraphHtml,
  renderHtmlLayout,
} from './layout';
import type { RenderedEmail } from './delivery';

export type AdminAlertType =
  | 'FULFILLMENT_FAILED'
  | 'MANUAL_REVIEW'
  | 'RECONCILIATION_MISMATCH'
  | 'INVENTORY_DEPLETED';

export interface AdminAlertDetail {
  label: string;
  value: string;
}

export interface AdminAlertInput {
  type: AdminAlertType;
  /** Subject line, without the bracketed type prefix. */
  title: string;
  /** One-paragraph explanation. Redacted before render. */
  summary: string;
  orderReference?: string | null;
  orderId?: string | null;
  productName?: string | null;
  customerEmail?: string | null;
  details?: readonly AdminAlertDetail[];
  /** What the operator should do next. */
  recommendation?: string | null;
  occurredAt?: Date;
  brand: string;
}

const TYPE_LABEL: Record<AdminAlertType, string> = {
  FULFILLMENT_FAILED: 'Fulfillment failed',
  MANUAL_REVIEW: 'Manual review required',
  RECONCILIATION_MISMATCH: 'Reconciliation mismatch',
  INVENTORY_DEPLETED: 'Inventory depleted',
};

/**
 * Field names that must never appear in an operator notification. Matching is
 * done on the label because that is what a careless caller actually types.
 *
 * Deliberately NOT a bare /code/i: "Error code", "Exit code" and "Code count"
 * are useful to an operator and leak nothing. A label that is *just* "code" is
 * treated as sensitive (see SENSITIVE_EXACT).
 */
const SENSITIVE_LABEL =
  /(redeem\s*code|secret|token|otp|\botp\b|cvv|cvc|card\s*number|\bpan\b|passw|credential|ciphertext|plaintext|api\s*key|access\s*key)/i;
const SENSITIVE_EXACT = /^(code|codes|your\s*code|redeem\s*code)s?$/i;

export function stripSensitiveFields(details: readonly AdminAlertDetail[]): AdminAlertDetail[] {
  return details.filter(
    (detail) => !SENSITIVE_EXACT.test(detail.label.trim()) && !SENSITIVE_LABEL.test(detail.label),
  );
}

/**
 * Redacts a free-text summary that quotes a value under a sensitive label,
 * e.g. "redeem code: ABCD-EFGH". Deliberately narrow so "error code: 42"
 * survives into the operator's inbox.
 */
export function redactSensitiveText(text: string): string {
  return text.replace(
    /\b(redeem\s+code|secret|token|otp|cvv|card\s*number)\s*[:=]\s*\S+/gi,
    '$1: [redacted]',
  );
}

/** Link into the operator dashboard. Uses the order reference when available. */
export function adminOrderLink(orderReference?: string | null, orderId?: string | null): string | null {
  const base = appConfig.url.replace(/\/+$/, '');
  if (orderReference) return `${base}/admin/orders/${encodeURIComponent(orderReference)}`;
  if (orderId) return `${base}/admin/orders/${encodeURIComponent(orderId)}`;
  return `${base}/admin/orders`;
}

export function renderAdminAlert(input: AdminAlertInput): RenderedEmail {
  const occurredAt = input.occurredAt ?? new Date();
  const typeLabel = TYPE_LABEL[input.type];
  const subject = `[${typeLabel}] ${input.orderReference ? `${input.orderReference} — ` : ''}${input.title}`;

  const summary = redactSensitiveText(input.summary);
  const details = stripSensitiveFields(input.details ?? []);

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Alert', value: typeLabel },
    { label: 'Order', value: input.orderReference ?? input.orderId ?? '—' },
  ];
  if (input.productName) rows.push({ label: 'Product', value: input.productName });
  if (input.customerEmail) rows.push({ label: 'Customer', value: input.customerEmail });
  rows.push({ label: 'Occurred at', value: occurredAt.toISOString() });
  for (const detail of details) rows.push({ label: detail.label, value: detail.value });

  const link = adminOrderLink(input.orderReference, input.orderId);

  // --- text ---------------------------------------------------------------
  const textLines: string[] = [];
  textLines.push(`${typeLabel.toUpperCase()}`);
  textLines.push(`Order: ${input.orderReference ?? input.orderId ?? '—'}`);
  if (input.productName) textLines.push(`Product: ${input.productName}`);
  if (input.customerEmail) textLines.push(`Customer: ${input.customerEmail}`);
  textLines.push(`Occurred at: ${occurredAt.toISOString()}`);
  textLines.push('');
  textLines.push(summary);
  if (details.length > 0) {
    textLines.push('');
    for (const detail of details) textLines.push(`${detail.label}: ${detail.value}`);
  }
  if (input.recommendation) {
    textLines.push('');
    textLines.push(`Next step: ${input.recommendation}`);
  }
  if (link) {
    textLines.push('');
    textLines.push(`Open in dashboard: ${link}`);
  }
  textLines.push('');
  textLines.push('This notification never contains redeem codes. Look them up in the dashboard.');

  // --- html ---------------------------------------------------------------
  const blocks: string[] = [];
  blocks.push(calloutHtml(`<p style="margin:0;font-family:inherit;font-size:14px;line-height:22px;color:inherit;"><strong>${escapeHtml(typeLabel)}</strong></p>`));
  blocks.push(paragraphHtml(escapeHtml(summary)));
  blocks.push(detailRowsHtml(rows));
  if (details.length > 0) blocks.push(headingHtml('Details'));
  if (details.length > 0) {
    blocks.push(detailRowsHtml(details.map((d) => ({ label: d.label, value: d.value }))));
  }
  if (input.recommendation) {
    blocks.push(headingHtml('Next step'));
    blocks.push(paragraphHtml(escapeHtml(input.recommendation)));
  }
  if (link) {
    blocks.push(buttonHtml('Open order in dashboard', link));
    blocks.push(mutedParagraphHtml(escapeHtml(link)));
  }
  blocks.push(
    mutedParagraphHtml(
      'This notification never contains redeem codes. Look them up in the dashboard.',
    ),
  );

  const html = renderHtmlLayout({
    title: `${typeLabel}${input.orderReference ? ` · ${input.orderReference}` : ''}`,
    preheader: `${typeLabel}: ${summary.slice(0, 120)}`,
    bodyHtml: blocks.join('\n'),
    brand: input.brand,
    footerNote: 'Internal notification. Not for forwarding outside the operations team.',
  });

  return { subject, text: textLines.join('\n'), html };
}

// --- Typed wrappers used by the fulfillment / orders / reconciliation flows --

export interface FulfillmentFailedAlertInput
  extends Omit<AdminAlertInput, 'type' | 'title'> {
  reason: string;
}

export function renderFulfillmentFailedAlert(
  input: FulfillmentFailedAlertInput,
): RenderedEmail {
  return renderAdminAlert({
    ...input,
    type: 'FULFILLMENT_FAILED',
    title: 'Paid order has not received its code',
    summary: `${input.summary}\n\nReported reason: ${input.reason}`.trim(),
    recommendation:
      input.recommendation ??
      'Assign or re-import a code, then resend the delivery email. If no code is available, refund the customer.',
  });
}

export interface ManualReviewAlertInput extends Omit<AdminAlertInput, 'type' | 'title'> {
  riskLevel?: string | null;
}

export function renderManualReviewAlert(input: ManualReviewAlertInput): RenderedEmail {
  const details = [...(input.details ?? [])];
  if (input.riskLevel) details.push({ label: 'Risk level', value: input.riskLevel });
  return renderAdminAlert({
    ...input,
    details,
    type: 'MANUAL_REVIEW',
    title: 'Order parked for manual review',
    recommendation:
      input.recommendation ??
      'Review the payment and customer history, then approve fulfillment or refund from the dashboard.',
  });
}

export interface ReconciliationMismatchAlertInput extends Omit<AdminAlertInput, 'type' | 'title'> {
  mismatchType?: string | null;
  providerPaymentId?: string | null;
}

export function renderReconciliationMismatchAlert(
  input: ReconciliationMismatchAlertInput,
): RenderedEmail {
  const details = [...(input.details ?? [])];
  if (input.mismatchType) details.push({ label: 'Mismatch type', value: input.mismatchType });
  if (input.providerPaymentId) {
    details.push({ label: 'Provider payment id', value: input.providerPaymentId });
  }
  return renderAdminAlert({
    ...input,
    details,
    type: 'RECONCILIATION_MISMATCH',
    title: 'Provider and ledger disagree',
    recommendation:
      input.recommendation ??
      'Compare the provider record with our ledger before refunding or re-charging. Do not settle from the webhook alone.',
  });
}

export interface InventoryDepletedAlertInput extends Omit<AdminAlertInput, 'type' | 'title'> {
  remainingCount?: number | null;
}

export function renderInventoryDepletedAlert(input: InventoryDepletedAlertInput): RenderedEmail {
  const details = [...(input.details ?? [])];
  if (typeof input.remainingCount === 'number') {
    details.push({ label: 'Remaining in stock', value: String(input.remainingCount) });
  }
  return renderAdminAlert({
    ...input,
    details,
    type: 'INVENTORY_DEPLETED',
    title: 'Product has no available codes',
    recommendation:
      input.recommendation ??
      'Unpublish the product and import new codes. Customers who paid during the gap must be refunded.',
  });
}