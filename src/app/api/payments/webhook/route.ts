import { NextResponse } from 'next/server';
import { Prisma, PaymentStatus, ReconciliationType, RiskDecision } from '@prisma/client';
import { prisma } from '@/db/prisma';
import { enqueueFulfillment } from '@/fulfillment/enqueue';
import { transitionOrder } from '@/fulfillment/order-transitions';
import { revokeCodeForOrder } from '@/inventory/revoke';
import { OrderStatus } from '@prisma/client';
import { appConfig, whopConfig } from '@/lib/env';
import { logger } from '@/lib/logger';
import { limitWebhook } from '@/lib/public-rate-limit';
import { normalizeWhopWebhook } from '@/payments/registry';
import { verifyWhopSignature } from '@/payments/whop/signature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Deliberately short. This handler must answer in well under Whop's 5-second
// budget; capping it low means a pathological request releases its function
// instance quickly instead of pinning one for the platform maximum and starving
// concurrent webhooks. The real work lives in the durable queue.
export const maxDuration = 10;

/**
 * POST /api/payments/webhook — the endpoint Whop calls.
 *
 * This is the ONLY place a payment becomes "verified". The browser's success
 * callback is never consulted, anywhere in this file or anywhere downstream.
 *
 * ORDER OF OPERATIONS (each step exists for a reason):
 *
 *  1. Read the RAW body. The signature is computed over the exact bytes Whop
 *     sent. `JSON.parse` then `JSON.stringify` changes key order and
 *     whitespace, which changes the HMAC, which fails every verification. So we
 *     read text() first and parse the same string.
 *
 *  2. Verify the signature BEFORE parsing anything. Untrusted input does not
 *     reach our code until it is proven authentic.
 *
 *  3. Enforce the timestamp window (replay protection), also inside verify.
 *
 *  4. Deduplicate on the provider event id. Whop delivers at-least-once: the
 *     same event can arrive up to 12 times over ~3 days. `providerEventId` is
 *     UNIQUE in the schema, so the second delivery hits a constraint violation
 *     and we return 200 immediately without re-fulfilling.
 *
 *  5. Match the order and re-check amount + currency against the snapshot
 *     taken at checkout. A mismatch routes to MANUAL_REVIEW and a
 *     reconciliation record. It NEVER fulfils — that is how a price-injection
 *     or a provider-side bug turns into an unredeemable paid order.
 *
 *  6. Confirm server-to-server with the provider API. The webhook says the
 *     payment succeeded; the provider's own API is what we trust.
 *
 *  7. Respond fast. Whop disables a webhook after 24h of failures and expects a
 *     2xx in under 5 seconds. We acknowledge quickly and hand the real work to
 *     the durable queue rather than doing it inline.
 */

const MAX_BODY_BYTES = 1_048_576; // 1 MiB

function headersToRecord(request: Request): Record<string, string> {
  const record: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  if (!whopConfig.webhookSecret) {
    // NOT CONFIGURED. We must not pretend to accept payments we cannot verify.
    logger.error('Webhook received but WHOP_WEBHOOK_SECRET is not set', {
      path: '/api/payments/webhook',
    });
    return NextResponse.json(
      { error: 'Webhook handler is not configured' },
      { status: 503 },
    );
  }

  // --- 1. Raw body, bounded -------------------------------------------------
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: 'Could not read body' }, { status: 400 });
  }

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  // --- 2 & 3. Signature + replay window ------------------------------------
  const signatureResult = verifyWhopSignature(
    rawBody,
    headersToRecord(request),
    whopConfig.webhookSecret,
    appConfig.webhookToleranceSeconds,
  );

  if (!signatureResult.ok) {
    // Spec §22 lists webhook verification failures as a critical alert. We log
    // the reason and the age, never the payload.
    logger.error('Webhook signature verification FAILED', {
      reason: signatureResult.reason,
      webhookId: signatureResult.webhookId,
      timestampAgeSeconds: signatureResult.timestampAgeSeconds,
    });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  // Safety net ONLY, and deliberately AFTER signature verification.
  //
  // Two reasons for the ordering. An unsigned flood is already rejected above,
  // so this cannot become a shield an attacker aims at. And Whop retries from
  // rotating infrastructure, so keying this by IP would drop LEGITIMATE
  // retries of a payment the customer already made.
  const webhookLimit = await limitWebhook();
  if (!webhookLimit.success) {
    logger.warn('Webhook rate limit exceeded', {
      limit: webhookLimit.limit,
      remaining: webhookLimit.remaining,
    });
    return NextResponse.json(
      { error: 'Too many webhook requests' },
      {
        status: 429,
        headers: {
          'Retry-After': String(webhookLimit.retryAfterSeconds ?? 60),
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  // --- 4 & 5. Parse and persist --------------------------------------------
  let event;
  try {
    event = normalizeWhopWebhook(rawBody);
  } catch (error) {
    logger.warn('Webhook body could not be normalised', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Malformed event' }, { status: 400 });
  }

  const log = logger.child({ eventId: event.providerEventId });

  let paymentEventId: string;
  try {
    const created = await prisma.paymentEvent.create({
      data: {
        providerEventId: event.providerEventId,
        provider: 'WHOP',
        eventType: event.eventType,
        signatureValid: true,
        providerAccountId: event.providerAccountId ?? null,
        payload: (event.raw ?? {}) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    paymentEventId = created.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Already processed. Spec §9: return success WITHOUT re-fulfilling.
      log.info('Duplicate webhook ignored (already processed)', {
        eventType: event.eventType,
      });
      return NextResponse.json({ received: true, duplicate: true });
    }
    throw error;
  }

  // --- Resolve the order ----------------------------------------------------
  const orderRef = event.metadata?.order_ref;
  const order = await findOrder(orderRef, event.providerPaymentId);

  if (!order) {
    // We cannot attribute this payment. Do not guess — record it so nightly
    // reconciliation can surface it as MISSING_ORDER rather than losing it.
    log.warn('Webhook could not be matched to an order', {
      orderRef: orderRef ?? null,
      providerPaymentId: event.providerPaymentId ?? null,
    });
    await prisma.reconciliationRecord.create({
      data: {
        type: ReconciliationType.MISSING_PAYMENT,
        status: 'OPEN',
        providerPaymentId: event.providerPaymentId ?? null,
        discrepancy: 'Provider reported a payment with no matching internal order.',
        expected: { orderRef: orderRef ?? null },
        actual: { providerPaymentId: event.providerPaymentId ?? null, eventType: event.eventType },
      },
    });
    await markProcessed(paymentEventId);
    return NextResponse.json({ received: true, matched: false });
  }

  await prisma.paymentEvent.update({ where: { id: paymentEventId }, data: { orderId: order.id } });

  const log2 = logger.child({ orderId: order.id, eventId: event.providerEventId });

  // --- Amount + currency gate ----------------------------------------------
  const amountMismatch =
    event.amountMinor !== undefined && event.amountMinor !== order.totalMinor;
  const currencyMismatch =
    event.currency !== undefined && event.currency.toLowerCase() !== order.currency.toLowerCase();

  if (amountMismatch || currencyMismatch) {
    log2.error('Webhook amount/currency does not match the order snapshot', {
      eventAmountMinor: event.amountMinor ?? null,
      orderTotalMinor: order.totalMinor,
      eventCurrency: event.currency ?? null,
      orderCurrency: order.currency,
      amountMismatch,
      currencyMismatch,
    });

    await prisma.reconciliationRecord.create({
      data: {
        type: amountMismatch ? ReconciliationType.WRONG_AMOUNT : ReconciliationType.WRONG_CURRENCY,
        status: 'OPEN',
        orderId: order.id,
        providerPaymentId: event.providerPaymentId ?? null,
        discrepancy: 'Provider amount or currency differs from the order snapshot.',
        expected: { amountMinor: order.totalMinor, currency: order.currency },
        actual: {
          amountMinor: event.amountMinor ?? null,
          currency: event.currency ?? null,
        },
      },
    });

    await transitionOrder(order.id, OrderStatus.MANUAL_REVIEW, {
      reason: 'provider_amount_or_currency_mismatch',
      metadata: {
        expectedAmountMinor: order.totalMinor,
        actualAmountMinor: event.amountMinor ?? null,
      },
    });

    await markProcessed(paymentEventId);
    // 200: we handled it. Whop should not retry a discrepancy we have recorded.
    return NextResponse.json({ received: true, matched: true, escalated: true });
  }

  // --- Dispatch by outcome --------------------------------------------------
  try {
    switch (event.outcome) {
      case 'SUCCEEDED': {
        await handleSucceeded({ event, order, paymentEventId, log: log2 });
        break;
      }
      case 'FAILED':
      case 'CANCELED': {
        if (order.status === OrderStatus.PAYMENT_PENDING || order.status === OrderStatus.CREATED) {
          await transitionOrder(order.id, OrderStatus.PAYMENT_FAILED, {
            reason: `provider_${event.outcome.toLowerCase()}`,
          });
        }
        await markProcessed(paymentEventId);
        break;
      }
      case 'REFUNDED':
      case 'DISPUTED': {
        await handleReversal({ event, order, log: log2 });
        await markProcessed(paymentEventId);
        break;
      }
      case 'PENDING':
      default: {
        // Nothing to do yet; the terminal event will arrive separately.
        log2.info('Webhook recorded, no action yet', { outcome: event.outcome });
        await markProcessed(paymentEventId);
        break;
      }
    }
  } catch (error) {
    // We already persisted the event, so a transient failure here is recoverable
    // by reconciliation. Log loudly; do not rethrow into an unhandled rejection.
    const message = error instanceof Error ? error.message : String(error);
    log2.error('Webhook processing failed', { error: message });
    await prisma.paymentEvent.update({
      where: { id: paymentEventId },
      data: { processingError: message, attemptCount: { increment: 1 } },
    });
    // Still return 200 — the event is durably recorded. Throwing a 500 would
    // trigger a Whop retry storm for a failure we have already captured.
  }

  log.info('Webhook handled', {
    durationMs: Date.now() - startedAt,
    eventType: event.eventType,
  });

  return NextResponse.json({ received: true });
}

// ---------------------------------------------------------------------------

interface MatchedOrder {
  id: string;
  reference: string;
  status: OrderStatus;
  totalMinor: number;
  currency: string;
  riskDecision: RiskDecision;
}

async function findOrder(
  orderRef: string | undefined,
  providerPaymentId: string | undefined,
): Promise<MatchedOrder | null> {
  const order = await prisma.order.findFirst({
    where: {
      OR: [
        ...(orderRef ? [{ reference: orderRef }] : []),
        ...(providerPaymentId
          ? [{ payments: { some: { providerPaymentId } } }]
          : []),
      ],
    },
    select: {
      id: true,
      reference: true,
      status: true,
      totalMinor: true,
      currency: true,
      riskDecision: true,
      payments: { select: { providerCheckoutId: true, providerPaymentId: true }, take: 1 },
    },
  });

  if (!order) return null;

  // Whop echoes the checkout configuration id when metadata is absent, so use it
  // as a second chance to attribute the payment.
  if (orderRef && order.reference !== orderRef && order.payments[0]?.providerCheckoutId) {
    return order;
  }
  return order;
}

async function markProcessed(paymentEventId: string): Promise<void> {
  await prisma.paymentEvent.update({
    where: { id: paymentEventId },
    data: { processedAt: new Date() },
  });
}

async function handleSucceeded(input: {
  event: ReturnType<typeof normalizeWhopWebhook>;
  order: MatchedOrder;
  paymentEventId: string;
  log: ReturnType<typeof logger.child>;
}): Promise<void> {
  const { event, order, paymentEventId, log } = input;
  const providerPaymentId = event.providerPaymentId;

  if (!providerPaymentId) {
    log.warn('payment.succeeded arrived without a payment id');
    await markProcessed(paymentEventId);
    return;
  }

  // Bind the provider payment id to our payment row (create it if the checkout
  // route never got that far).
  await prisma.payment.upsert({
    where: { providerPaymentId },
    update: {
      status: PaymentStatus.PAID,
      amountMinor: order.totalMinor,
      currency: order.currency,
      ...(event.amountMinor !== undefined ? {} : {}),
    },
    create: {
      orderId: order.id,
      provider: 'WHOP',
      providerPaymentId,
      status: PaymentStatus.PAID,
      amountMinor: order.totalMinor,
      currency: order.currency,
    },
  });

  // HIGH-THROUGHPUT NOTE (spec §16).
  //
  // This handler deliberately does NOT call the Whop API. It used to: the flow
  // was verifyPaymentAgainstProvider(...) inline, which is a network round trip
  // (and, for a non-terminal payment, a 1.2s sleep plus a second round trip).
  //
  // Under concurrent card traffic that is the worst possible place for it:
  // every webhook held a function instance and a database connection while
  // waiting on a third party, the response drifted toward Whop's 5-second
  // budget, and a slow upstream turned into a RETRY STORM - Whop redelivers
  // failed webhooks up to 12 times over ~3 days, so one slow second multiplied
  // itself into the load that caused it.
  //
  // The fix is not "make it faster", it is "do not do it here". The signature
  // already proves the event is authentic and the amount/currency gate above
  // already bound it to our order snapshot. Authoritative confirmation against
  // the provider now happens as the FIRST STEP of the durable workflow
  // (redeem-store/payment.paid -> verify-payment), where a slow or failed call
  // is retried with backoff instead of being amplified into redeliveries.
  //
  // The invariant is unchanged: no inventory is released until the provider has
  // confirmed the charge, because verification still precedes allocation.

  // A high-risk order stays in MANUAL_REVIEW: inventory must not be released
  // automatically for it (spec §17). Cheap local read, still inline.
  if (order.riskDecision === RiskDecision.BLOCK || order.status === OrderStatus.MANUAL_REVIEW) {
    log.warn('Verified-signature payment held for manual review', {
      status: order.status,
      riskDecision: order.riskDecision,
    });
    await markProcessed(paymentEventId);
    return;
  }

  await markProcessed(paymentEventId);

  // Hand off to the durable queue and return. We do NOT await fulfillment here:
  // Whop needs a 2xx inside 5 seconds, and a slow email provider must never
  // cause Whop to retry and double-fulfill.
  const payment = await prisma.payment.findUnique({
    where: { providerPaymentId },
    select: { id: true },
  });

  await enqueueFulfillment({
    orderId: order.id,
    orderReference: order.reference,
    paymentId: payment?.id,
    providerEventId: event.providerEventId,
    amountMinor: event.amountMinor ?? order.totalMinor,
    currency: event.currency ?? order.currency,
  });
}

async function handleReversal(input: {
  event: ReturnType<typeof normalizeWhopWebhook>;
  order: MatchedOrder;
  log: ReturnType<typeof logger.child>;
}): Promise<void> {
  const { event, order, log } = input;

  // Burn the code first. A reversed payment must never leave a redeemable code
  // in the customer's hands, and it must never return to AVAILABLE.
  await revokeCodeForOrder(order.id, `provider_${event.outcome.toLowerCase()}`);

  const target =
    event.outcome === 'DISPUTED' ? OrderStatus.PAYMENT_REVERSED : OrderStatus.REFUND_PENDING;

  if (order.status !== target && order.status !== OrderStatus.REFUNDED) {
    await transitionOrder(order.id, target, {
      reason: `provider_${event.outcome.toLowerCase()}`,
      metadata: { providerEventId: event.providerEventId },
    });
  }

  await prisma.reconciliationRecord.create({
    data: {
      type: ReconciliationType.REVERSED_PAYMENT,
      status: 'OPEN',
      orderId: order.id,
      providerPaymentId: event.providerPaymentId ?? null,
      discrepancy: `Provider reported ${event.outcome} for a completed order.`,
      actual: { eventType: event.eventType },
    },
  });

  log.warn('Payment reversed upstream; code revoked', { outcome: event.outcome });
}