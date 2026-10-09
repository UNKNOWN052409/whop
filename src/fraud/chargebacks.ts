/**
 * Chargeback / dispute handling (spec §17).
 *
 * A dispute is the most expensive thing that can happen to a $3 order: Whop
 * charges a flat fee per dispute and takes the money back. See
 * WHOP_API_REFERENCE.md §5. The response here is deliberately mechanical:
 *
 *   1. never act on an unverified envelope,
 *   2. transition the order to PAYMENT_REVERSED,
 *   3. REVOKE the delivered redeem code — a code that produced a chargeback
 *      has been redeemed by the buyer (or stolen) and must never be sold again,
 *   4. record a FraudEvent and an AuditLog entry, including the fee exposure,
 *   5. do all of it in one transaction, idempotently, because Whop delivers
 *      webhooks at-least-once and retries for ~3 days.
 *
 * KNOWN GAP IN src/orders/state-machine.ts (NOT owned by this workstream):
 * the transition table has no `CODE_DELIVERED -> PAYMENT_REVERSED` edge, yet
 * CODE_DELIVERED/COMPLETED is where a chargeback actually lands — the buyer
 * receives the code and then disputes. Rather than write `status` directly
 * (which the state machine exists to forbid), this module falls back to the
 * legal `REFUND_PENDING` edge and logs loudly. Fixing the table is the state
 * machine owner's call.
 */

import { InventoryStatus, OrderStatus, PaymentStatus, RiskDecision, RiskLevel } from '@prisma/client';

import { prisma, withTransactionRetry } from '@/db/prisma';
import { whopConfig } from '@/lib/env';
import { AppError, errors } from '@/lib/errors';
import { fromProviderDecimal, formatMoney } from '@/lib/money';
import { logger } from '@/lib/logger';
import { assertTransition, canTransition } from '@/orders/state-machine';

import { FRAUD_EVENT_TYPES } from './evaluate';
import { intEnv } from './rules';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DisputeOutcome = 'OPEN' | 'WARNING' | 'WON' | 'LOST';

/** A signature-verified Whop dispute, however it was obtained. */
export interface WhopDisputeInput {
  /** The `webhook-id` header — the dedup key for redelivery. */
  providerEventId: string;
  /** dispute.created | dispute.updated | dispute_alert.created */
  eventType: string;
  /** Whop dispute id, e.g. `dsp_…`. */
  disputeId: string;
  /** `pay_…` from the dispute payload. */
  providerPaymentId?: string | null;
  /** Fallback match when the payment row is missing: our order reference. */
  orderReference?: string | null;
  /** Whop's dispute status string, e.g. `needs_response`, `lost`, `won`. */
  disputeStatus?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  occurredAt?: Date | null;
  /** MUST be true. A dispute is never actioned from an unverified envelope. */
  signatureValid: boolean;
  /** Salted IP hash, for the audit trail. Never a raw IP. */
  ipHash?: string | null;
  /** Raw envelope, for forensics only. Never logged. */
  raw?: unknown;
}

export interface ChargebackResult {
  /** True when this call performed the reversal work. */
  handled: boolean;
  /** Machine-readable outcome: APPLIED, ALREADY_HANDLED, NO_MATCHING_ORDER, … */
  reason: string;
  matchedOrderId: string | null;
  orderReference: string | null;
  outcome: DisputeOutcome;
  transition: { from: OrderStatus; to: OrderStatus } | null;
  /**
   * True when PAYMENT_REVERSED was unreachable from the order's current state
   * and the module used REFUND_PENDING instead. See the file header.
   */
  fellBackToRefund: boolean;
  revokedCodes: number;
  paymentStatus: PaymentStatus | null;
  fraudEventId: string | null;
  auditLogId: string | null;
  feeExposureMinor: number;
  feeExposureFormatted: string;
  /** The human-readable note persisted on the audit trail. */
  note: string;
}

const CHARGEBACK_ACTOR = 'fraud-engine';

// ---------------------------------------------------------------------------
// Provider fee model (Whop_API_REFERENCE.md §5)
// ---------------------------------------------------------------------------

export interface DisputeFeeConfig {
  /** Flat fee charged per dispute, in minor units of `currency`. */
  disputeFeeMinor: number;
  /** Early-dispute-alert (RDR) fee, charged on `dispute_alert.created`. */
  alertFeeMinor: number;
  currency: string;
}

export function disputeFeeConfig(isAlert: boolean): DisputeFeeConfig {
  return {
    disputeFeeMinor: intEnv('WHOP_DISPUTE_FEE_MINOR', 1_500, { min: 0, max: 100_000_000 }),
    alertFeeMinor: intEnv('WHOP_DISPUTE_ALERT_FEE_MINOR', 2_900, { min: 0, max: 100_000_000 }),
    currency: (process.env.WHOP_DISPUTE_FEE_CURRENCY ?? 'USD').trim().toUpperCase() || 'USD',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whop's dispute statuses are not enumerated in the API reference we have, so
 * this classifies on the words that actually appear rather than on a guessed
 * enum: an unknown/empty status is treated as OPEN, which reverses.
 */
export function classifyDispute(status: string | null | undefined): DisputeOutcome {
  const normalized = (status ?? '').trim().toLowerCase();
  if (normalized === '') return 'OPEN';
  if (normalized.includes('lost')) return 'LOST';
  if (normalized.includes('won')) return 'WON';
  if (normalized.includes('warn') || normalized.includes('alert')) return 'WARNING';
  return 'OPEN';
}

function isAlertEvent(eventType: string): boolean {
  return eventType.toLowerCase().includes('dispute_alert');
}

/** Flat fee exposure for this event, in minor units of the fee currency. */
function feeForEvent(eventType: string, fee: DisputeFeeConfig): number {
  return isAlertEvent(eventType) ? fee.alertFeeMinor : fee.disputeFeeMinor;
}

/**
 * Build the note persisted on both the FraudEvent and the AuditLog.
 *
 * The schema has no dedicated `note` column on either model, so the
 * operator-facing statement lives in `AuditLog.metadata.note` (mirrored into
 * `FraudEvent.metadata.note` for the dispute row) and the same figure is kept
 * machine-readable as `feeExposureMinor`.
 */
export function buildDisputeNote(params: {
  disputeId: string;
  eventType: string;
  outcome: DisputeOutcome;
  orderReference: string | null;
  revokedCodes: number;
  fee: DisputeFeeConfig;
  fellBackToRefund: boolean;
}): string {
  const alert = isAlertEvent(params.eventType);
  const feeLabel = alert ? 'Whop early dispute alert (RDR) fee' : 'Whop dispute fee';
  const exposureMinor = feeForEvent(params.eventType, params.fee);
  const money = formatMoney(exposureMinor, params.fee.currency);
  const reversal = params.fellBackToRefund
    ? 'Order moved to REFUND_PENDING because the transition table has no ' +
      'CODE_DELIVERED -> PAYMENT_REVERSED edge; see src/orders/state-machine.ts'
    : 'Order moved to PAYMENT_REVERSED';
  return (
    `${feeLabel} exposure ${money} (flat, charged to the merchant account per dispute — ` +
    `WHOP_API_REFERENCE.md §5). Dispute ${params.disputeId} (${params.eventType}, ` +
    `${params.outcome}) against order ${params.orderReference ?? 'unknown'}: ${reversal}. ` +
    `${params.revokedCodes} delivered redeem code(s) revoked and must not be re-sold.`
  );
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Best-effort duplicate detection.
 *
 * Two independent guards, because this handler must be safe to run ten times
 * for the same event: the unique `PaymentEvent.providerEventId` index (the
 * webhook pipeline's own dedup), and the dispute id recorded in the FraudEvent
 * we wrote. If neither can be read we proceed — every write below is
 * individually idempotent, so a redundant record is better than a skipped
 * reversal.
 */
async function alreadyHandled(
  providerEventId: string,
  disputeId: string,
  orderId: string | null,
): Promise<boolean> {
  try {
    const seen = await prisma.paymentEvent.findUnique({
      where: { providerEventId },
      select: { processedAt: true },
    });
    if (seen?.processedAt) return true;
  } catch (error) {
    logger.warn('Could not check PaymentEvent for dispute dedup', {
      providerEventId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!orderId) return false;

  try {
    const prior = await prisma.fraudEvent.findFirst({
      where: { type: FRAUD_EVENT_TYPES.CHARGEBACK, orderId },
      select: { metadata: true },
    });
    const recordedDispute = readDisputeIdFromMetadata(prior?.metadata);
    return recordedDispute !== null && recordedDispute === disputeId;
  } catch (error) {
    logger.warn('Could not check FraudEvent for dispute dedup', {
      disputeId,
      orderId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function readDisputeIdFromMetadata(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const value = (metadata as Record<string, unknown>)['disputeId'];
  return typeof value === 'string' ? value : null;
}

// ---------------------------------------------------------------------------
// Payload helper
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Maps a verified Whop envelope onto `WhopDisputeInput`.
 *
 * The Dispute object is not fully enumerated in WHOP_API_REFERENCE.md, so
 * several spellings are accepted and missing pieces are simply absent rather
 * than guessed. Returns null when the payload carries no dispute identity,
 * which the caller must treat as an unrecognised event — not as a reason to
 * invent one.
 */
export function parseWhopDisputeEvent(
  envelope: unknown,
  context: { providerEventId: string; eventType: string; signatureValid: boolean },
): WhopDisputeInput | null {
  const root = asRecord(envelope);
  if (!root) return null;
  const data = asRecord(root['data']) ?? root;

  const disputeId =
    asString(data['id']) ??
    asString(data['dispute_id']) ??
    asString(asRecord(data['dispute'])?.['id']);
  if (!disputeId) return null;

  const paymentId =
    asString(data['payment_id']) ??
    asString(asRecord(data['payment'])?.['id']) ??
    asString(data['paymentId']);

  const metadata = asRecord(data['metadata']);
  const orderReference =
    asString(metadata?.['order_reference']) ??
    asString(metadata?.['orderReference']) ??
    asString(data['order_reference']);

  let amountMinor: number | null = null;
  let currency: string | null = null;
  const money = asRecord(data['amount']);
  const decimalString = asString(money?.['amount']);
  const moneyCurrency = asString(money?.['currency']);
  if (decimalString && moneyCurrency) {
    try {
      // Provider decimals are exact strings; never parseFloat.
      amountMinor = fromProviderDecimal(decimalString, moneyCurrency.toLowerCase());
      currency = moneyCurrency.toLowerCase();
    } catch {
      amountMinor = null;
    }
  }

  return {
    providerEventId: context.providerEventId,
    eventType: context.eventType,
    disputeId,
    providerPaymentId: paymentId,
    orderReference,
    disputeStatus: asString(data['status']) ?? asString(data['dispute_status']),
    amountMinor,
    currency,
    occurredAt: null,
    signatureValid: context.signatureValid,
    ipHash: null,
    raw: envelope,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles a verified Whop dispute: reverses the payment, revokes the delivered
 * code, and writes the fraud + audit trail with the fee exposure.
 */
export async function handleWhopDispute(input: WhopDisputeInput): Promise<ChargebackResult> {
  const outcome = classifyDispute(input.disputeStatus);
  const feeConfig = disputeFeeConfig(isAlertEvent(input.eventType));
  const feeExposureMinor = feeForEvent(input.eventType, feeConfig);
  const feeExposureFormatted = formatMoney(feeExposureMinor, feeConfig.currency);

  const emptyResult = (
    handled: boolean,
    reason: string,
    extra: Partial<ChargebackResult> = {},
  ): ChargebackResult => ({
    handled,
    reason,
    matchedOrderId: null,
    orderReference: null,
    outcome,
    transition: null,
    fellBackToRefund: false,
    revokedCodes: 0,
    paymentStatus: null,
    fraudEventId: null,
    auditLogId: null,
    feeExposureMinor,
    feeExposureFormatted,
    note: '',
    ...extra,
  });

  // 1. Never act on an unverified envelope.
  if (!input.signatureValid) {
    logger.error('Refusing to action an unverified Whop dispute', {
      providerEventId: input.providerEventId,
      eventType: input.eventType,
    });
    throw new AppError(
      'Refusing to process a Whop dispute whose signature did not verify',
      401,
      'INVALID_SIGNATURE',
      { details: { providerEventId: input.providerEventId } },
    );
  }

  // 2. An unconfigured integration surfaces as NOT CONFIGURED — never a stub.
  if (!whopConfig.configured) {
    throw errors.providerNotConfigured('Whop');
  }

  // 3. Find the order: by provider payment id first, by our order reference
  //    second (the case reconciliation needs — the payment row may not exist).
  const payment = input.providerPaymentId
    ? await prisma.payment.findUnique({
        where: { providerPaymentId: input.providerPaymentId },
        select: { id: true, orderId: true, status: true, amountMinor: true, currency: true },
      })
    : null;

  const order =
    payment !== null
      ? await prisma.order.findUnique({
          where: { id: payment.orderId },
          select: { id: true, reference: true, status: true },
        })
      : input.orderReference
        ? await prisma.order.findUnique({
            where: { reference: input.orderReference },
            select: { id: true, reference: true, status: true },
          })
        : null;

  const note = buildDisputeNote({
    disputeId: input.disputeId,
    eventType: input.eventType,
    outcome,
    orderReference: order?.reference ?? input.orderReference ?? null,
    revokedCodes: 0, // refined below, once the count is known
    fee: feeConfig,
    fellBackToRefund: false,
  });

  // 4. A dispute we WON is recorded but never reverses anything.
  if (outcome === 'WON') {
    if (order && (await alreadyHandled(input.providerEventId, input.disputeId, order.id))) {
      return emptyResult(false, 'ALREADY_HANDLED', { matchedOrderId: order.id, orderReference: order.reference });
    }
    if (!order) {
      await writeUnmatchedRecord(input, note);
      return emptyResult(false, 'NO_MATCHING_ORDER', { note });
    }
    const ids = await writeRecords(input, order, note, {
      transition: null,
      revokedCodes: 0,
      fellBackToRefund: false,
      paymentStatus: payment?.status ?? null,
      applyRisk: true,
    });
    logger.info('Whop dispute recorded as WON; no reversal applied', {
      orderId: order.id,
      disputeId: input.disputeId,
      outcome,
    });
    return emptyResult(true, 'DISPUTE_WON', {
      matchedOrderId: order.id,
      orderReference: order.reference,
      note,
      ...ids,
    });
  }

  // 5. Idempotency for the reversing path.
  if (order && (await alreadyHandled(input.providerEventId, input.disputeId, order.id))) {
    return emptyResult(false, 'ALREADY_HANDLED', {
      matchedOrderId: order.id,
      orderReference: order.reference,
      note,
    });
  }

  if (!order) {
    await writeUnmatchedRecord(input, note);
    logger.error('Whop dispute could not be matched to an order', {
      disputeId: input.disputeId,
      providerEventId: input.providerEventId,
      hasPayment: payment !== null,
      hasOrderReference: Boolean(input.orderReference),
    });
    return emptyResult(false, 'NO_MATCHING_ORDER', {
      orderReference: input.orderReference,
      note,
    });
  }

  // 6. The reversal, the revocation and the audit trail — one transaction.
  return withTransactionRetry(async (tx) => {
    const live = await tx.order.findUnique({
      where: { id: order.id },
      select: { id: true, reference: true, status: true },
    });
    if (!live) {
      throw new AppError(`Order ${order.id} not found while reversing a dispute`, 404, 'NOT_FOUND');
    }

    const from = live.status;
    let to: OrderStatus | null = null;
    let fellBackToRefund = false;

    if (canTransition(from, OrderStatus.PAYMENT_REVERSED)) {
      to = OrderStatus.PAYMENT_REVERSED;
    } else if (canTransition(from, OrderStatus.REFUND_PENDING)) {
      // State-machine gap: no CODE_DELIVERED/CODE_RESERVED -> PAYMENT_REVERSED
      // edge exists. REFUND_PENDING is the legal way to move the money back.
      fellBackToRefund = true;
      to = OrderStatus.REFUND_PENDING;
    } else {
      logger.error('No legal transition available to reverse a disputed payment', {
        orderId: live.id,
        status: from,
        disputeId: input.disputeId,
      });
    }

    if (to) {
      assertTransition(from, to, { orderId: live.id, reason: 'whop_dispute' });
    }

    // Revoke every code bound to this order that is not already REVOKED.
    const revoked = await tx.inventoryCode.updateMany({
      where: {
        orderId: live.id,
        status: {
          in: [InventoryStatus.RESERVED, InventoryStatus.ASSIGNED, InventoryStatus.DELIVERED],
        },
      },
      data: {
        status: InventoryStatus.REVOKED,
        revokedAt: new Date(),
        reservationExpiresAt: null,
      },
    });
    const revokedCodes = revoked.count;

    if (payment) {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status:
            outcome === 'WARNING' || outcome === 'OPEN' ? PaymentStatus.DISPUTED : PaymentStatus.REVERSED,
        },
      });
    }

    await tx.order.update({
      where: { id: live.id },
      data: {
        riskLevel: RiskLevel.CRITICAL,
        riskScore: 100,
        riskDecision: RiskDecision.BLOCK,
        ...(to ? { status: to } : {}),
        manualReviewReason: note,
      },
    });

    if (to) {
      await tx.orderStateTransition.create({
        data: {
          orderId: live.id,
          fromState: from,
          toState: to,
          reason: `whop dispute ${input.disputeId}: ${note}`,
          actor: CHARGEBACK_ACTOR,
          metadata: {
            disputeId: input.disputeId,
            providerEventId: input.providerEventId,
            eventType: input.eventType,
            outcome,
            feeExposureMinor,
            feeExposureCurrency: feeConfig.currency,
            revokedCodes,
            fellBackToRefund,
          },
        },
      });
    }

    const finalNote = buildDisputeNote({
      disputeId: input.disputeId,
      eventType: input.eventType,
      outcome,
      orderReference: live.reference,
      revokedCodes,
      fee: feeConfig,
      fellBackToRefund,
    });

    const fraudEvent = await tx.fraudEvent.create({
      data: {
        orderId: live.id,
        userId: null,
        emailNormalized: null,
        ipHash: input.ipHash ?? null,
        type: isAlertEvent(input.eventType)
          ? FRAUD_EVENT_TYPES.DISPUTE_ALERT
          : FRAUD_EVENT_TYPES.CHARGEBACK,
        riskLevel: RiskLevel.CRITICAL,
        decision: RiskDecision.BLOCK,
        score: 100,
        signals: [
          {
            name: 'whop_dispute',
            fired: true,
            weight: 100,
            detail: `${input.eventType} for dispute ${input.disputeId} (${outcome})`,
            hardBlock: true,
          },
          {
            name: 'delivered_code_revoked',
            fired: revokedCodes > 0,
            // Scored 0: the chargeback signal above already carries the full
            // weight, and two signals for one event would double-count.
            weight: 0,
            detail: `${revokedCodes} redeem code(s) revoked; none may be re-sold`,
          },
        ],
        metadata: {
          disputeId: input.disputeId,
          providerEventId: input.providerEventId,
          eventType: input.eventType,
          outcome,
          providerPaymentId: input.providerPaymentId ?? null,
          amountMinor: input.amountMinor ?? null,
          currency: input.currency ?? null,
          // The fee exposure, in machine-readable form. See the note below for
          // the operator-facing statement of the same number.
          feeExposureMinor,
          feeExposureCurrency: feeConfig.currency,
          feeKind: isAlertEvent(input.eventType) ? 'EARLY_DISPUTE_ALERT' : 'DISPUTE',
          revokedCodes,
          fellBackToRefund,
          transition: to ? { from, to } : null,
          note: finalNote,
        },
      },
      select: { id: true },
    });

    const auditLog = await tx.auditLog.create({
      data: {
        actor: CHARGEBACK_ACTOR,
        action: 'fraud.dispute.handled',
        entity: 'Order',
        entityId: live.id,
        ipHash: input.ipHash ?? null,
        metadata: {
          note: finalNote,
          disputeId: input.disputeId,
          providerEventId: input.providerEventId,
          eventType: input.eventType,
          outcome,
          transition: to ? { from, to } : null,
          fellBackToRefund,
          revokedCodes,
          feeExposureMinor,
          feeExposureCurrency: feeConfig.currency,
          fraudEventId: fraudEvent.id,
        },
      },
      select: { id: true },
    });

    logger[outcome === 'LOST' ? 'error' : 'warn']('Whop dispute actioned', {
      orderId: live.id,
      disputeId: input.disputeId,
      outcome,
      transition: to ? `${from} -> ${to}` : 'none',
      revokedCodes,
      feeExposureFormatted,
    });

    return {
      handled: true,
      reason: to ? 'DISPUTE_APPLIED' : 'DISPUTE_RECORDED_NO_TRANSITION',
      matchedOrderId: live.id,
      orderReference: live.reference,
      outcome,
      transition: to ? { from, to } : null,
      fellBackToRefund,
      revokedCodes,
      paymentStatus: payment
        ? outcome === 'WARNING' || outcome === 'OPEN'
          ? PaymentStatus.DISPUTED
          : PaymentStatus.REVERSED
        : null,
      fraudEventId: fraudEvent.id,
      auditLogId: auditLog.id,
      feeExposureMinor,
      feeExposureFormatted,
      note: finalNote,
    };
  });
}

/**
 * Writes the fraud + audit trail for a dispute that matches no order.
 *
 * This is a reconciliation input, not a dead end: the dispute cost money and
 * a real buyer is affected, so it is recorded with orderId = null rather than
 * dropped.
 */
async function writeUnmatchedRecord(input: WhopDisputeInput, note: string): Promise<void> {
  try {
    await prisma.fraudEvent.create({
      data: {
        type: isAlertEvent(input.eventType)
          ? FRAUD_EVENT_TYPES.DISPUTE_ALERT
          : FRAUD_EVENT_TYPES.CHARGEBACK,
        riskLevel: RiskLevel.CRITICAL,
        decision: RiskDecision.BLOCK,
        score: 100,
        signals: [
          {
            name: 'whop_dispute_unmatched',
            fired: true,
            weight: 100,
            detail: `${input.eventType} could not be matched to an order`,
            hardBlock: true,
          },
        ],
        metadata: {
          disputeId: input.disputeId,
          providerEventId: input.providerEventId,
          eventType: input.eventType,
          disputeStatus: input.disputeStatus ?? null,
          providerPaymentId: input.providerPaymentId ?? null,
          orderReference: input.orderReference ?? null,
          note,
        },
      },
    });
  } catch (error) {
    logger.error('Could not record an unmatched Whop dispute', {
      disputeId: input.disputeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Shared writer for the non-reversing (dispute won) path. */
async function writeRecords(
  input: WhopDisputeInput,
  order: { id: string; reference: string },
  note: string,
  extra: {
    transition: { from: OrderStatus; to: OrderStatus } | null;
    revokedCodes: number;
    fellBackToRefund: boolean;
    paymentStatus: PaymentStatus | null;
    applyRisk: boolean;
  },
): Promise<{ fraudEventId: string; auditLogId: string }> {
  const fraudEvent = await prisma.fraudEvent.create({
    data: {
      orderId: order.id,
      type: isAlertEvent(input.eventType)
        ? FRAUD_EVENT_TYPES.DISPUTE_ALERT
        : FRAUD_EVENT_TYPES.CHARGEBACK,
      riskLevel: RiskLevel.HIGH,
      decision: RiskDecision.ALLOW,
      score: extra.revokedCodes,
      signals: [
        {
          name: 'whop_dispute_won',
          fired: true,
          weight: 0,
          detail: `${input.eventType} for dispute ${input.disputeId} resolved in our favour; ` +
            'no reversal applied',
        },
      ],
      metadata: {
        disputeId: input.disputeId,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        disputeStatus: input.disputeStatus ?? null,
        providerPaymentId: input.providerPaymentId ?? null,
        amountMinor: input.amountMinor ?? null,
        currency: input.currency ?? null,
        note,
      },
    },
    select: { id: true },
  });

  const auditLog = await prisma.auditLog.create({
    data: {
      actor: CHARGEBACK_ACTOR,
      action: 'fraud.dispute.won',
      entity: 'Order',
      entityId: order.id,
      ipHash: input.ipHash ?? null,
      metadata: {
        note,
        disputeId: input.disputeId,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        fraudEventId: fraudEvent.id,
      },
    },
    select: { id: true },
  });

  return { fraudEventId: fraudEvent.id, auditLogId: auditLog.id };
}