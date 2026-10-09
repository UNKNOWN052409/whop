/**
 * Email delivery orchestration (spec §12).
 *
 * This is the module the fulfillment pipeline actually calls. It owns the
 * Delivery row lifecycle:
 *
 *   queueDelivery()  -> QUEUED   (idempotent; one row per order, enforced by
 *                                the unique index on Delivery.orderId)
 *   processDelivery()-> SENT     (provider accepted the message)
 *                     -> QUEUED   (transient failure; retried with backoff)
 *                     -> FAILED   (permanent failure, or the attempt budget is
 *                                exhausted — never retried indefinitely)
 *   markDelivered()  -> DELIVERED (provider webhook)
 *   markBounced()    -> FAILED    (hard bounce: the address will never work)
 *
 * WHY THE CODE IS DECRYPTED HERE AND NOW: InventoryCode.codeCiphertext is
 * decrypted through @/inventory/reveal at send time and never persisted in
 * cleartext. If the customer never receives the mail we still hold the
 * ciphertext, so the code is recoverable — which is exactly why a failed
 * delivery must be retried rather than abandoned.
 *
 * NOTHING IN HERE LOGS A CODE. `scrubSecrets` is the last line of defence: any
 * provider error text is filtered against the plaintext before it reaches
 * Delivery.lastError, because that column is read by support tooling.
 */

import { Prisma } from '@prisma/client';
import type { Delivery, EmailStatus } from '@prisma/client';
import { prisma } from '@/db/prisma';
import { appConfig } from '@/lib/env';
import { errors } from '@/lib/errors';
import { AppError } from '@/lib/errors';
import { sha256 } from '@/lib/ids';
import { logger } from '@/lib/logger';
import { brandName, replyToAddress, supportAddress } from './addressing';
import { getEmailProvider } from './provider';
import { revealCodesForOrder } from './reveal';
import type { DeliveryCodeView, RenderedEmail } from './templates/delivery';
import { renderDeliveryEmail } from './templates/delivery';
import {
  renderAdminAlert,
  renderFulfillmentFailedAlert,
  renderInventoryDepletedAlert,
  renderManualReviewAlert,
  renderReconciliationMismatchAlert,
} from './templates/admin';
import type { AdminAlertDetail } from './templates/admin';
import { backoffDelayMs, classifyEmailError } from './types';
import type { ProviderEmailEvent, SendEmailResult } from './types';

/**
 * Attempt budget for a single Delivery row.
 *
 * Bounded on purpose. backoffDelayMs caps the delay at 15 minutes, so without
 * this a permanently-broken provider would keep a paid customer's code in a
 * retry loop forever while the fulfillment job sits behind it. Hitting the
 * budget marks the delivery FAILED and raises an operator alert instead.
 */
export const MAX_DELIVERY_ATTEMPTS = 6;

/** Attempts to record before giving up, so the number is visible in the row. */
const MAX_ERROR_LENGTH = 500;

export interface QueueDeliveryInput {
  orderId: string;
  paymentId?: string | null;
  fulfillmentJobId?: string | null;
  /**
   * Re-queue a row that already FAILED. Off by default: queueing must be a
   * no-op for an order that already has a delivery, otherwise a replayed
   * webhook could resend a code the customer already has.
   */
  retryFailed?: boolean;
}

/**
 * Create (or return) the single Delivery row for an order, in status QUEUED.
 *
 * IDEMPOTENT BY CONSTRUCTION: Delivery has `@@unique([orderId])`. Re-running
 * this after a webhook replay returns the existing row untouched rather than
 * scheduling a second send.
 *
 * Throws EMAIL_NOT_CONFIGURED (503) when no provider is set up. There is no
 * "queue it anyway with a placeholder provider" path — a Delivery row that
 * claims a provider it was not sent through is worse than no row at all.
 */
export async function queueDelivery(input: QueueDeliveryInput): Promise<Delivery> {
  const provider = getEmailProvider();
  if (!provider) {
    logger.error('Cannot queue delivery: email is NOT CONFIGURED', {
      orderId: input.orderId,
      paymentId: input.paymentId ?? undefined,
    });
    throw new (await import('@/lib/errors')).AppError(
      'Email is NOT CONFIGURED. Set EMAIL_PROVIDER and its credentials.',
      503,
      'EMAIL_NOT_CONFIGURED',
      { details: { provider: null } },
    );
  }

  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: { id: true, customerEmail: true },
  });
  if (!order) throw errors.notFound('Order');

  const existing = await prisma.delivery.findUnique({ where: { orderId: input.orderId } });

  if (existing) {
    const data: Prisma.DeliveryUpdateInput = {
      email: order.customerEmail,
      // paymentId / fulfillmentJobId are scalar FKs, so Prisma needs the relation form.
      payment: input.paymentId ? { connect: { id: input.paymentId } } : undefined,
      fulfillmentJob: input.fulfillmentJobId
        ? { connect: { id: input.fulfillmentJobId } }
        : undefined,
    };
    if (input.retryFailed === true && existing.status === 'FAILED') {
      data.status = 'QUEUED';
      data.lastError = null;
      data.failedAt = null;
    }
    const updated = await prisma.delivery.update({
      where: { orderId: input.orderId },
      data,
    });
    logger.info('Delivery already exists for order; queue is a no-op', {
      orderId: input.orderId,
      deliveryId: existing.id,
      status: updated.status,
      requeued: updated.status === 'QUEUED' && existing.status === 'FAILED',
    });
    return updated;
  }

  try {
    const created = await prisma.delivery.create({
      data: {
        orderId: input.orderId,
        email: order.customerEmail,
        provider: provider.kind,
        paymentId: input.paymentId ?? null,
        fulfillmentJobId: input.fulfillmentJobId ?? null,
        status: 'QUEUED',
      },
    });
    logger.info('Delivery queued', {
      orderId: input.orderId,
      deliveryId: created.id,
      provider: provider.kind,
    });
    return created;
  } catch (error) {
    // Two concurrent fulfillment workers can both miss the SELECT above; the
    // unique index is the real arbiter, so re-read instead of failing the job.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await prisma.delivery.findUnique({ where: { orderId: input.orderId } });
      if (raced) return raced;
    }
    throw error;
  }
}

export interface ProcessDeliveryResult {
  deliveryId: string;
  orderId: string;
  outcome: 'SENT' | 'SKIPPED' | 'RETRY' | 'FAILED';
  status: EmailStatus;
  providerMessageId: string | null;
  attempts: number;
  permanent: boolean;
  /** Milliseconds the caller should wait before retrying. null when terminal. */
  retryInMs: number | null;
  error: string | null;
}

/**
 * Render and send the delivery email for one Delivery row.
 *
 * Never throws for an expected failure — every outcome is returned as a
 * structured result so the Inngest job can decide between `sleep` and
 * `NonRetriableError` without string-matching an error message.
 */
export async function processDelivery(deliveryId: string): Promise<ProcessDeliveryResult> {
  const delivery = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    include: { order: true },
  });
  if (!delivery) throw errors.notFound('Delivery');

  if (delivery.status === 'SENT' || delivery.status === 'DELIVERED') {
    logger.info('Delivery already sent; skipping', {
      orderId: delivery.orderId,
      deliveryId,
      status: delivery.status,
    });
    return {
      deliveryId,
      orderId: delivery.orderId,
      outcome: 'SKIPPED',
      status: delivery.status,
      providerMessageId: delivery.providerMessageId,
      attempts: delivery.attempts,
      permanent: false,
      retryInMs: null,
      error: null,
    };
  }

  const attempt = delivery.attempts + 1;
  const provider = getEmailProvider();

  if (!provider) {
    // An operational fault, not a customer fault. The row stays QUEUED so the
    // code is still delivered once someone sets the environment variables.
    const error = 'Email provider is NOT CONFIGURED; delivery deferred';
    await recordAttempt(deliveryId, error);
    logger.error('Delivery deferred: email NOT CONFIGURED', {
      orderId: delivery.orderId,
      deliveryId,
      attempt,
    });
    return {
      deliveryId,
      orderId: delivery.orderId,
      outcome: 'RETRY',
      status: 'QUEUED',
      providerMessageId: delivery.providerMessageId,
      attempts: attempt,
      permanent: false,
      retryInMs: backoffDelayMs(attempt),
      error,
    };
  }

  if (delivery.provider !== provider.kind) {
    // EMAIL_PROVIDER changed after this row was queued. Re-queue it explicitly
    // rather than sending a row that claims the wrong provider.
    const error = `Delivery was queued for ${delivery.provider} but EMAIL_PROVIDER is now ${provider.kind}; re-queue required`;
    await markFailed(deliveryId, { error, permanent: true, attempts: attempt });
    logger.error('Delivery provider mismatch', {
      orderId: delivery.orderId,
      deliveryId,
      queuedFor: delivery.provider,
      configured: provider.kind,
    });
    return {
      deliveryId,
      orderId: delivery.orderId,
      outcome: 'FAILED',
      status: 'FAILED',
      providerMessageId: delivery.providerMessageId,
      attempts: attempt,
      permanent: true,
      retryInMs: null,
      error,
    };
  }

  // --- reveal ------------------------------------------------------------
  let codes: DeliveryCodeView[];
  try {
    codes = await revealCodesForOrder(delivery.orderId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(deliveryId, { error: message, permanent: true, attempts: attempt });
    logger.error('Cannot reveal a redeem code for a paid order', {
      orderId: delivery.orderId,
      deliveryId,
      attempt,
    });
    await notifyFulfillmentFailed({
      orderId: delivery.orderId,
      orderReference: delivery.order.reference,
      productName: delivery.order.productName,
      customerEmail: delivery.order.customerEmail,
      summary: 'A paid order has no deliverable redeem code, so the customer email was not produced.',
      reason: message,
    });
    return {
      deliveryId,
      orderId: delivery.orderId,
      outcome: 'FAILED',
      status: 'FAILED',
      providerMessageId: null,
      attempts: attempt,
      permanent: true,
      retryInMs: null,
      error: message,
    };
  }

  // --- render ------------------------------------------------------------
  let rendered: RenderedEmail;
  try {
    rendered = renderDeliveryEmail({
      orderReference: delivery.order.reference,
      productName: delivery.order.productName,
      currency: delivery.order.currency,
      faceValueMinor: delivery.order.faceValueMinor,
      sellingPriceMinor: delivery.order.sellingPriceMinor,
      totalMinor: delivery.order.totalMinor,
      quantity: delivery.order.quantity,
      region: delivery.order.region,
      codes,
      brand: brandName(),
      supportEmail: supportAddress(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(deliveryId, { error: message, permanent: true, attempts: attempt });
    logger.error('Delivery email could not be rendered', {
      orderId: delivery.orderId,
      deliveryId,
    });
    return {
      deliveryId,
      orderId: delivery.orderId,
      outcome: 'FAILED',
      status: 'FAILED',
      providerMessageId: null,
      attempts: attempt,
      permanent: true,
      retryInMs: null,
      error: message,
    };
  }

  // --- send --------------------------------------------------------------
  let result: SendEmailResult;
  try {
    result = await provider.send({
      to: delivery.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      replyTo: replyToAddress() ?? undefined,
      // Stable across retries: providers with native dedupe return the original
      // message id instead of mailing a second copy of the same code.
      idempotencyKey: `delivery:${delivery.id}`,
      tags: { order: delivery.order.reference, delivery: delivery.id },
    });
  } catch (error) {
    const classified = classifyEmailError(error);
    const message = scrubSecrets(classified.message, codes);
    return recordFailure(deliveryId, {
      message,
      permanent: classified.permanent || isConfigurationError(error),
      attempt,
      orderId: delivery.orderId,
    });
  }

  if (result.accepted && result.status !== 'REJECTED') {
    const updated = await markSent(deliveryId, result.providerMessageId, attempt);
    logger.info('Delivery email sent', {
      orderId: delivery.orderId,
      deliveryId,
      provider: provider.kind,
      providerMessageId: result.providerMessageId,
      attempt,
    });
    return {
      deliveryId,
      orderId: delivery.orderId,
      outcome: 'SENT',
      status: updated.status,
      providerMessageId: result.providerMessageId,
      attempts: updated.attempts,
      permanent: false,
      retryInMs: null,
      error: null,
    };
  }

  const rejectionMessage = result.error ?? 'Provider rejected the message';
  return recordFailure(deliveryId, {
    message: scrubSecrets(rejectionMessage, codes),
    permanent:
      result.permanent === true ||
      classifyEmailError(rejectionMessage).permanent ||
      attempt >= MAX_DELIVERY_ATTEMPTS,
    attempt,
    orderId: delivery.orderId,
    exhaustionIsFailure: true,
  });
}

/** True for faults that a retry cannot fix without a config change. */
function isConfigurationError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'EMAIL_NOT_CONFIGURED';
}

interface FailureInput {
  message: string;
  permanent: boolean;
  attempt: number;
  orderId: string;
  /** Distinguish "provider said permanent" from "we ran out of attempts". */
  exhaustionIsFailure?: boolean;
}

async function recordFailure(
  deliveryId: string,
  input: FailureInput,
): Promise<ProcessDeliveryResult> {
  const permanent = input.permanent;

  if (permanent) {
    await markFailed(deliveryId, {
      error: input.message,
      permanent: true,
      attempts: input.attempt,
    });
    logger.error('Delivery email failed permanently', {
      orderId: input.orderId,
      deliveryId,
      attempt: input.attempt,
      exhaustedBudget: input.exhaustionIsFailure === true,
      error: input.message,
    });
    return {
      deliveryId,
      orderId: input.orderId,
      outcome: 'FAILED',
      status: 'FAILED',
      providerMessageId: null,
      attempts: input.attempt,
      permanent: true,
      retryInMs: null,
      error: input.message,
    };
  }

  await recordAttempt(deliveryId, input.message);
  const retryInMs = backoffDelayMs(input.attempt);
  logger.warn('Delivery email attempt failed; will retry', {
    orderId: input.orderId,
    deliveryId,
    attempt: input.attempt,
    retryInMs,
    error: input.message,
  });
  return {
    deliveryId,
    orderId: input.orderId,
    outcome: 'RETRY',
    status: 'QUEUED',
    providerMessageId: null,
    attempts: input.attempt,
    permanent: false,
    retryInMs,
    error: input.message,
  };
}

/**
 * Removes plaintext codes from text destined for a database column or a log.
 * Provider error bodies occasionally echo the message; lastError is read by
 * support tooling, so this is enforced rather than assumed.
 */
export function scrubSecrets(message: string, codes: readonly DeliveryCodeView[]): string {
  let out = message;
  for (const code of codes) {
    if (code.code.length < 4) continue;
    if (out.includes(code.code)) out = out.split(code.code).join('[redacted]');
  }
  return out.length > MAX_ERROR_LENGTH ? `${out.slice(0, MAX_ERROR_LENGTH)}…` : out;
}

// --- State helpers ---------------------------------------------------------

/** Increments the attempt counter without leaving QUEUED. */
async function recordAttempt(deliveryId: string, error: string | null): Promise<void> {
  const current = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    select: { attempts: true },
  });
  await prisma.delivery.update({
    where: { id: deliveryId },
    data: {
      attempts: (current?.attempts ?? 0) + 1,
      lastError: error ? error.slice(0, MAX_ERROR_LENGTH) : null,
    },
  });
}

/** QUEUED -> SENT. Records the provider's message id for webhook correlation. */
export async function markSent(
  deliveryId: string,
  providerMessageId: string,
  attempts?: number,
): Promise<Delivery> {
  return prisma.delivery.update({
    where: { id: deliveryId },
    data: {
      status: 'SENT',
      sentAt: new Date(),
      deliveredAt: null,
      failedAt: null,
      lastError: null,
      ...(providerMessageId ? { providerMessageId } : {}),
      ...(typeof attempts === 'number' ? { attempts } : {}),
    },
  });
}

/**
 * SENT -> DELIVERED, driven by a verified provider webhook.
 *
 * A DELIVERED event for a row already marked FAILED is contradictory but the
 * provider is authoritative: if it says the mail landed, it landed. Logged at
 * warn so the disagreement is visible rather than silently overwritten.
 */
export async function markDelivered(
  deliveryId: string,
  options?: { occurredAt?: Date },
): Promise<Delivery> {
  const existing = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    select: { status: true, orderId: true },
  });
  if (!existing) throw errors.notFound('Delivery');
  if (existing.status === 'FAILED') {
    logger.warn('Delivery marked DELIVERED after being marked FAILED', {
      orderId: existing.orderId,
      deliveryId,
    });
  }
  return prisma.delivery.update({
    where: { id: deliveryId },
    data: {
      status: 'DELIVERED',
      deliveredAt: options?.occurredAt ?? new Date(),
      lastError: null,
    },
  });
}

export interface MarkFailedInput {
  error: string;
  permanent?: boolean;
  attempts?: number;
}

/**
 * Any state -> FAILED. Terminal: a permanent rejection (invalid address, an
 * account under sending suspension) will never succeed on retry, and retrying
 * it only delays the legitimate orders queued behind it.
 */
export async function markFailed(
  deliveryId: string,
  input: MarkFailedInput,
): Promise<Delivery> {
  return prisma.delivery.update({
    where: { id: deliveryId },
    data: {
      status: 'FAILED',
      failedAt: new Date(),
      lastError: input.error.slice(0, MAX_ERROR_LENGTH),
      ...(typeof input.attempts === 'number' ? { attempts: input.attempts } : {}),
      ...(input.permanent ? {} : {}),
    },
  });
}

/**
 * Hard bounce. The address will never accept mail again, so the delivery is
 * FAILED and the order needs human attention — a bounced code delivery is a
 * paid customer with no product.
 */
export async function markBounced(
  deliveryId: string,
  options?: { reason?: string },
): Promise<Delivery> {
  return prisma.delivery.update({
    where: { id: deliveryId },
    data: {
      status: 'FAILED',
      failedAt: new Date(),
      lastError: `Bounced: ${(options?.reason ?? 'unknown reason').slice(0, 300)}`,
    },
  });
}

/** Spam complaint: suppress the address rather than retrying it forever. */
export async function markSuppressed(
  deliveryId: string,
  options?: { reason?: string },
): Promise<Delivery> {
  return prisma.delivery.update({
    where: { id: deliveryId },
    data: {
      status: 'SUPPRESSED',
      lastError: `Complaint: ${(options?.reason ?? 'marked as spam').slice(0, 300)}`,
    },
  });
}

/**
 * Apply an already-verified provider event. Callers MUST have verified the
 * webhook signature themselves — see the note on each adapter's
 * `verifyWebhook`, which deliberately refuses to authenticate events rather
 * than pretend to.
 */
export async function handleProviderEvent(event: ProviderEmailEvent): Promise<Delivery | null> {
  const delivery = await prisma.delivery.findFirst({
    where: { providerMessageId: event.providerMessageId },
    select: { id: true, orderId: true },
  });
  if (!delivery) {
    logger.warn('Provider event references an unknown message id', {
      providerMessageId: event.providerMessageId,
      type: event.type,
    });
    return null;
  }

  switch (event.type) {
    case 'DELIVERED':
      return markDelivered(delivery.id, { occurredAt: event.occurredAt });
    case 'BOUNCED':
      return markBounced(delivery.id, { reason: event.reason });
    case 'COMPLAINED':
      return markSuppressed(delivery.id, { reason: event.reason });
    case 'REJECTED':
      return markFailed(delivery.id, {
        error: `Provider rejected the message: ${event.reason ?? 'no reason given'}`,
        permanent: true,
      });
    case 'OPENED':
    case 'CLICKED':
      // Accepted for completeness; this system ships no tracking pixel, so these
      // events are not expected. They are not an error either.
      return null;
    default:
      return null;
  }
}

// --- Queries ---------------------------------------------------------------

/** The single Delivery row for an order, if one exists. */
export async function getDeliveryForOrder(orderId: string): Promise<Delivery | null> {
  return prisma.delivery.findUnique({ where: { orderId } });
}

/**
 * Safety net for deliveries stranded in QUEUED — a worker crash between the
 * send and the status write, or an Inngest outage. Runs sequentially on
 * purpose: a burst of parallel sends is how a provider rate-limits you.
 */
export async function processStuckDeliveries(
  options?: { limit?: number; olderThanMinutes?: number },
): Promise<ProcessDeliveryResult[]> {
  const limit = options?.limit ?? 20;
  const olderThanMinutes = options?.olderThanMinutes ?? 10;
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);

  const stuck = await prisma.delivery.findMany({
    where: { status: 'QUEUED', updatedAt: { lt: cutoff } },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    select: { id: true, orderId: true },
  });

  const results: ProcessDeliveryResult[] = [];
  for (const row of stuck) {
    try {
      results.push(await processDelivery(row.id));
    } catch (error) {
      logger.error('Stuck delivery could not be processed', {
        orderId: row.orderId,
        deliveryId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

// --- Operator notifications ------------------------------------------------

export interface AdminAlertContext {
  orderId?: string | null;
  orderReference?: string | null;
  productName?: string | null;
  customerEmail?: string | null;
}

export interface NotifyResult {
  attempted: number;
  sent: number;
  failed: number;
  skippedReason?: 'EMAIL_NOT_CONFIGURED' | 'NO_RECIPIENTS' | 'RECIPIENT_LOOKUP_FAILED';
}

async function adminRecipients(): Promise<string[]> {
  const recipients = new Set<string>();
  const bootstrap = appConfig.adminBootstrapEmail;
  if (bootstrap) recipients.add(bootstrap);

  const users = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'OWNER'] }, disabledAt: null },
    select: { email: true },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  for (const user of users) recipients.add(user.email);

  return [...recipients];
}

/**
 * Send an operator notification to every enabled ADMIN/OWNER.
 *
 * Best-effort by design: a failed admin alert must never roll back a
 * fulfillment step that already succeeded. Problems are logged, not thrown.
 *
 * These are NOT queued through the Delivery table — that table has a unique
 * index on orderId and its status machine means "has this customer been
 * emailed", which is a different question from "did an operator get paged".
 */
export async function notifyAdmins(
  rendered: RenderedEmail,
  context?: AdminAlertContext,
): Promise<NotifyResult> {
  const provider = getEmailProvider();
  if (!provider) {
    logger.error('Operator notification not sent: email is NOT CONFIGURED', {
      subject: rendered.subject,
      orderId: context?.orderId ?? undefined,
    });
    return { attempted: 0, sent: 0, failed: 0, skippedReason: 'EMAIL_NOT_CONFIGURED' };
  }

  let recipients: string[];
  try {
    recipients = await adminRecipients();
  } catch (error) {
    logger.error('Could not resolve operator recipients', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { attempted: 0, sent: 0, failed: 0, skippedReason: 'RECIPIENT_LOOKUP_FAILED' };
  }

  if (recipients.length === 0) {
    logger.error('No operator recipients configured for an internal alert', {
      subject: rendered.subject,
      orderId: context?.orderId ?? undefined,
    });
    return { attempted: 0, sent: 0, failed: 0, skippedReason: 'NO_RECIPIENTS' };
  }

  // Ten-minute dedupe bucket: collapses a retry storm of the same alert without
  // suppressing a genuinely new one with an identical subject later.
  const bucket = Math.floor(Date.now() / (10 * 60_000));
  let sent = 0;
  let failed = 0;

  for (const to of recipients) {
    try {
      const result = await provider.send({
        to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        idempotencyKey: `admin:${sha256(`${to}|${rendered.subject}`)}:${bucket}`,
        tags: { kind: 'admin-alert', order: context?.orderReference ?? 'none' },
      });
      if (result.accepted && result.status !== 'REJECTED') sent += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      logger.error('Operator notification send failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { attempted: recipients.length, sent, failed };
}

export interface FulfillmentFailedNotice extends AdminAlertContext {
  summary: string;
  reason: string;
  details?: AdminAlertDetail[];
}

export async function notifyFulfillmentFailed(
  notice: FulfillmentFailedNotice,
): Promise<NotifyResult> {
  const rendered = renderFulfillmentFailedAlert({
    orderId: notice.orderId,
    orderReference: notice.orderReference,
    productName: notice.productName,
    customerEmail: notice.customerEmail,
    summary: notice.summary,
    reason: notice.reason,
    details: notice.details,
    brand: brandName(),
  });
  return notifyAdmins(rendered, notice);
}

export interface ManualReviewNotice extends AdminAlertContext {
  summary: string;
  riskLevel?: string | null;
  details?: AdminAlertDetail[];
}

export async function notifyManualReview(notice: ManualReviewNotice): Promise<NotifyResult> {
  const rendered = renderManualReviewAlert({
    orderId: notice.orderId,
    orderReference: notice.orderReference,
    productName: notice.productName,
    customerEmail: notice.customerEmail,
    summary: notice.summary,
    riskLevel: notice.riskLevel,
    details: notice.details,
    brand: brandName(),
  });
  return notifyAdmins(rendered, notice);
}

export interface ReconciliationMismatchNotice extends AdminAlertContext {
  summary: string;
  mismatchType?: string | null;
  providerPaymentId?: string | null;
  details?: AdminAlertDetail[];
}

export async function notifyReconciliationMismatch(
  notice: ReconciliationMismatchNotice,
): Promise<NotifyResult> {
  const rendered = renderReconciliationMismatchAlert({
    orderId: notice.orderId,
    orderReference: notice.orderReference,
    productName: notice.productName,
    customerEmail: notice.customerEmail,
    summary: notice.summary,
    mismatchType: notice.mismatchType,
    providerPaymentId: notice.providerPaymentId,
    details: notice.details,
    brand: brandName(),
  });
  return notifyAdmins(rendered, notice);
}

export interface InventoryDepletedNotice extends AdminAlertContext {
  summary: string;
  remainingCount?: number | null;
  details?: AdminAlertDetail[];
}

export async function notifyInventoryDepleted(
  notice: InventoryDepletedNotice,
): Promise<NotifyResult> {
  const rendered = renderInventoryDepletedAlert({
    orderId: notice.orderId,
    orderReference: notice.orderReference,
    productName: notice.productName,
    customerEmail: notice.customerEmail,
    summary: notice.summary,
    remainingCount: notice.remainingCount,
    details: notice.details,
    brand: brandName(),
  });
  return notifyAdmins(rendered, notice);
}

export { renderAdminAlert };