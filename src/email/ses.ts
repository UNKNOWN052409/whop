/**
 * Amazon SES v2 transport.
 *
 * Credentials come from emailConfig (src/lib/env.ts) and are never logged,
 * echoed into an error, or included in a log context. The SDK client is built
 * lazily and memoised so importing this module in a build or a test does not
 * require AWS credentials to be present.
 *
 * IDEMPOTENCY: SES has no client-supplied idempotency key, so it cannot dedupe
 * a retried send the way Resend can. Two things compensate: the caller supplies
 * a stable `X-Entity-Ref-ID` header (visible in the SES event publishing
 * pipeline, which is how support traces "I got two codes" to one send), and the
 * Delivery row's unique orderId means the queue itself never schedules two
 * independent deliveries for one order.
 */

import type { EmailProviderKind } from '@prisma/client';
import { GetAccountCommand, SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
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

const CHARSET = 'UTF-8';

/** SES tag names: ASCII letters, digits, underscore and dash only. */
const TAG_NAME = /[^A-Za-z0-9_-]/g;

function toMessageTags(tags: Record<string, string> | undefined) {
  if (!tags) return undefined;
  const entries = Object.entries(tags)
    .map(([name, value]) => ({
      Name: name.replace(TAG_NAME, '_').slice(0, 256),
      Value: String(value).slice(0, 256),
    }))
    .filter((tag) => tag.Name.length > 0);
  return entries.length > 0 ? entries : undefined;
}

function toAttachments(attachments: SendEmailRequest['attachments']) {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((attachment) => ({
    RawContent:
      typeof attachment.content === 'string'
        ? Buffer.from(attachment.content, 'utf8')
        : attachment.content,
    FileName: attachment.filename,
    ContentType: attachment.contentType,
    ContentDisposition: 'ATTACHMENT' as const,
  }));
}

export class SesEmailProvider implements EmailProvider {
  readonly kind: EmailProviderKind = 'SES';
  readonly name = 'Amazon SES v2';

  private client: SESv2Client | null = null;

  get status(): IntegrationStatus {
    return emailConfig.ses.accessKeyId && emailConfig.ses.secretAccessKey
      ? 'REAL'
      : 'NOT_CONFIGURED';
  }

  private getClient(): SESv2Client {
    if (this.client) return this.client;
    const accessKeyId = emailConfig.ses.accessKeyId;
    const secretAccessKey = emailConfig.ses.secretAccessKey;
    if (!accessKeyId || !secretAccessKey) {
      throw new AppError(
        'Amazon SES is NOT CONFIGURED. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.',
        503,
        'EMAIL_NOT_CONFIGURED',
        { details: { provider: 'SES' } },
      );
    }
    this.client = new SESv2Client({
      region: emailConfig.ses.region,
      credentials: { accessKeyId, secretAccessKey },
    });
    return this.client;
  }

  async send(request: SendEmailRequest): Promise<SendEmailResult> {
    const fromAddress = requireFromAddress();
    const client = this.getClient();

    const from =
      request.from && !request.from.address
        ? fromAddress
        : formatFrom(request.from?.name ?? brandName(), request.from?.address ?? fromAddress);

    const input = {
      FromEmailAddress: from,
      Destination: { ToAddresses: [request.to] },
      ReplyToAddresses: request.replyTo ? [request.replyTo] : undefined,
      Content: {
        Simple: {
          Subject: { Data: request.subject, Charset: CHARSET },
          Body: {
            Text: { Data: request.text, Charset: CHARSET },
            Html: request.html
              ? { Data: request.html, Charset: CHARSET }
              : undefined,
          },
          // Stable correlation header: SES event publishing echoes it back, so a
          // duplicate-send report can be tied to a specific attempt.
          Headers: request.idempotencyKey
            ? [{ Name: 'X-Entity-Ref-ID', Value: request.idempotencyKey }]
            : undefined,
          Attachments: toAttachments(request.attachments),
        },
      },
      EmailTags: toMessageTags(request.tags),
    };

    try {
      const output = await client.send(new SendEmailCommand(input));
      const messageId = output.MessageId;
      if (!messageId) {
        return {
          providerMessageId: '',
          accepted: false,
          status: 'REJECTED',
          error: 'SES accepted the message but returned no MessageId',
          permanent: false,
        };
      }
      return { providerMessageId: messageId, accepted: true, status: 'SENT' };
    } catch (error) {
      // The thrown error object carries AWS request metadata. Only its name and
      // message are ever recorded — never the raw object, never credentials.
      const classified = classifyEmailError(error);
      const name = error instanceof Error ? error.name : 'UnknownError';
      const permanent =
        name === 'MessageRejected' ||
        name === 'MailFromDomainNotVerifiedException' ||
        name === 'ConfigurationSetDoesNotExistException' ||
        name === 'AccountSendingPausedException' ||
        name === 'NotFoundException' ||
        classified.permanent;

      logger.error('SES send failed', {
        provider: this.kind,
        errorName: name,
        message: classified.message,
        permanent,
      });

      return {
        providerMessageId: '',
        accepted: false,
        status: 'REJECTED',
        error: `${name}: ${classified.message}`,
        permanent,
      };
    }
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = this.getClient();
      const output = await client.send(new GetAccountCommand({}));
      if (output.SendingEnabled === false) {
        return { ok: false, error: 'SES account sending is disabled' };
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  /**
   * SES bounce/complaint events arrive through EventBridge/SNS/OpenSearch, not
   * a signed HTTP endpoint this app hosts, and no SES webhook signing secret is
   * declared in src/lib/env.ts. Refusing every event is the only safe answer:
   * an unverified "delivered" event would mark paid orders delivered without
   * the customer ever receiving anything.
   */
  verifyWebhook(): { valid: boolean; reason?: string } {
    return {
      valid: false,
      reason:
        'SES delivers bounce events via EventBridge/SNS, which this app does not host. ' +
        'No SES webhook signing secret is declared in src/lib/env.ts, so events cannot be authenticated here.',
    };
  }
}

export function createSesEmailProvider(): SesEmailProvider {
  return new SesEmailProvider();
}