/**
 * Shared HTML shell for every transactional email.
 *
 * WHY SO UGLY: email clients are not browsers. Gmail strips <style> blocks in
 * the head, Outlook (Word engine) ignores max-width, padding shorthand and any
 * layout based on flexbox/grid. The only reliably supported techniques are
 * nested <table>s with inline `style` attributes. Every rule below exists
 * because something broke without it.
 *
 * NO TRACKING: this shell emits zero <img> elements — no open pixel, no click
 * tracking. A redeem code delivered to a customer's inbox is the product; we
 * are not running a marketing campaign. The hidden preheader block is plain
 * text used purely to avoid a "…(view in browser)" snippet in the inbox list.
 */

/** Palette kept deliberately small and high-contrast. */
export const PALETTE = {
  pageBg: '#f4f5f7',
  cardBg: '#ffffff',
  border: '#e3e6ea',
  text: '#1f2933',
  muted: '#5b6673',
  accent: '#1a56db',
  accentText: '#ffffff',
  codeBg: '#0f172a',
  codeText: '#f8fafc',
  warnBg: '#fff7ed',
  warnBorder: '#fdba74',
} as const;

/** Fonts that resolve everywhere without loading a webfont (tracking + latency). */
const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO_STACK = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface LayoutOptions {
  /** <title> and the visible heading. */
  title: string;
  /** Hidden inbox-preview text. Never a tracking pixel. */
  preheader: string;
  /** Pre-built body HTML, already escaped. */
  bodyHtml: string;
  brand: string;
  /** Small print at the bottom, e.g. the support line. */
  footerNote?: string;
}

export function renderHtmlLayout(options: LayoutOptions): string {
  const year = new Date().getUTCFullYear();
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(options.title)}</title>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${PALETTE.pageBg};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;">${escapeHtml(options.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PALETTE.pageBg};margin:0;padding:0;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:${PALETTE.cardBg};border:1px solid ${PALETTE.border};border-radius:8px;">
<tr>
<td style="padding:24px 24px 8px 24px;font-family:${FONT_STACK};font-size:18px;line-height:24px;font-weight:700;color:${PALETTE.text};">
${escapeHtml(options.title)}
</td>
</tr>
<tr>
<td style="padding:0 24px 24px 24px;font-family:${FONT_STACK};font-size:15px;line-height:22px;color:${PALETTE.text};">
${options.bodyHtml}
</td>
</tr>
<tr>
<td style="padding:16px 24px 24px 24px;border-top:1px solid ${PALETTE.border};font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${PALETTE.muted};">
${options.footerNote ? `<p style="margin:0 0 8px 0;">${escapeHtml(options.footerNote)}</p>` : ''}
<p style="margin:0;">&copy; ${year} ${escapeHtml(options.brand)}. This message was sent because a purchase was completed.</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

/** Heading with a spacer underneath. */
export function headingHtml(text: string): string {
  return `<h2 style="margin:24px 0 8px 0;font-family:${FONT_STACK};font-size:15px;line-height:22px;font-weight:700;color:${PALETTE.text};">${escapeHtml(text)}</h2>`;
}

/** Body copy. Callers pass already-escaped content or use `escapeHtml`. */
export function paragraphHtml(html: string): string {
  return `<p style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:15px;line-height:22px;color:${PALETTE.text};">${html}</p>`;
}

export function mutedParagraphHtml(html: string): string {
  return `<p style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${PALETTE.muted};">${html}</p>`;
}

/**
 * Two-column label/value table.
 *
 * `width` is a percentage so Outlook and Gmail both keep the columns aligned;
 * fixed px widths collapse to a single unreadable column on mobile.
 */
export function detailRowsHtml(rows: ReadonlyArray<{ label: string; value: string }>): string {
  if (rows.length === 0) return '';
  const body = rows
    .map(
      (row, index) => `<tr>
<td width="45%" valign="top" style="padding:${index === rows.length - 1 ? '0' : '4px'} 8px ${index === rows.length - 1 ? '0' : '4px'} 0;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${PALETTE.muted};">${escapeHtml(row.label)}</td>
<td valign="top" style="padding:${index === rows.length - 1 ? '0' : '4px'} 0 ${index === rows.length - 1 ? '0' : '4px'} 0;font-family:${FONT_STACK};font-size:14px;line-height:20px;color:${PALETTE.text};font-weight:600;word-break:break-word;">${escapeHtml(row.value)}</td>
</tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 16px 0;">${body}</table>`;
}

/**
 * The redeem code, rendered as selectable monospace text.
 *
 * `word-break:break-all` matters: long alphanumeric codes with no spaces are a
 * classic cause of horizontal overflow on mobile clients, which hides part of
 * the code the customer is trying to copy.
 */
export function codeBlockHtml(code: string, label?: string): string {
  const labelHtml = label
    ? `<p style="margin:0 0 6px 0;font-family:${FONT_STACK};font-size:12px;line-height:18px;letter-spacing:1px;text-transform:uppercase;color:${PALETTE.muted};">${escapeHtml(label)}</p>`
    : '';
  return `${labelHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;margin:0 0 16px 0;">
<tr>
<td align="center" bgcolor="${PALETTE.codeBg}" style="background-color:${PALETTE.codeBg};padding:16px 12px;border-radius:8px;">
<span style="display:block;font-family:${MONO_STACK};font-size:20px;line-height:28px;font-weight:700;letter-spacing:2px;color:${PALETTE.codeText};word-break:break-all;">${escapeHtml(code)}</span>
</td>
</tr>
</table>`;
}

/** Callout box for region restrictions and similar warnings. */
export function calloutHtml(html: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;margin:0 0 16px 0;">
<tr>
<td bgcolor="${PALETTE.warnBg}" style="background-color:${PALETTE.warnBg};border-left:3px solid ${PALETTE.warnBorder};padding:12px 14px;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${PALETTE.text};">
${html}
</td>
</tr>
</table>`;
}

export function bulletListHtml(items: readonly string[]): string {
  if (items.length === 0) return '';
  const itemsHtml = items
    .map(
      (item) =>
        `<li style="margin:0 0 6px 0;font-family:${FONT_STACK};font-size:15px;line-height:22px;color:${PALETTE.text};">${escapeHtml(item)}</li>`,
    )
    .join('');
  return `<ul style="margin:0 0 12px 0;padding:0 0 0 20px;">${itemsHtml}</ul>`;
}

export function buttonHtml(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">
<tr>
<td align="center" bgcolor="${PALETTE.accent}" style="background-color:${PALETTE.accent};border-radius:6px;">
<a href="${escapeHtml(href)}" style="display:inline-block;padding:11px 18px;font-family:${FONT_STACK};font-size:14px;line-height:20px;font-weight:600;color:${PALETTE.accentText};text-decoration:none;">${escapeHtml(label)}</a>
</td>
</tr>
</table>`;
}

/** Plain-text helper: a labelled block for the text/plain alternative. */
export function textBlock(label: string, value: string): string {
  return `${label}: ${value}`;
}

/** Format a date for display in a stable, unambiguous way (UTC). */
export function formatDate(value: Date): string {
  const iso = value.toISOString().slice(0, 10);
  return iso;
}