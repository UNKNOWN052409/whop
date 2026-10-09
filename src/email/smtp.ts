/**
 * Generic SMTP transport (nodemailer).
 *
 * The escape hatch for self-hosted relays, Proton/Google Workspace SMTP, and
 * anything else that speaks SMTP. It is the slowest of the three (no native
 * idempotency, per-message connection cost) so it is not the default, but it
 * must work correctly rather than not exist.
 *
 * RETRY CORRECTNESS: an SMTP 4xx is "try again later", a 5xx is "this will
 * never work". nodemailer surfaces both as thrown errors carrying `responseCode`,
 * and 550 with an unknown mailbox is permanent even though 5xx usually is not.
 * Getting this backwards either hammers a dead address or abandons a customer
 * whose code was never delivered.
 */

import type { EmailProviderKind } from '@prisma/client';
import { createTransport } from 'nodemailer';
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

// Derive from createTransport itself rather than naming the generic parameters:
// @types/nodemailer has changed the Transporter arity and its default type
// argument across major versions, and this stays correct through all of them.
type SmtpTransporter = ReturnType<typeof createTransport>;

interface SmtpError extends Error {
  code?: string;
  command?: string;
  responseCode?: number;
}

function asSmtpError(error: unknown): SmtpError {
  if (error instanceof Error) return error as SmtpError;
  return new Error(String(error)) as SmtpError;
}

export class SmtpEmailProvider implements EmailProvider {
  readonly kind: EmailProviderKind = 'SMTP';
  readonly name = 'SMTP';

  private transporter: SmtpTransporter | null = null;

  get status(): IntegrationStatus {
    return emailConfig.smtp.host ? 'REAL' : 'NOT_CONFIGURED';
  }

  /**
   * Memoised transporter.
   *
   * nodemailer is a static import and `nodemailer` is listed in
   * `serverExternalPackages`, so webpack never bundles it into the server build
   * and its Node builtins resolve normally.
   *
   * It MUST NOT be reachable from `instrumentation.ts`: Next compiles that file
   * for the Edge runtime as well as Node, and the Edge compiler cannot resolve
   * the Node builtins nodemailer requires, which fails the entire production
   * build with "Can't resolve 'crypto'". The durable-workflow graph is wired up
   * in src/app/api/inngest/route.ts instead, which is Node-only.
   */
  private async getTransporter(): Promise<SmtpTransporter> {
    if (this.transporter) return this.transporter;
    const host = emailConfig.smtp.host;
    if (!host) {
      throw new AppError('SMTP is NOT CONFIGURED. Set SMTP_HOST.', 503, 'EMAIL_NOT_CONFIGURED', {
        details: { provider: 'SMTP' },
      });
    }
    const { user, password } = emailConfig.smtp;
    // nodemailer's createTransport is heavily overloaded and its declared return
    // type disagrees between the overloads, so the assignment is narrowed here
    // rather than by loosening the field type. The runtime object is a
    // Transporter either way.
    const created = createTransport({
      host,
      port: emailConfig.smtp.port,
      // Port 465 is implicit TLS; everything else starts in STARTTLS mode.
      secure: emailConfig.smtp.secure,
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      ...(user && password ? { auth: { user, pass: password } } : {}),
    });
    this.transporter = created as unknown as SmtpTransporter;
    return this.transporter;
  }

  async send(request: SendEmailRequest): Promise<SendEmailResult> {
    const fromAddress = requireFromAddress();
    const transporter = await this.getTransporter();

    const from = request.from?.address
      ? formatFrom(request.from.name, request.from.address)
      : formatFrom(brandName(), fromAddress);

    try {
      const info = await transporter.sendMail({
        from,
        to: request.to,
        subject: request.subject,
        text: request.text,
        ...(request.html ? { html: request.html } : {}),
        ...(request.replyTo ? { replyTo: request.replyTo } : {}),
        ...(request.idempotencyKey
          ? { headers: { 'X-Entity-Ref-ID': request.idempotencyKey } }
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
      });

      const rejected = info.rejected ?? [];
      if (rejected.length > 0) {
        return {
          providerMessageId: info.messageId ?? '',
          accepted: false,
          status: 'REJECTED',
          error: `SMTP server rejected the recipient (${info.response ?? 'no response'})`,
          permanent: true,
        };
      }

      return {
        providerMessageId: info.messageId ?? '',
        accepted: true,
        status: 'SENT',
      };
    } catch (error) {
      const smtpError = asSmtpError(error);
      const classified = classifyEmailError(smtpError);
      const responseCode = smtpError.responseCode;
      const code = smtpError.code ?? 'UnknownError';

      // EENVELOPE = the recipient address is unacceptable (550 mailbox not
      // found). Everything else with a 5xx is very likely permanent; a 4xx is
      // always worth another attempt.
      const permanent =
        code === 'EENVELOPE' ||
        code === 'EMESSAGE' ||
        code === 'EAUTH' ||
        (typeof responseCode === 'number' && responseCode >= 500) ||
        classified.permanent;

      logger.error('SMTP send failed', {
        provider: this.kind,
        errorCode: code,
        responseCode: responseCode ?? null,
        message: smtpError.message,
        permanent,
      });

      return {
        providerMessageId: '',
        accepted: false,
        status: 'REJECTED',
        error: `${code}${responseCode ? ` (${responseCode})` : ''}: ${smtpError.message}`,
        permanent,
      };
    }
  }

  /** Opens and immediately closes a session — the cheapest real liveness probe. */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await (await this.getTransporter()).verify();
      return { ok: true };
    } catch (error) {
      const smtpError = asSmtpError(error);
      return { ok: false, error: `${smtpError.code ?? 'Error'}: ${smtpError.message}` };
    }
  }

  /** Plain SMTP has no signed webhook of any kind. */
  verifyWebhook(): { valid: boolean; reason?: string } {
    return {
      valid: false,
      reason: 'SMTP has no provider-side delivery or bounce webhook. Mark deliveries SENT only.',
    };
  }
}

export function createSmtpEmailProvider(): SmtpEmailProvider {
  return new SmtpEmailProvider();
}