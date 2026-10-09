/**
 * Order risk evaluation (spec §17).
 *
 * `evaluateOrderRisk` is the gate between "a payment verified" and "a redeem
 * code leaves the building". It:
 *
 *   1. runs the rule engine (src/fraud/rules.ts) against order history,
 *   2. sums the fired weights into a 0-100 score,
 *   3. maps that to a RiskLevel and a RiskDecision,
 *   4. persists a FraudEvent for EVERY evaluation (pass included — an audit
 *      trail that only records failures cannot answer "why was this allowed?"),
 *   5. and, on REVIEW or BLOCK, moves the order to MANUAL_REVIEW through
 *      `assertTransition` so the fulfillment pipeline's risk check refuses to
 *      allocate inventory.
 *
 * The write path is transactional and re-reads the order's status inside the
 * transaction: a webhook racing a manual review must not be able to drag a
 * COMPLETED order backwards through a stale snapshot.
 */

import {
  OrderStatus,
  RiskDecision as RiskDecisionEnum,
  RiskLevel as RiskLevelEnum,
} from '@prisma/client';

import { prisma, withTransactionRetry, type Prisma } from '@/db/prisma';
import { AppError } from '@/lib/errors';
import { normalizeEmail, piiHash } from '@/lib/ids';
import { logger } from '@/lib/logger';
import { assertTransition, canTransition, isTerminal } from '@/orders/state-machine';

import {
  emailDomainOf,
  fraudThresholds,
  runFraudRules,
  type FraudDb,
  type FraudOrderSnapshot,
  type FraudSignal,
  type FraudThresholds,
} from './rules';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** FraudEvent.type values written by this module. Stable strings for the admin UI. */
export const FRAUD_EVENT_TYPES = {
  ORDER_RISK_EVALUATION: 'ORDER_RISK_EVALUATION',
  CHARGEBACK: 'CHARGEBACK',
  DISPUTE_ALERT: 'DISPUTE_ALERT',
} as const;

export type FraudEventType = (typeof FRAUD_EVENT_TYPES)[keyof typeof FRAUD_EVENT_TYPES];

export type { FraudOrderSnapshot, FraudSignal };

export interface EvaluateOrderRiskInput {
  /**
   * The order under evaluation. Only the fields the rules are allowed to see
   * are read; a full Prisma `Order` satisfies this shape as-is.
   */
  order: FraudOrderSnapshot;
  /**
   * The buyer's address. Used ONLY to derive `normalizeEmail` + `piiHash`.
   * Neither this value nor its domain-free derivatives are written anywhere
   * except the (already stored) Order row and the salted hash on FraudEvent.
   */
  email: string;
  /** Salted hash of the client IP, when the caller has one. Never a raw IP. */
  ipHash?: string;
  /** Buyer billing region, when the provider exposes one. */
  billingRegion?: string | null;
  /** Provider payment id already bound to this order, for the duplicate check. */
  providerPaymentId?: string | null;
  /** Defaults to `order.userId`. */
  userId?: string | null;
  /** Injectable for tests; defaults to the Prisma singleton. */
  db?: FraudDb;
}

export interface RiskEvaluation {
  orderId: string;
  orderReference: string;
  /** 0-100, clamped. */
  score: number;
  riskLevel: RiskLevelEnum;
  decision: RiskDecisionEnum;
  /** One entry per rule, in rule order. */
  signals: FraudSignal[];
  /** Names of the rules that fired. */
  firedRules: string[];
  /** The heaviest fired signal's `detail`, for the operator queue. */
  topDetail: string | null;
  /** The order status after this evaluation (MANUAL_REVIEW when held). */
  orderStatus: OrderStatus;
  /** True when the order was moved to MANUAL_REVIEW by this evaluation. */
  heldForReview: boolean;
  /** True when a REVIEW/BLOCK was requested but no legal transition existed. */
  holdSuppressed: boolean;
  emailHash: string | null;
  fraudEventId: string | null;
  /** True when part of the evaluation could not run (missing key, DB fault). */
  degraded: boolean;
  thresholds: FraudThresholds;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoreResult {
  score: number;
  riskLevel: RiskLevelEnum;
  decision: RiskDecisionEnum;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Weighted sum → level → decision.
 *
 * A `hardBlock` signal short-circuits the thresholds: a provider payment id
 * bound to two orders is an integrity failure that no number of benign
 * behaviours can out-weigh.
 */
export function scoreSignals(
  signals: readonly FraudSignal[],
  thresholds: FraudThresholds,
): ScoreResult {
  const score = clampScore(signals.reduce((total, s) => total + (s.fired ? s.weight : 0), 0));
  const hardBlocked = signals.some((s) => s.fired && s.hardBlock === true);

  let riskLevel: RiskLevelEnum;
  if (score >= thresholds.riskCriticalScore) riskLevel = RiskLevelEnum.CRITICAL;
  else if (score >= thresholds.riskHighScore) riskLevel = RiskLevelEnum.HIGH;
  else if (score >= thresholds.riskMediumScore) riskLevel = RiskLevelEnum.MEDIUM;
  else riskLevel = RiskLevelEnum.LOW;

  let decision: RiskDecisionEnum;
  if (hardBlocked || score >= thresholds.riskHighScore) decision = RiskDecisionEnum.BLOCK;
  else if (score >= thresholds.riskMediumScore) decision = RiskDecisionEnum.REVIEW;
  else decision = RiskDecisionEnum.ALLOW;

  return { score, riskLevel, decision };
}

function heaviestSignal(signals: readonly FraudSignal[]): FraudSignal | null {
  let best: FraudSignal | null = null;
  for (const s of signals) {
    if (!s.fired) continue;
    if (!best || s.weight > best.weight) best = s;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function manualReviewReason(score: ScoreResult, topDetail: string | null): string {
  const fired = topDetail ? `Top signal: ${topDetail}` : 'No individual signal detail available.';
  return (
    `Automated risk hold (${score.riskLevel}, score ${score.score}, decision ${score.decision}). ` +
    `${fired} Held by the fraud engine before any inventory is released.`
  );
}

/**
 * Score an order, persist the outcome, and park it in MANUAL_REVIEW when the
 * decision is not ALLOW.
 *
 * FAIL-SAFE: if the fingerprint key is missing, the email-keyed rules cannot
 * run at all. Rather than failing open — evaluating "no risk" because we could
 * not look — the order is hard-blocked into MANUAL_REVIEW. In production this
 * cannot happen (`assertProductionConfig` refuses to boot without the key); in
 * a half-configured dev environment it means orders are parked, which is the
 * honest state.
 */
export async function evaluateOrderRisk(input: EvaluateOrderRiskInput): Promise<RiskEvaluation> {
  const db = input.db ?? (prisma as unknown as FraudDb);
  const now = new Date();
  const thresholds = fraudThresholds();

  const emailNormalized =
    input.order.customerEmailNormalized?.trim() || normalizeEmail(input.email);
  const emailDomain = emailDomainOf(emailNormalized);
  const userId = input.userId ?? input.order.userId ?? null;

  let degraded = false;
  let emailHash: string | null = null;
  try {
    emailHash = piiHash(emailNormalized);
  } catch (error) {
    degraded = true;
    logger.error('Cannot fingerprint the customer email for fraud evaluation', {
      orderId: input.order.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let signals: FraudSignal[];
  if (emailHash === null) {
    signals = [
      {
        name: 'fingerprint_key_unavailable',
        fired: true,
        weight: thresholds.riskCriticalScore,
        detail:
          'FINGERPRINT_KEY / ENCRYPTION_KEY is not set, so this order could not be ' +
          'risk-evaluated. Held rather than allowed blind.',
        hardBlock: true,
      },
    ];
  } else {
    signals = await runFraudRules({
      db,
      now,
      order: input.order,
      emailHash,
      emailNormalized,
      emailDomain,
      ipHash: input.ipHash,
      billingRegion: input.billingRegion ?? null,
      providerPaymentId: input.providerPaymentId ?? null,
      thresholds,
    });
  }

  const scored = scoreSignals(signals, thresholds);
  const top = heaviestSignal(signals);
  const firedRules = signals.filter((s) => s.fired).map((s) => s.name);
  const wantsHold = scored.decision !== RiskDecisionEnum.ALLOW;
  const reason = manualReviewReason(scored, top?.detail ?? null);

  const persisted = await withTransactionRetry(async (tx) => {
    // Re-read inside the transaction: the status the caller passed may already
    // be stale, and a transition computed from a stale status is a bug.
    const live = await tx.order.findUnique({
      where: { id: input.order.id },
      select: { id: true, status: true },
    });

    if (!live) {
      throw new AppError(
        `Order ${input.order.id} not found while evaluating risk`,
        404,
        'NOT_FOUND',
      );
    }

    let nextStatus = live.status;
    let heldForReview = false;
    let holdSuppressed = false;

    if (wantsHold) {
      if (canTransition(live.status, OrderStatus.MANUAL_REVIEW) && !isTerminal(live.status)) {
        assertTransition(live.status, OrderStatus.MANUAL_REVIEW, {
          orderId: live.id,
          reason: 'fraud_engine_hold',
        });
        nextStatus = OrderStatus.MANUAL_REVIEW;
        heldForReview = true;
      } else {
        holdSuppressed = true;
        logger.warn('Risk hold requested but the order has no legal edge to MANUAL_REVIEW', {
          orderId: live.id,
          status: live.status,
          score: scored.score,
          decision: scored.decision,
        });
      }
    }

    const data: Prisma.OrderUpdateInput = {
      riskLevel: scored.riskLevel,
      riskScore: scored.score,
      riskDecision: scored.decision,
      // Recorded on a hold even when the transition itself was suppressed: the
      // operator still needs to know why this order was flagged. Left untouched
      // on an ALLOW — clearing it is `resolveOrderRiskReview`'s job, not the
      // engine's, so a good score never silently un-park a human decision.
      ...(wantsHold ? { manualReviewReason: reason } : {}),
    };
    if (heldForReview) {
      data.status = OrderStatus.MANUAL_REVIEW;
    }

    await tx.order.update({ where: { id: live.id }, data });

    if (heldForReview) {
      await tx.orderStateTransition.create({
        data: {
          orderId: live.id,
          fromState: live.status,
          toState: OrderStatus.MANUAL_REVIEW,
          reason,
          actor: 'fraud-engine',
          metadata: {
            score: scored.score,
            riskLevel: scored.riskLevel,
            decision: scored.decision,
            firedRules,
            ruleFailure: degraded,
          },
        },
      });
    }

    const fraudEvent = await tx.fraudEvent.create({
      data: {
        orderId: live.id,
        userId,
        emailNormalized: emailHash,
        ipHash: input.ipHash ?? null,
        type: FRAUD_EVENT_TYPES.ORDER_RISK_EVALUATION,
        riskLevel: scored.riskLevel,
        decision: scored.decision,
        score: scored.score,
        // signals are counts and integers only — no email, IP, card or code.
        signals: signals as unknown as Prisma.InputJsonValue,
        metadata: {
          firedRules,
          heldForReview,
          holdSuppressed,
          degraded,
          ruleCount: signals.length,
          currency: input.order.currency,
          totalMinor: input.order.totalMinor,
          thresholds: {
            medium: thresholds.riskMediumScore,
            high: thresholds.riskHighScore,
            critical: thresholds.riskCriticalScore,
          },
        },
      },
      select: { id: true },
    });

    return { fraudEventId: fraudEvent.id, nextStatus, heldForReview, holdSuppressed };
  });

  if (persisted.heldForReview) {
    logger.warn('Order held for manual review by the fraud engine', {
      orderId: input.order.id,
      score: scored.score,
      riskLevel: scored.riskLevel,
      decision: scored.decision,
      firedRules,
    });
  } else if (firedRules.length > 0) {
    logger.info('Order risk evaluated', {
      orderId: input.order.id,
      score: scored.score,
      riskLevel: scored.riskLevel,
      decision: scored.decision,
      firedRules,
    });
  }

  return {
    orderId: input.order.id,
    orderReference: input.order.reference,
    score: scored.score,
    riskLevel: scored.riskLevel,
    decision: scored.decision,
    signals,
    firedRules,
    topDetail: top?.detail ?? null,
    orderStatus: persisted.nextStatus,
    heldForReview: persisted.heldForReview,
    holdSuppressed: persisted.holdSuppressed,
    emailHash,
    fraudEventId: persisted.fraudEventId,
    degraded,
    thresholds,
  };
}

// ---------------------------------------------------------------------------
// Operator resolution
// ---------------------------------------------------------------------------

export type RiskReviewResolution = 'ALLOW' | 'REFUND' | 'CANCEL';

const RESOLUTION_TARGET: Record<RiskReviewResolution, OrderStatus> = {
  ALLOW: OrderStatus.FULFILLMENT_PENDING,
  REFUND: OrderStatus.REFUND_PENDING,
  CANCEL: OrderStatus.CANCELLED,
};

/**
 * Releases (or rejects) an order that the fraud engine parked in
 * MANUAL_REVIEW.
 *
 * MANUAL_REVIEW is a parking state, not a terminal one: without this the only
 * way out would be a hand-written UPDATE, which is exactly the "state moves
 * only through the transition table" rule the rest of the system enforces.
 */
export async function resolveOrderRiskReview(params: {
  orderId: string;
  resolution: RiskReviewResolution;
  actor: string;
  note?: string;
  userId?: string | null;
}): Promise<{ orderId: string; from: OrderStatus; to: OrderStatus; note: string | null }> {
  const note = params.note?.trim() || null;

  return withTransactionRetry(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: params.orderId },
      select: { id: true, status: true, riskDecision: true },
    });
    if (!order) {
      throw new AppError(`Order ${params.orderId} not found`, 404, 'NOT_FOUND');
    }

    const to = RESOLUTION_TARGET[params.resolution];
    assertTransition(order.status, to, {
      orderId: order.id,
      reason: `risk_review_${params.resolution.toLowerCase()}`,
    });

    await tx.order.update({
      where: { id: order.id },
      data: {
        status: to,
        riskDecision:
          params.resolution === 'ALLOW' ? RiskDecisionEnum.ALLOW : RiskDecisionEnum.BLOCK,
        manualReviewReason: note ?? null,
      },
    });

    await tx.orderStateTransition.create({
      data: {
        orderId: order.id,
        fromState: order.status,
        toState: to,
        reason: note ?? `risk review resolved: ${params.resolution}`,
        actor: params.actor,
        metadata: { resolution: params.resolution },
      },
    });

    // Close the open evaluation(s) that caused the hold.
    await tx.fraudEvent.updateMany({
      where: { orderId: order.id, resolvedAt: null, type: FRAUD_EVENT_TYPES.ORDER_RISK_EVALUATION },
      data: {
        resolvedAt: new Date(),
        resolution: `${params.resolution} by ${params.actor}${note ? `: ${note}` : ''}`,
      },
    });

    return { orderId: order.id, from: order.status, to, note };
  });
}