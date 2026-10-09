/**
 * Admin alerting for fulfillment failures (spec §11/§21 + §22).
 *
 * An order that exhausts its retries is a customer who paid and has nothing.
 * That is a revenue and support problem, so it must reach a human through a
 * channel that survives a crashed worker — not through a log line somebody
 * happens to be watching.
 *
 * Delivery order, most durable first:
 *
 *  1. A `redeem-store/ops.alert` event on the durable queue. Replayed by
 *     Inngest until a consumer picks it up, survives restarts, is visible in
 *     the Inngest dashboard, and is an auditable timeline of what happened.
 *  2. An `AuditLog` row, written directly. This one cannot fail silently: it is
 *     in the same database as the order, so an operator browsing the admin
 *     panel can always see *that* something failed, even with no queue and no
 *     email provider configured.
 *  3. A CRITICAL structured log line (spec §22), which is what on-call
 *     alerting keys off.
 *
 * The actual mailbox send is pluggable. `setAdminAlertSender()` is installed at
 * boot by the process that owns email credentials (the email workstream or the
 * app entrypoint). Until then the alert is still durable and still logged — we
 * never fabricate a "sent" notification, and we never pretend a delivery
 * channel exists when it does not.
 *
 * NOTHING here may contain a redeem code, PAN, CVV, OTP or UPI PIN. The
 * customer address is masked.
 */

import { prisma } from '@/db/prisma';
import { inngestConfig } from '@/lib/env';
import { maskEmail } from '@/lib/ids';
import { formatMoney } from '@/lib/money';
import { logger } from '@/lib/logger';
import { inngest } from '@/inngest/client';

export type AlertSeverity = 'CRITICAL' | 'WARNING';

export interface FulfillmentAlert {
  severity: AlertSeverity;
  title: string;
  /** Machine-readable cause, e.g. 'INSUFFICIENT_INVENTORY'. */
  reason: string;
  detail?: string;
  orderId?: string;
  orderReference?: string;
  productName?: string;
  /**
   * What the customer PAID, in integer minor units + currency. Never a float.
   * This is a PREMIUM over face value: a $1 code priced at $3 means the customer
   * paid 300 USD-minor for 100 USD-minor of redeem value.
   */
  amountMinor?: number;
  /** The redeem value the customer receives for that price, in minor units. */
  faceValueMinor?: number;
  currency?: string;
  customerEmail?: string;
  jobId?: string;
  attempts?: number;
  maxAttempts?: number;
  /** 'DEAD_LETTER' after the retry budget is spent, 'FAILED' otherwise. */
  jobStatus?: string;
}

export type AlertChannel = 'email' | 'inngest' | 'log';

export interface AdminAlertResult {
  /** True when at least one durable channel accepted the alert. */
  delivered: boolean;
  /** Best-effort channel that actually accepted it. */
  channel: AlertChannel | 'none';
  /**
   * NOT_CONFIGURED is surfaced rather than hidden: an unconfigured alerting
   * path is a real operational gap, exactly like an unconfigured payment
   * provider (spec §24).
   */
  status: 'DELIVERED' | 'NOT_CONFIGURED' | 'FAILED';
  detail?: string;
}

/** Rendered payload handed to an installed sender. */
export interface RenderedAdminAlert {
  subject: string;
  text: string;
}

export type AdminAlertSender = (
  alert: FulfillmentAlert,
  rendered: RenderedAdminAlert,
) => Promise<void>;

let installedSender: AdminAlertSender | null = null;

/**
 * Installs the real delivery channel (an email provider send, a Slack webhook,
 * a PagerDuty call). Passing null removes it and falls back to the durable
 * queue + audit log path.
 */
export function setAdminAlertSender(sender: AdminAlertSender | null): void {
  installedSender = sender;
}

export function getAdminAlertSender(): AdminAlertSender | null {
  return installedSender;
}

const PREFIX = '[fulfillment-alert]';

function renderAlert(alert: FulfillmentAlert): RenderedAdminAlert {
  const lines: string[] = [
    `${PREFIX} ${alert.severity}: ${alert.title}`,
    '',
    `reason:   ${alert.reason}`,
  ];

  if (alert.orderReference) lines.push(`order:    ${alert.orderReference} (${alert.orderId ?? 'unknown id'})`);
  if (alert.productName) lines.push(`product:  ${alert.productName}`);
  if (alert.amountMinor !== undefined && alert.currency) {
    // Money is only ever rendered from integer minor units. The presentation is
    // deliberately "Price X / Value Y": the customer pays a PREMIUM over face
    // value, and this string must never read as the other way round.
    lines.push(`price:    ${formatMoney(alert.amountMinor, alert.currency)}`);
  }
  if (alert.faceValueMinor !== undefined && alert.currency) {
    lines.push(`value:    ${formatMoney(alert.faceValueMinor, alert.currency)} of redeem value`);
  }
  if (alert.customerEmail) lines.push(`customer: ${maskEmail(alert.customerEmail)}`);
  if (alert.attempts !== undefined) {
    lines.push(`attempts: ${alert.attempts}${alert.maxAttempts !== undefined ? ` of ${alert.maxAttempts}` : ''}`);
  }
  if (alert.jobId) lines.push(`job:      ${alert.jobId} (${alert.jobStatus ?? 'unknown'})`);
  if (alert.detail) lines.push(`detail:   ${alert.detail}`);
  lines.push('', 'Action: open the order in the admin panel, then requeue or refund it.');

  const subject = `${PREFIX} ${alert.severity}: ${alert.title}${
    alert.orderReference ? ` (${alert.orderReference})` : ''
  }`;

  return { subject, text: lines.join('\n') };
}

async function writeAuditRow(alert: FulfillmentAlert): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actor: 'fulfillment',
        action: alert.jobStatus === 'DEAD_LETTER' ? 'fulfillment.dead_letter' : 'fulfillment.failed',
        entity: 'Order',
        entityId: alert.orderId ?? null,
        metadata: {
          severity: alert.severity,
          title: alert.title,
          reason: alert.reason,
          detail: alert.detail ?? null,
          orderReference: alert.orderReference ?? null,
          productName: alert.productName ?? null,
          // Integer minor units only — never a float, never a parsed decimal.
          amountMinor: alert.amountMinor ?? null,
          faceValueMinor: alert.faceValueMinor ?? null,
          currency: alert.currency ?? null,
          customerEmailMasked: alert.customerEmail ? maskEmail(alert.customerEmail) : null,
          jobId: alert.jobId ?? null,
          attempts: alert.attempts ?? null,
          maxAttempts: alert.maxAttempts ?? null,
          jobStatus: alert.jobStatus ?? null,
        },
      },
    });
  } catch (error) {
    // The audit row is a belt-and-braces channel; losing it must never mask the
    // alert itself, so it is logged and the other channels continue.
    logger.error('Could not write fulfillment alert audit row', {
      orderId: alert.orderId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Raise an operational alert. Never throws: a failing alert path must not
 * replace the original fulfillment error with a different one.
 */
export async function notifyFulfillmentFailure(
  alert: FulfillmentAlert,
): Promise<AdminAlertResult> {
  const rendered = renderAlert(alert);

  logger.error(rendered.text, {
    orderId: alert.orderId,
    alert: {
      severity: alert.severity,
      title: alert.title,
      reason: alert.reason,
      attempts: alert.attempts,
      maxAttempts: alert.maxAttempts,
      jobStatus: alert.jobStatus,
    },
  });

  if (installedSender) {
    try {
      await installedSender(alert, rendered);
      await writeAuditRow(alert);
      return { delivered: true, channel: 'email', status: 'DELIVERED' };
    } catch (error) {
      logger.error('Admin alert sender failed; falling back to durable queue', {
        orderId: alert.orderId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Fall through to the durable channel rather than dropping the alert.
    }
  }

  if (inngestConfig.configured) {
    try {
      await inngest.send({
        name: 'redeem-store/ops.alert',
        data: {
          severity: alert.severity,
          title: alert.title,
          ...(alert.orderId === undefined ? {} : { orderId: alert.orderId }),
          ...(alert.orderReference === undefined ? {} : { orderReference: alert.orderReference }),
          reason: alert.reason,
          ...(alert.detail === undefined ? {} : { detail: alert.detail }),
          ...(alert.attempts === undefined ? {} : { attempts: alert.attempts }),
          ...(alert.maxAttempts === undefined ? {} : { maxAttempts: alert.maxAttempts }),
          occurredAt: new Date().toISOString(),
        },
      });
      await writeAuditRow(alert);
      return { delivered: true, channel: 'inngest', status: 'DELIVERED' };
    } catch (error) {
      logger.error('Could not enqueue ops alert', {
        orderId: alert.orderId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Still write the audit row so the failure is not invisible.
      await writeAuditRow(alert);
      return {
        delivered: false,
        channel: 'log',
        status: 'FAILED',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  await writeAuditRow(alert);
  return {
    delivered: false,
    channel: 'log',
    status: 'NOT_CONFIGURED',
    detail:
      'No admin alert channel: INNGEST_EVENT_KEY is unset and no alert sender is installed. ' +
      'The failure was recorded in AuditLog and logged at CRITICAL.',
  };
}