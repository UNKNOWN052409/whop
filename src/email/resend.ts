/**
 * Resend transport.
 *
 * Resend is the nicest developer experience of the three (native idempotency
 * keys, useful error codes) and is the default choice where available.
 *
 * The API key is read from emailConfig and is never logged, never included in
 * an error message, and never sent to the client. `classifyEmailError` works
 * off the message text; the `RESEND_ERROR_NAME` table below is a stricter,
 * provider-specific layer on top of it, because Resend's own error names are
 * already a reliable permanent/transient split.
 */

import type { EmailProviderKind } from '@prisma/client';
import { Resend } from 'resend';
import { emailConfig } from '@/lib/env';
import type { IntegrationStatus } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { brandName, formatFrom, requireFromAddress } from './addressing';
import {
  classifyEmailError,
  type EmailProvider,
  type SendEmailRequest,
  type SendEmailResult,
} from './types';

/** Resend error names that will never succeed on retry. */
const PERMANENT_ERROR_NAMES = new Set([
  'validation_error',
  'missing_required_field',
  'invalid_idempotency_key',
  'invalid_from_address',
  'invalid_to',
  'invalid_cc',
  'invalid_bcc',
  'invalid_reply_to',
  'invalid_attachment',
  'invalid_tags',
  'restricted_recipient',
  'not_found',
  'invalid_from',
  'invalid_schedule',
]);

function isPermanentName(name: string): boolean {
  return PERMANENT_ERROR_NAMES.has(name.toLowerCase());
}

export class ResendEmailProvider implements EmailProvider {
  readonly kind: EmailProviderKind = 'RESEND';
  readonly name = 'Resend';

  private client: Resend | null = null;

  get status(): IntegrationStatus {
    return emailConfig.resend.apiKey ? 'REAL' : 'NOT_CONFIGURED';
  }

  private getClient(): Resend {
    if (this.client) return this.client;
    const apiKey = emailConfig.resend.apiKey;
    if (!apiKey) {
      throw new AppError(
        'Resend is NOT CONFIGURED. Set RESEND_API_KEY.',
        503,
        'EMAIL_NOT_CONFIGURED',
        { details: { provider: 'RESEND' } },
      );
    }
    this.client = new Resend(apiKey);
    return this.client;
  }

  async send(request: SendEmailRequest): Promise<SendEmailResult> {
    const fromAddress = requireFromAddress();
    const client = this.getClient();

    const from = request.from?.address
      ? formatFrom(request.from.name, request.from.address)
      : formatFrom(brandName(), fromAddress);

    const response = await client.emails.send(
      {
        from,
        to: [request.to],
        subject: request.subject,
        text: request.text,
        ...(request.html ? { html: request.html } : {}),
        ...(request.replyTo ? { replyTo: [request.replyTo] } : {}),
        ...(request.tags
          ? {
              tags: Object.entries(request.tags).map(([name, value]) => ({
                name: name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256),
                value: String(value).slice(0, 256),
              })),
            }
          : {}),
        ...(request.attachments && request.attachments.length > 0
          ? {
              attachments: request.attachments.map((attachment) => ({
                filename: attachment.filename,
                content: attachment.content,
                contentType: attachment.contentType,
              })),
            }
          : {}),
      },
      // A stable key means a retried attempt returns the original message id
      // instead of sending a second copy of a paid customer's code.
      request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {},
    );

    const { data, error } = response;

    if (error) {
      const permanent = isPermanentName(error.name) || classifyEmailError(error.message).permanent;
      logger.error('Resend send rejected', {
        provider: this.kind,
        errorName: error.name,
        message: error.message,
        permanent,
      });
      return {
        providerMessageId: '',
        accepted: false,
        status: 'REJECTED',
        error: `${error.name}: ${error.message}`,
        permanent,
      };
    }

    if (!data?.id) {
      return {
        providerMessageId: '',
        accepted: false,
        status: 'REJECTED',
        error: 'Resend returned neither a message id nor an error',
        permanent: false,
      };
    }

    return { providerMessageId: data.id, accepted: true, status: 'SENT' };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = this.getClient();
      const { error } = await client.domains.list();
      if (error) return { ok: false, error: `${error.name}: ${error.message}` };
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  /**
   * Resend signs webhooks with the svix scheme over a per-endpoint secret
   * (`whsec_…`). That secret is not declared in src/lib/env.ts, and this module
   * is not allowed to invent an env var (see rule: secrets come from
   * src/lib/env.ts only). Rather than shipping a signature check that always
   * passes, this returns invalid with the reason — an unverified event must
   * never be able to mark a paid order as DELIVERED.
   */
  verifyWebhook(): { valid: boolean; reason?: string } {
    return {
      valid: false,
      reason:
        'RESEND_WEBHOOK_SECRET is not declared in src/lib/env.ts, so Resend webhook signatures cannot be verified here. ' +
        'Apply svix verification in the webhook route before calling markDelivered/markBounced.',
    };
  }
}

export function createResendEmailProvider(): ResendEmailProvider {
  return new ResendEmailProvider();
}