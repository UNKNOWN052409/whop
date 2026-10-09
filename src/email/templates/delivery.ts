/**
 * The customer-facing delivery email (spec §12).
 *
 * THE ONE RULE THIS FILE EXISTS TO PROTECT
 * ----------------------------------------
 * This is a MARKUP business. The customer pays MORE than face value: a $1
 * redeem code costs $3. Both numbers are always stated, and they are never
 * inverted. There is deliberately no code path in this file that can render
 * "$3 redeem code for $1" — the price and the value are separate variables and
 * each is labelled with its own money formatter call.
 *
 * SECURITY: this template is one of exactly two places where a plaintext redeem
 * code exists in the system (the other is the outbound provider request). It
 * must never be logged, never be cached, and never be included in an error
 * message. `assertRenderedCarriesCode` exists purely as a tripwire.
 */

import { formatMoney } from '@/lib/money';
import {
  calloutHtml,
  codeBlockHtml,
  detailRowsHtml,
  escapeHtml,
  formatDate,
  headingHtml,
  mutedParagraphHtml,
  paragraphHtml,
  renderHtmlLayout,
} from './layout';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** One plaintext redeem code plus the denormalised display fields it needs. */
export interface DeliveryCodeView {
  /** PLAINTEXT. Never logged, never persisted by the caller. */
  code: string;
  /** Masked form (last 4). Kept so a support agent can match a code safely. */
  last4: string;
  redemptionInstructions: string | null;
  region: string | null;
  currency: string | null;
  faceValueMinor: number | null;
  expiresAt: Date | null;
}

export interface DeliveryEmailInput {
  orderReference: string;
  productName: string;
  currency: string;
  /** Per-code face value, e.g. 100 = $1.00. */
  faceValueMinor: number;
  /** Per-code price paid by the customer, e.g. 300 = $3.00. */
  sellingPriceMinor: number;
  /** Total charged for the order. Authoritative for the "you paid" line. */
  totalMinor: number;
  quantity: number;
  region: string;
  codes: readonly DeliveryCodeView[];
  brand: string;
  supportEmail: string | null;
}

function codeCurrency(input: DeliveryEmailInput, code: DeliveryCodeView): string {
  return code.currency ?? input.currency;
}

function codeFaceValue(input: DeliveryEmailInput, code: DeliveryCodeView): number {
  return code.faceValueMinor ?? input.faceValueMinor;
}

/** Total face value across every code, in integer minor units. */
function totalFaceValueMinor(input: DeliveryEmailInput): number {
  return input.codes.reduce((sum, code) => sum + codeFaceValue(input, code), 0);
}

function codeRegion(input: DeliveryEmailInput, code: DeliveryCodeView): string {
  return code.region ?? input.region;
}

const DEFAULT_INSTRUCTIONS =
  'Go to the redemption page for this product, choose "Redeem code", and enter the code exactly as shown, including any dashes. ' +
  'Codes are case-insensitive but the dashes are required.';

function supportLine(supportEmail: string | null, orderReference: string): string {
  return supportEmail
    ? `Reply to this email or contact ${supportEmail} and include order ${orderReference}.`
    : `Reply directly to this email and a human will help. Include order ${orderReference}.`;
}

export function renderDeliveryEmail(input: DeliveryEmailInput): RenderedEmail {
  const { orderReference, productName, currency, totalMinor, quantity, brand } = input;
  const codeCount = input.codes.length;
  const totalValue = totalFaceValueMinor(input);

  // The two money strings are produced independently and never reused for the
  // other one. That is deliberate: sharing a variable is how this gets inverted.
  const paidText = formatMoney(totalMinor, currency);
  const valueText = formatMoney(totalValue, currency);

  const subject = `Your redeem code for ${productName} (order ${orderReference})`;

  const lines: string[] = [];
  lines.push('Hi,');
  lines.push('');
  lines.push(
    `Thanks for your order. Your redeem code${
      codeCount === 1 ? ' is' : codeCount > 1 ? 's are' : ' could not be prepared'
    } below.`,
  );
  lines.push('');
  // The headline statement. Price first, value second — always in that order.
  lines.push(
    `You paid ${paidText} and received a redeem code worth ${valueText}.`,
  );
  lines.push('');
  lines.push(`ORDER ${orderReference}`);
  lines.push(`Product:      ${productName}`);
  lines.push(`You paid:     ${paidText}`);
  lines.push(`Code value:   ${valueText}`);
  lines.push(`Region:       ${input.region}`);
  if (quantity > 1) lines.push(`Quantity:     ${quantity}`);
  lines.push('');

  input.codes.forEach((code, index) => {
    const label = codeCount > 1 ? `REDEEM CODE ${index + 1} OF ${codeCount}` : 'YOUR REDEEM CODE';
    lines.push(label);
    lines.push(code.code);
    lines.push('');
    lines.push(`This code is worth ${formatMoney(codeFaceValue(input, code), codeCurrency(input, code))}.`);
    lines.push('');
    lines.push('HOW TO REDEEM');
    lines.push(code.redemptionInstructions ?? DEFAULT_INSTRUCTIONS);
    lines.push('');
    const region = codeRegion(input, code);
    lines.push('REGION RESTRICTIONS');
    lines.push(
      `This code is valid only for the ${region} region. The account redeeming it must be registered in ${region}; a mismatch will be refused at redemption.`,
    );
    lines.push('');
    if (code.expiresAt) {
      lines.push(
        `This code expires on ${formatDate(code.expiresAt)}. After that date it can no longer be redeemed — contact support before then if you have not used it.`,
      );
      lines.push('');
    }
  });

  lines.push('NEED HELP?');
  lines.push(supportLine(input.supportEmail, orderReference));
  lines.push('');
  lines.push('Keep this email — it is the only place your code appears.');
  lines.push('');
  lines.push(`— ${brand}`);

  const text = lines.join('\n');

  // --- HTML ---------------------------------------------------------------

  const htmlRows: Array<{ label: string; value: string }> = [
    { label: 'Order reference', value: orderReference },
    { label: 'Product', value: productName },
    { label: 'You paid', value: paidText },
    { label: 'Code value', value: valueText },
    { label: 'Region', value: input.region },
  ];
  if (quantity > 1) htmlRows.push({ label: 'Quantity', value: String(quantity) });

  const blocks: string[] = [];
  blocks.push(paragraphHtml('Thanks for your order — your redeem code is below.'));
  blocks.push(
    paragraphHtml(
      `<strong>You paid ${escapeHtml(paidText)}</strong> and received a redeem code worth <strong>${escapeHtml(valueText)}</strong>.`,
    ),
  );
  blocks.push(detailRowsHtml(htmlRows));

  input.codes.forEach((code, index) => {
    const label = codeCount > 1 ? `Redeem code ${index + 1} of ${codeCount}` : 'Your redeem code';
    blocks.push(codeBlockHtml(code.code, label));
    blocks.push(
      mutedParagraphHtml(
        `This code is worth ${escapeHtml(formatMoney(codeFaceValue(input, code), codeCurrency(input, code)))}.`,
      ),
    );
    blocks.push(headingHtml('How to redeem'));
    blocks.push(
      paragraphHtml(escapeHtml(code.redemptionInstructions ?? DEFAULT_INSTRUCTIONS)),
    );
    const region = codeRegion(input, code);
    blocks.push(headingHtml('Region restrictions'));
    blocks.push(
      calloutHtml(
        `<p style="margin:0;font-family:inherit;font-size:13px;line-height:20px;color:inherit;">Valid only for the <strong>${escapeHtml(region)}</strong> region. The account redeeming it must be registered in ${escapeHtml(region)}; a mismatch is refused at redemption.</p>`,
      ),
    );
    if (code.expiresAt) {
      blocks.push(
        mutedParagraphHtml(
          `Expires on <strong>${escapeHtml(formatDate(code.expiresAt))}</strong>. Contact support before then if you have not used it.`,
        ),
      );
    }
  });

  blocks.push(headingHtml('Need help?'));
  blocks.push(
    paragraphHtml(
      input.supportEmail
        ? `Reply to this email or contact <a href="mailto:${escapeHtml(input.supportEmail)}" style="color:${'#1a56db'};">${escapeHtml(input.supportEmail)}</a>. Include order ${escapeHtml(orderReference)}.`
        : `Reply directly to this email. Include order ${escapeHtml(orderReference)} so we can find your payment.`,
    ),
  );
  blocks.push(
    mutedParagraphHtml('Keep this email — it is the only place your code appears.'),
  );

  const footerNote = input.supportEmail
    ? `Questions? Reply to this email or contact ${input.supportEmail}.`
    : 'Questions? Just reply to this email.';

  const html = renderHtmlLayout({
    title: 'Your redeem code',
    // Preheader: the price/value pair, which is what a customer wants to see in
    // the inbox list. Text only — there is no tracking pixel in this template.
    preheader: `You paid ${paidText} · code worth ${valueText} · order ${orderReference}`,
    bodyHtml: blocks.join('\n'),
    brand,
    footerNote,
  });

  assertRenderedCarriesCode(input, text, html);
  return { subject, text, html };
}

/**
 * Tripwire. A customer who receives an email without a code has paid for
 * nothing, so a regression here must fail loudly in development and in the
 * job runner rather than ship a "thanks for your order" with no payload.
 */
function assertRenderedCarriesCode(
  input: DeliveryEmailInput,
  text: string,
  html: string,
): void {
  if (input.codes.length === 0) return;
  for (const code of input.codes) {
    if (!code.code) continue;
    if (!text.includes(code.code)) {
      throw new Error(`Delivery email for ${input.orderReference} is missing a redeem code`);
    }
    // The HTML carries the escaped form, so compare against the escaped text.
    if (!html.includes(escapeHtml(code.code))) {
      throw new Error(`Delivery email for ${input.orderReference} is missing an escaped redeem code`);
    }
  }
}

export const DELIVERY_DEFAULT_INSTRUCTIONS = DEFAULT_INSTRUCTIONS;