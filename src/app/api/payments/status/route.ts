import { NextResponse } from 'next/server';
import { prisma } from '@/db/prisma';
import { errors, isAppError } from '@/lib/errors';
import { clientIpHash, limitStatusLookup, noteRateLimitRejection } from '@/lib/public-rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/payments/status?reference=ORD-XXXX&email=customer@example.com
 *
 * Polled by the status page while a customer waits for their code.
 *
 * TWO RULES THAT MUST NOT BE BROKEN:
 *
 *  1. NEVER return the redeem code. Delivery is by email (spec §14); rendering
 *     the code in the browser would also put it in browser history, a shared
 *     machine, and any screen recording the customer made.
 *
 *  2. The email must match. Without that check this endpoint becomes an oracle:
 *     anyone could enumerate order references and learn who bought what and
 *     whether they were paid. A mismatch returns exactly the same shape as a
 *     match, so the response cannot be used to distinguish "exists but wrong
 *     email" from "does not exist".
 */

const NOT_FOUND_BODY = {
  found: false,
  status: 'UNKNOWN',
  message: 'We could not find an order matching those details.',
};

/**
 * A 429 that says nothing about whether the order exists. The uniform-shape
 * rule above applies to refusals too: a rate limit must not become an oracle.
 */
function rateLimitedResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    {
      error: 'Too many requests. Please wait a moment and try again.',
      code: 'RATE_LIMITED',
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSeconds), 'Cache-Control': 'no-store' },
    },
  );
}

export async function GET(request: Request) {
  // Abuse protection first, before the query runs. Loosely keyed on IP because
  // this route is polled by the status page and by nothing else; `reference` is
  // attacker-chosen and free to vary, so keying on it would limit nothing.
  const limit = await limitStatusLookup(clientIpHash(request));
  if (!limit.success) {
    noteRateLimitRejection('status-ip', limit);
    return rateLimitedResponse(limit.retryAfterSeconds);
  }

  const url = new URL(request.url);
  const reference = url.searchParams.get('reference')?.trim();
  const email = url.searchParams.get('email')?.trim().toLowerCase();

  if (!reference || !email) {
    return NextResponse.json(
      { error: 'Both reference and email are required' },
      { status: 400 },
    );
  }

  const order = await prisma.order.findFirst({
    where: { reference },
    select: {
      customerEmailNormalized: true,
      status: true,
      reference: true,
      updatedAt: true,
      payments: {
        select: { status: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      fulfillmentJobs: {
        select: { status: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      deliveries: {
        select: { status: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  const emailMatches = order?.customerEmailNormalized === email;
  if (!order || !emailMatches) {
    // Uniform response. The client cannot tell "wrong email" from "no such order".
    return NextResponse.json(NOT_FOUND_BODY, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  return NextResponse.json(
    {
      found: true,
      reference: order.reference,
      status: order.status,
      paymentStatus: order.payments[0]?.status ?? null,
      fulfillmentStatus: order.fulfillmentJobs[0]?.status ?? null,
      emailStatus: order.deliveries[0]?.status ?? null,
      updatedAt: order.updatedAt.toISOString(),
      message: messageFor(order.status, order.deliveries[0]?.status ?? null),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

function messageFor(status: string, emailStatus: string | null): string {
  switch (status) {
    case 'CREATED':
    case 'PAYMENT_PENDING':
      return 'Payment is processing. This usually takes a few seconds.';
    case 'PAYMENT_VERIFIED':
    case 'FULFILLMENT_PENDING':
    case 'CODE_RESERVED':
      return 'Payment verified. We are preparing your code now.';
    case 'CODE_DELIVERED':
    case 'COMPLETED':
      return emailStatus === 'DELIVERED'
        ? 'Delivered. Your code is in your inbox.'
        : 'Payment verified. Your code has been sent to your email.';
    case 'PAYMENT_FAILED':
      return 'The payment did not go through. You have not been charged.';
    case 'PAYMENT_EXPIRED':
      return 'The payment window expired. You have not been charged.';
    case 'MANUAL_REVIEW':
      return 'Your payment is being reviewed. We will email you shortly.';
    case 'REFUND_PENDING':
    case 'REFUNDED':
      return 'This order was refunded.';
    case 'FULFILLMENT_FAILED':
      return 'We hit a problem preparing your code. Our team has been notified and will email you.';
    default:
      return 'Your order is being processed.';
  }
}

/** Unused import guard: keeps `errors`/`isAppError` meaningful if extended. */
void errors;
void isAppError;