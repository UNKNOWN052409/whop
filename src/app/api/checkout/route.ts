/**
 * POST /api/checkout — start a purchase.
 *
 * THE ORDER OF OPERATIONS IS THE WHOLE POINT OF THIS FILE:
 *
 *   1. validate                     — reject garbage before any write
 *   2. idempotency claim             — one order per (key, body)
 *   3. snapshot the price           — a later catalog edit must never change
 *                                    what an existing order was charged
 *   4. CREATED -> PAYMENT_PENDING    — through assertTransition, not a raw update
 *   5. fraud evaluation              — REVIEW/BLOCK parks the order in
 *                                    MANUAL_REVIEW and NO checkout is created
 *   6. create the provider checkout  — last, because it is the only step we
 *                                    cannot roll back
 *
 * WHY THE SNAPSHOT: `Order` carries its own `productName`, `faceValueMinor`,
 * `sellingPriceMinor`, `unitPriceMinor`, `totalMinor`, `currency` and `region`.
 * If the webhook compared a live catalog price to a live payment, an admin
 * repricing a SKU mid-flight would retroactively change what a customer "was
 * charged", and a payment could silently start matching or mismatching. The
 * order row IS the contract.
 *
 * THE MONEY RULE: the customer pays the SELLING price ($3) and receives a code
 * worth the FACE value ($1). `totalMinor` is built from `sellingPriceMinor`
 * ONLY. Never from `faceValueMinor`.
 *
 * What this route deliberately does NOT do: it never trusts a client-supplied
 * amount, a client-supplied currency, or a client-supplied success URL. The
 * amounts come from the catalog; the URLs come from server config.
 */

import { NextResponse } from 'next/server';
import { OrderStatus, RiskDecision } from '@prisma/client';
import { z } from 'zod';

import { getProductById } from '@/catalog/queries';
import { prisma, withTransaction } from '@/db/prisma';
import { appConfig, checkoutSchema } from '@/lib/env';
import { AppError, errors, isAppError } from '@/lib/errors';
import { generateOrderReference, normalizeEmail, piiHash, requestHash } from '@/lib/ids';
import { logger } from '@/lib/logger';
import {
  clientIpHash,
  limitCheckoutEmail,
  limitCheckoutIp,
  noteRateLimitRejection,
} from '@/lib/public-rate-limit';
import { evaluateOrderRisk } from '@/fraud/evaluate';
import { assertTransition } from '@/orders/state-machine';
import { withIdempotency } from '@/payments/idempotency';
import { getPaymentProvider } from '@/payments/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;
const IDEMPOTENCY_SCOPE = 'checkout';

/** checkoutSchema PLUS the explicit "the customer clicked Pay" acknowledgement. */
const requestSchema = checkoutSchema.extend({
  /**
   * Required, and required to be `true`. Without it a single GET-with-body,
   * a prefetch, or a stray bot POST could create a payment intent for a
   * stranger. The browser cannot set this on a navigation; only a deliberate
   * user action produces it.
   */
  confirmed: z.literal(true),
});

type CheckoutRequestBody = z.infer<typeof requestSchema>;

interface CheckoutResponseBody {
  orderReference: string;
  checkoutUrl: string;
}

function jsonError(error: AppError): NextResponse {
  return NextResponse.json(
    { error: error.message, code: error.code },
    {
      status: error.statusCode,
      ...(error.retryAfterSeconds ? { headers: { 'retry-after': String(error.retryAfterSeconds) } } : {}),
    },
  );
}

function deriveIdempotencyKey(request: Request, body: unknown): string {
  const header = request.headers.get('idempotency-key')?.trim();
  if (header && header.length > 0 && header.length <= 255) return header;
  // No client key: derive one from the request itself so an accidental double
  // submit is a REPLAY rather than a second charge. Two genuinely different
  // requests produce different keys and both go through.
  return `derived:${requestHash(body)}`;
}

export async function POST(request: Request): Promise<NextResponse> {
  // --- 0. abuse protection, BEFORE we read or write anything ---------------
  // Deliberately the first statement in the handler. A refused request must
  // cost one header lookup, one keyed hash and one Redis round trip — not a
  // body read, not a JSON parse, not an order row. The per-IP half of the
  // combined checkout rule runs here because the email does not exist until the
  // body is parsed; the per-email half runs below, before the first DB write.
  // Neither half alone is sufficient: per-IP is bypassed by rotating addresses,
  // per-email by many buyers behind one NAT.
  const clientHash = clientIpHash(request);
  const ipLimit = await limitCheckoutIp(clientHash);
  if (!ipLimit.success) {
    noteRateLimitRejection('checkout-ip', ipLimit);
    return jsonError(errors.rateLimited(ipLimit.retryAfterSeconds));
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonError(errors.validation('Could not read the request body'));
  }
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return jsonError(errors.validation('Request body is too large'));
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody.length === 0 ? '{}' : rawBody);
  } catch {
    return jsonError(errors.validation('Request body must be valid JSON'));
  }

  const parsed = requestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return jsonError(
      errors.validation('Invalid checkout request', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')).slice(0, 10),
      }),
    );
  }
  const body: CheckoutRequestBody = parsed.data;

  // --- 0b. per-email half of the combined checkout rule -------------------
  // Still ahead of every write: the first row created below is the order.
  const emailLimit = await limitCheckoutEmail(body.email);
  if (!emailLimit.success) {
    noteRateLimitRejection('checkout-email', emailLimit);
    return jsonError(errors.rateLimited(emailLimit.retryAfterSeconds));
  }

  try {
    const idempotencyKey = deriveIdempotencyKey(request, body);

    const result = await withIdempotency<CheckoutResponseBody>({
      scope: IDEMPOTENCY_SCOPE,
      key: idempotencyKey,
      requestBody: body,
      handler: () => startCheckout(request, body),
    });

    return NextResponse.json(result.body, {
      status: result.statusCode,
      headers: {
        'cache-control': 'no-store',
        ...(result.replayed ? { 'idempotent-replay': 'true' } : {}),
      },
    });
  } catch (error) {
    if (isAppError(error)) return jsonError(error);
    logger.error('Checkout failed unexpectedly', {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(
      new AppError('Could not start the checkout. Please try again.', 500, 'INTERNAL_ERROR'),
    );
  }
}

async function startCheckout(
  request: Request,
  body: CheckoutRequestBody,
): Promise<{
  statusCode: number;
  body: CheckoutResponseBody;
}> {
  // --- Provider availability is checked BEFORE any write -----------------
  // Creating an order for a payment provider that does not exist would leave
  // orphan orders in the storefront. NOT CONFIGURED is surfaced as a 503.
  const provider = getPaymentProvider();
  if (!provider) throw errors.providerNotConfigured('Payment provider');

  const product = await getProductById(body.productId);
  if (!product) throw errors.notFound('Product');
  if (product.inventoryCount < body.quantity) throw errors.insufficientInventory(product.id);

  const email = body.email.trim();
  const emailNormalized = normalizeEmail(email);
  const currency = product.currency.toUpperCase();

  // Selling price x quantity. Integer minor units end to end.
  const unitPriceMinor = product.sellingPriceMinor;
  const totalMinor = unitPriceMinor * body.quantity;
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) {
    throw errors.validation('Computed order total is out of range');
  }

  const reference = await generateUniqueReference();

  // --- 3 + 4: create the order WITH its price snapshot, in one tx --------
  const order = await withTransaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        reference,
        status: OrderStatus.CREATED,
        productId: product.id,
        quantity: body.quantity,
        productName: product.productName,
        faceValueMinor: product.faceValueMinor,
        sellingPriceMinor: product.sellingPriceMinor,
        unitPriceMinor,
        currency,
        region: product.region,
        customerEmail: email,
        customerEmailNormalized: emailNormalized,
        totalMinor,
        deliveryMethod: product.deliveryMethod,
      },
      select: {
        id: true,
        reference: true,
        status: true,
        totalMinor: true,
        currency: true,
        customerEmailNormalized: true,
        // Read back from the row (not from the request) so the fraud engine
        // scores exactly what was persisted.
        productId: true,
        productName: true,
        quantity: true,
        region: true,
        faceValueMinor: true,
        sellingPriceMinor: true,
        unitPriceMinor: true,
      },
    });

    // The table, not a raw update. An illegal edge here is a bug, and this is
    // the only place the order starts its life.
    assertTransition(OrderStatus.CREATED, OrderStatus.PAYMENT_PENDING, {
      orderId: created.id,
      reason: 'checkout_started',
    });

    await tx.order.update({
      where: { id: created.id },
      data: { status: OrderStatus.PAYMENT_PENDING },
    });
    await tx.orderStateTransition.create({
      data: {
        orderId: created.id,
        fromState: OrderStatus.CREATED,
        toState: OrderStatus.PAYMENT_PENDING,
        reason: 'checkout_started',
        actor: 'checkout-api',
        metadata: { productId: product.id, quantity: body.quantity },
      },
    });

    return created;
  });

  // --- 5: fraud gate ------------------------------------------------------
  // Runs on a freshly created order, before any charge exists. REVIEW or BLOCK
  // parks the order in MANUAL_REVIEW and we return WITHOUT creating a checkout:
  // an operator releases it, we do not take the money and hope.
  let ipHash: string | undefined;
  try {
    const forwarded = request_ip(request);
    if (forwarded) ipHash = piiHash(forwarded);
  } catch {
    ipHash = undefined;
  }

  const risk = await evaluateOrderRisk({
    order: {
      id: order.id,
      reference: order.reference,
      status: order.status,
      productId: order.productId,
      productName: order.productName,
      quantity: order.quantity,
      region: order.region,
      currency: order.currency,
      faceValueMinor: order.faceValueMinor,
      sellingPriceMinor: order.sellingPriceMinor,
      unitPriceMinor: order.unitPriceMinor,
      totalMinor: order.totalMinor,
      customerEmailNormalized: emailNormalized,
      userId: null,
    },
    email,
    ...(ipHash ? { ipHash } : {}),
  });

  if (risk.decision !== RiskDecision.ALLOW || risk.heldForReview) {
    logger.warn('Checkout halted by the fraud engine; no provider checkout created', {
      orderId: order.id,
      orderReference: order.reference,
      score: risk.score,
      riskLevel: risk.riskLevel,
      decision: risk.decision,
      firedRules: risk.firedRules,
    });
    throw new AppError(
      'This order has been held for manual review. Our team will follow up by email.',
      409,
      'FORBIDDEN',
      { details: { orderReference: order.reference, decision: risk.decision } },
    );
  }

  // --- 6: provider checkout (the only irreversible step, so it is last) ----
  const created = await provider.createPayment({
    orderId: order.id,
    orderReference: order.reference,
    amountMinor: totalMinor,
    currency,
    customer: {
      email,
      ...(ipHash ? { ipHash } : {}),
      ...(request.headers.get('user-agent')
        ? { userAgent: request.headers.get('user-agent') as string }
        : {}),
    },
    productName: product.productName,
    quantity: body.quantity,
    successUrl: `${appConfig.url}/checkout/success?ref=${encodeURIComponent(order.reference)}`,
    cancelUrl: `${appConfig.url}/?cancelled=1`,
    metadata: {
      order_ref: order.reference,
      order_id: order.id,
    },
    // Provider-side idempotency: a retried HTTP call cannot create a second
    // checkout configuration on Whop.
    idempotencyKey: `checkout:${order.id}`,
  });

  await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: provider.kind,
      providerCheckoutId: created.providerCheckoutId,
      status: 'CREATED',
      amountMinor: totalMinor,
      currency,
    },
  });

  logger.info('Checkout created', {
    orderId: order.id,
    productId: product.id,
    totalMinor,
    currency,
    provider: provider.name,
  });

  return {
    statusCode: 201,
    body: { orderReference: order.reference, checkoutUrl: created.checkoutUrl },
  };
}

/**
 * Client IP from the usual proxy headers. Hashing happens at the call site;
 * a raw address is never stored or logged.
 */
function request_ip(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  const candidate = forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip')?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
}

/** `reference` is unique; a collision is vanishingly rare but must not 500. */
async function generateUniqueReference(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reference = generateOrderReference();
    const clash = await prisma.order.findUnique({
      where: { reference },
      select: { id: true },
    });
    if (!clash) return reference;
  }
  throw new AppError('Could not allocate an order reference', 500, 'INTERNAL_ERROR');
}