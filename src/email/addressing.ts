/**
 * Envelope addressing (From / Reply-To / support contact).
 *
 * Lives in its own module so the provider adapters, the delivery service and
 * the templates all agree on one answer without importing each other — a
 * circular import between provider.ts and the adapters would be easy to create
 * by accident and hard to untangle later.
 *
 * HONESTY RULE: there is no default sender. If EMAIL_FROM is missing we refuse
 * to send rather than inventing `no-reply@localhost`, because a message that
 * silently goes nowhere is a paid customer with no redeem code.
 */

import { emailConfig } from '@/lib/env';
import { AppError } from '@/lib/errors';

/** Brand name used in headers and the footer. */
export function brandName(): string {
  return emailConfig.fromName;
}

/**
 * The From address. Required to send.
 *
 * NOTE: `emailConfig.configured` in src/lib/env.ts does NOT include EMAIL_FROM,
 * so a deployment can report email as REAL and still be unable to send. This
 * function is the enforcement point.
 */
export function fromAddress(): string | null {
  const address = emailConfig.fromEmail;
  return address && address.length > 0 ? address : null;
}

/** Throws EMAIL_NOT_CONFIGURED when no From address is available. */
export function requireFromAddress(): string {
  const address = fromAddress();
  if (!address) {
    throw new AppError(
      'EMAIL_FROM is not set. A From address is required to send transactional email.',
      503,
      'EMAIL_NOT_CONFIGURED',
      { details: { missing: 'EMAIL_FROM' } },
    );
  }
  return address;
}

/** Reply-To, falling back to the From address when unset. */
export function replyToAddress(): string | null {
  return emailConfig.replyTo ?? fromAddress();
}

/**
 * Address customers are told to contact for support.
 *
 * Order of preference: an explicit reply-to, the sending address, the seeded
 * admin bootstrap address. When none exist the templates say "reply to this
 * email" rather than printing a made-up support@ address.
 */
export function supportAddress(): string | null {
  return emailConfig.replyTo ?? emailConfig.fromEmail ?? null;
}

/** "Name <address>" for providers that want a single From string. */
export function formatFrom(name: string, address: string): string {
  // Avoid producing `Name <Name <a@b>>` if EMAIL_FROM already carries a display
  // name — providers disagree on whether that is valid.
  if (address.includes('<')) return address;
  return `${name} <${address}>`;
}