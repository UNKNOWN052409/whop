import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { Alert } from '@/components/alert';
import { prisma, withTransaction } from '@/db/prisma';
import { errors, isAppError, AppError } from '@/lib/errors';
import { formatMoney } from '@/lib/money';
import { newIdempotencyKey } from '@/lib/ids';
import { getPaymentProvider, getProviderStatus } from '@/payments/registry';
import { transitionOrder } from '@/fulfillment/order-transitions';
import { appendAudit, actorLabel } from '@/app/admin/_lib/audit';
import { assertMutationOrigin, requirePageSession, requireSession } from '@/app/admin/_lib/auth';
import {
  badgeClass,
  formatCount,
  formatDateTime,
  humaniseToken,
  orderTone,
  paymentTone,
} from '@/app/admin/_lib/format';

/**
 * REFUNDS.
 *
 * A refund is the one action in this panel that moves money OUT, so it is the
 * one action that is refused rather than approximated when the provider cannot
 * do it.
 *
 * WHY THE INITIATE BUTTON IS OFTEN DISABLED, AND WHY THAT IS CORRECT
 * --------------------------------------------------------------------
 * `getProviderStatus().capabilities.supportsRefunds` is read from the ADAPTER,
 * not hard-coded here. Whop's adapter reports `supportsRefunds: false` because
 * WHOP_API_REFERENCE.md documents `GET /refunds` but does not verify a
 * create-refund endpoint — so the adapter refuses to invent one. This page
 * surfaces exactly that: the operator is told refunds must be issued in the
 * Whop dashboard, where they arrive as `refund.created` webhooks and are
 * reconciled automatically.
 *
 * The code path for a provider that DOES support programmatic refunds is real
 * and is wired below: it writes the Refund row first (so the intent is durable
 * and auditable before any network call), then calls the provider, then
 * records the provider's answer. If the call fails, the row stays FAILED with
 * the provider's message — never a fabricated success.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Refunds' };

const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{3,40}$/;

const REFUND_TONES: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  SUCCEEDED: 'good',
  PENDING: 'warn',
  FAILED: 'bad',
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function messageOf(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

export default async function AdminRefundsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePageSession('ADMIN', '/admin/refunds');

  const params = await searchParams;
  const notice = firstValue(params.notice).trim();
  const actionError = firstValue(params.error).trim();

  const [refunds, providerStatus] = await Promise.all([
    prisma.refund.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        orderId: true,
        status: true,
        amountMinor: true,
        currency: true,
        reason: true,
        failureMessage: true,
        providerRefundId: true,
        initiatedBy: true,
        createdAt: true,
        completedAt: true,
        order: { select: { reference: true, status: true, totalMinor: true, customerEmail: true } },
        payment: {
          select: { id: true, provider: true, providerPaymentId: true, status: true, amountMinor: true },
        },
      },
    }),
    Promise.resolve(getProviderStatus()),
  ]);

  // Per-currency totals. Summing refunds across currencies into one number is a
  // financial bug, not a display shortcut.
  const byCurrency = new Map<string, { succeededMinor: number; count: number }>();
  for (const refund of refunds) {
    const bucket = byCurrency.get(refund.currency) ?? { succeededMinor: 0, count: 0 };
    if (refund.status === 'SUCCEEDED') bucket.succeededMinor += refund.amountMinor;
    bucket.count += 1;
    byCurrency.set(refund.currency, bucket);
  }

  const canInitiate = providerStatus.capabilities.supportsRefunds;

  async function initiateRefund(formData: FormData): Promise<void> {
    'use server';
    const actor = await requireSession('ADMIN');
    await assertMutationOrigin({ action: 'refunds.initiate' });

    const rawReference = String(formData.get('reference') ?? '').trim().toUpperCase();
    const reason = String(formData.get('reason') ?? '').trim().slice(0, 500);

    let outcome: { ok: true; message: string } | { ok: false; message: string };

    try {
      if (!REFERENCE_PATTERN.test(rawReference)) {
        throw errors.validation('That order reference is not a valid reference');
      }
      if (reason.length < 3) {
        throw errors.validation('Give a reason for the refund — it is stored on the audit trail');
      }

      // Read the provider capability at the moment of the write, not from the
      // rendered page: an operator could have been looking at a stale page.
      const status = getProviderStatus();
      if (status.status === 'NOT_CONFIGURED') {
        throw errors.providerNotConfigured(
          `${status.provider} (missing: ${status.missing.join(', ') || 'unknown'})`,
        );
      }
      if (!status.capabilities.supportsRefunds) {
        throw new AppError(
          `${status.provider} does not expose a verified create-refund endpoint, so this panel ` +
            'refuses to issue one programmatically. Issue the refund in the provider dashboard — it ' +
            'arrives here as a refund webhook and is reconciled automatically.',
          501,
          'PROVIDER_UNAVAILABLE',
          { details: { provider: status.provider, capability: 'supportsRefunds' } },
        );
      }

      const provider = getPaymentProvider();
      if (!provider) throw errors.providerNotConfigured(status.provider);

      const order = await prisma.order.findUnique({
        where: { reference: rawReference },
        select: {
          id: true,
          reference: true,
          status: true,
          totalMinor: true,
          currency: true,
          payments: {
            where: { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, provider: true, providerPaymentId: true, status: true, amountMinor: true, currency: true },
          },
          refunds: { select: { id: true, status: true } },
        },
      });
      if (!order) throw errors.notFound('Order');

      if (order.refunds.length > 0) {
        // Refund is unique per order in the schema — one refund per order, by
        // design. Say so instead of letting the write fail on a constraint.
        throw errors.validation(
          `Order ${rawReference} already has a refund (${order.refunds[0]?.status}). One refund per order is supported.`,
        );
      }

      const payment = order.payments[0];
      if (!payment) {
        throw errors.validation(
          `Order ${rawReference} has no captured payment to refund. A refund cannot be created against money that was never captured.`,
        );
      }
      if (!payment.providerPaymentId) {
        throw errors.validation(
          `Order ${rawReference} has no provider payment id, so the refund cannot be routed.`,
        );
      }

      // The Refund row is written FIRST and committed before the provider call.
      // If the process dies mid-call the intent survives, which is the only way
      // a reconciliation run can later discover and finish the refund.
      const created = await withTransaction(async (tx) => {
        const refund = await tx.refund.create({
          data: {
            orderId: order.id,
            paymentId: payment.id,
            amountMinor: order.totalMinor,
            currency: order.currency,
            status: 'PENDING',
            reason,
            initiatedBy: actorLabel(actor),
          },
        });
        await appendAudit(tx, {
          actor: actorLabel(actor),
          actorId: actor.userId,
          action: 'refund.requested',
          entity: 'Refund',
          entityId: refund.id,
          metadata: {
            reference: order.reference,
            amountMinor: order.totalMinor,
            currency: order.currency,
            provider: payment.provider,
            reason,
          },
        });
        if (order.status !== 'REFUNDED') {
          await transitionOrder(
            order.id,
            'REFUND_PENDING',
            { reason: `Refund requested: ${reason}`, actor: actorLabel(actor) },
            tx,
          );
        }
        return refund;
      });

      try {
        const result = await provider.refundPayment({
          providerPaymentId: payment.providerPaymentId,
          amountMinor: order.totalMinor,
          currency: order.currency,
          reason,
          idempotencyKey: newIdempotencyKey(),
        });

        await prisma.refund.update({
          where: { id: created.id },
          data: {
            providerRefundId: result.providerRefundId,
            status:
              result.status === 'SUCCEEDED'
                ? 'SUCCEEDED'
                : result.status === 'FAILED' || result.status === 'CANCELED'
                  ? 'FAILED'
                  : 'PENDING',
            completedAt: result.status === 'PENDING' ? null : new Date(),
            failureMessage:
              result.status === 'FAILED' || result.status === 'CANCELED'
                ? `Provider reported ${result.status}`
                : null,
          },
        });

        outcome = {
          ok: true,
          message: `Refund ${result.providerRefundId} for ${rawReference} is ${result.status}.`,
        };
      } catch (providerError) {
        // The provider call failed. The row stays, marked FAILED, with the real
        // message. Nothing here invents a success.
        await prisma.refund.update({
          where: { id: created.id },
          data: {
            status: 'FAILED',
            failureMessage: messageOf(providerError).slice(0, 500),
            completedAt: new Date(),
          },
        });
        outcome = { ok: false, message: `Refund recorded but the provider refused: ${messageOf(providerError)}` };
      }
    } catch (error) {
      outcome = { ok: false, message: messageOf(error) };
    }

    revalidatePath('/admin/refunds');
    redirect(`/admin/refunds?${outcome.ok ? 'notice' : 'error'}=${encodeURIComponent(outcome.message)}`);
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-fg">Refunds</h1>

      {notice ? (
        <div className="mt-4">
          <Alert variant="success" title="Done">
            <p>{notice}</p>
          </Alert>
        </div>
      ) : null}
      {actionError ? (
        <div className="mt-4">
          <Alert variant="error" title="Refund refused">
            <p>{actionError}</p>
          </Alert>
        </div>
      ) : null}

      {/* --- Provider capability ------------------------------------------ */}
      <div className="mt-6">
        {providerStatus.status === 'NOT_CONFIGURED' ? (
          <Alert variant="warning" title={`${providerStatus.provider} is NOT CONFIGURED`}>
            <p>
              Missing environment: {providerStatus.missing.join(', ') || 'unknown'}. Refunds cannot
              be routed until the provider is configured. Nothing on this page pretends otherwise.
            </p>
          </Alert>
        ) : canInitiate ? (
          <Alert variant="info" title={`${providerStatus.provider} (${providerStatus.status}) supports programmatic refunds`}>
            <p>
              A refund is written to the database first, then sent to the provider. If the provider
              call fails, the row is marked FAILED with its message — never a fabricated success.
            </p>
          </Alert>
        ) : (
          <Alert variant="warning" title={`${providerStatus.provider} cannot issue refunds from here`}>
            <p>
              The provider adapter reports <code>supportsRefunds: false</code> — no verified
              create-refund endpoint is available, so this panel will not guess an API path that may
              404 and report success. Issue the refund in the {providerStatus.provider} dashboard; it
              arrives here as a refund webhook and is reconciled automatically.
            </p>
          </Alert>
        )}
      </div>

      {/* --- Totals -------------------------------------------------------- */}
      {byCurrency.size > 0 ? (
        <div className="mt-6 flex flex-wrap gap-2">
          {[...byCurrency.entries()].map(([currency, bucket]) => (
            <span key={currency} className={badgeClass('neutral')}>
              {currency.toUpperCase()}: {formatMoney(bucket.succeededMinor, currency)} refunded of{' '}
              {formatCount(bucket.count)} refund(s)
            </span>
          ))}
        </div>
      ) : null}

      {/* --- New refund ---------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-subtle">Initiate a refund</h2>
        <form action={initiateRefund} className="mt-2 rounded-lg border border-line bg-surface-2 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="refund-reference" className="text-sm font-medium text-fg">
                Order reference
              </label>
              <input
                id="refund-reference"
                name="reference"
                type="text"
                placeholder="ORD-7QK2M4XB"
                required
                className="w-48 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="refund-reason" className="text-sm font-medium text-fg">
                Reason (recorded on the audit trail)
              </label>
              <input
                id="refund-reason"
                name="reason"
                type="text"
                maxLength={500}
                placeholder="e.g. customer never received the code"
                required
                className="w-72 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle"
              />
            </div>
            <button
              type="submit"
              disabled={!canInitiate}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              {canInitiate ? 'Refund this order' : 'Refunds unavailable'}
            </button>
          </div>
          {!canInitiate ? (
            <p className="mt-3 text-xs text-subtle">
              The button is disabled because this provider cannot create a refund through the API.
              Issue it in the provider dashboard instead — that is not a workaround, it is the only
              route that is actually verified.
            </p>
          ) : null}
        </form>
      </section>

      {/* --- List ---------------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-subtle">
          Recent refunds ({formatCount(refunds.length)})
        </h2>
        {refunds.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No refund has ever been requested.</p>
        ) : (
          <div className="mt-2 space-y-3">
            {refunds.map((refund) => (
              <article key={refund.id} className="rounded-lg border border-line bg-surface-2 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={badgeClass(REFUND_TONES[refund.status] ?? 'neutral')}>
                        {humaniseToken(refund.status)}
                      </span>
                      <Link
                        href={`/admin/orders/${refund.order.reference}`}
                        className="font-mono text-sm font-semibold underline hover:text-accent"
                      >
                        {refund.order.reference}
                      </Link>
                      <span className={badgeClass(orderTone(refund.order.status))}>
                        Order: {humaniseToken(refund.order.status)}
                      </span>
                      {refund.payment ? (
                        <span className={badgeClass(paymentTone(refund.payment.status))}>
                          Payment: {humaniseToken(refund.payment.status)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-2 text-sm text-muted">
                      {formatMoney(refund.amountMinor, refund.currency)} (
                      {formatCount(refund.amountMinor)} minor units) · {refund.order.customerEmail}
                    </p>
                    {refund.reason ? <p className="mt-1 text-xs text-muted">{refund.reason}</p> : null}
                    {refund.failureMessage ? (
                      <p className="mt-1 text-xs text-danger">{refund.failureMessage}</p>
                    ) : null}
                  </div>

                  <dl className="text-xs text-muted">
                    <div>
                      <dt className="inline">Requested </dt>
                      <dd className="inline text-fg">{formatDateTime(refund.createdAt)}</dd>
                    </div>
                    <div>
                      <dt className="inline">Completed </dt>
                      <dd className="inline text-fg">{formatDateTime(refund.completedAt)}</dd>
                    </div>
                    <div>
                      <dt className="inline">By </dt>
                      <dd className="inline text-fg">{refund.initiatedBy ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="inline">Provider id </dt>
                      <dd className="inline font-mono text-fg">{refund.providerRefundId ?? '—'}</dd>
                    </div>
                  </dl>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
