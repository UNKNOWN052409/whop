/**
 * Provider-independent transactional email abstraction.
 *
 * The storefront's primary delivery channel is email, so this interface is
 * load-bearing for revenue: a redeem code that lands in spam is an
 * unredeemable paid order and a chargeback. The provider is chosen by the
 * EMAIL_PROVIDER env var; the fulfillment pipeline does not change.
 *
 * Section 12 requires QUEUED → SENT → DELIVERED/FAILED tracking, which lives
 * in the Delivery table. This interface covers the transport; the queue and
 * status transitions are owned by src/email/delivery-service.ts.
 */

import type { EmailProviderKind } from '@prisma/client';
import type { IntegrationStatus } from '@/lib/env';

export interface EmailAttachment {
  filename: string;
  content: string | Buffer;
  contentType: string;
}

export interface SendEmailRequest {
  to: string;
  subject: string;
  /** Plain-text body. Always populated — deliverability and accessibility. */
  text: string;
  /** Optional HTML alternative. */
  html?: string;
  from?: { name: string; address: string };
  replyTo?: string;
  /**
   * Opaque correlation id echoed back in provider logs, letting support trace a
   * customer's "I never got my code" report to a specific send.
   */
  idempotencyKey?: string;
  tags?: Record<string, string>;
  attachments?: EmailAttachment[];
}

export interface SendEmailResult {
  providerMessageId: string;
  accepted: boolean;
  status: 'SENT' | 'QUEUED' | 'REJECTED';
  /** Populated on rejection so the retry policy can distinguish 4xx from 5xx. */
  error?: string;
  /** True when the failure is permanent — retrying cannot help. */
  permanent?: boolean;
}

export interface EmailProvider {
  readonly kind: EmailProviderKind;
  readonly name: string;
  readonly status: IntegrationStatus;

  send(request: SendEmailRequest): Promise<SendEmailResult>;

  /**
   * Provider-side bounce/complaint webhook verification. Returns a normalised
   * event so Delivery.status can move to DELIVERED or FAILED.
   */
  verifyWebhook?(
    rawBody: Buffer | string,
    headers: Record<string, string>,
  ): { valid: boolean; event?: ProviderEmailEvent; reason?: string };

  /** Health probe for /api/health. */
  healthCheck?(): Promise<{ ok: boolean; error?: string }>;
}

export interface ProviderEmailEvent {
  providerMessageId: string;
  type: 'DELIVERED' | 'BOUNCED' | 'COMPLAINED' | 'REJECTED' | 'OPENED' | 'CLICKED';
  occurredAt: Date;
  reason?: string;
}

/**
 * Retry policy shared by every adapter.
 *
 * Distinguishing permanent from transient failures is the whole point: retrying
 * a hard bounce wastes queue capacity and delays legitimate orders behind it.
 */
export function classifyEmailError(error: unknown): { permanent: boolean; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  const permanentMarkers = [
    'invalid email',
    'does not exist',
    'mailbox full',
    'blocked',
    'suppressed',
    'invalidrecipient',
    'permanent',
    'unrouteable',
    'not allowed',
  ];
  const transientMarkers = [
    'timeout',
    'econnreset',
    'etimedout',
    'socket hang up',
    'rate limit',
    'throttl',
    'temporarily',
    'service unavailable',
    '502',
    '503',
    '504',
  ];

  if (permanentMarkers.some((m) => lower.includes(m))) {
    return { permanent: true, message };
  }
  if (transientMarkers.some((m) => lower.includes(m))) {
    return { permanent: false, message };
  }
  // Unknown failures default to transient: retrying a send is cheap and
  // idempotent, whereas dropping a paid order's code is not recoverable.
  return { permanent: false, message };
}

/** Exponential backoff with full jitter, capped. */
export function backoffDelayMs(
  attempt: number,
  baseMs = 1_000,
  maxMs = 15 * 60_000,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
}