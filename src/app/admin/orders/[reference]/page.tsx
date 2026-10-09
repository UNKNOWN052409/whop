import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { Alert } from '@/components/alert';
import { prisma, withTransaction } from '@/db/prisma';
import { enqueueFulfillmentRetry } from '@/fulfillment/enqueue';
import { transitionOrder } from '@/fulfillment/order-transitions';
import { AppError, errors, isAppError } from '@/lib/errors';
import { formatMoney } from '@/lib/money';
import { canTransition } from '@/orders/state-machine';
import { appendAudit, actorLabel, tryWriteAuditLog } from '@/app/admin/_lib/audit';
import { assertMutationOrigin, requirePageSession, requireSession } from '@/app/admin/_lib/auth';
import {
  badgeClass,
  displayPriceValue,
  emailTone,
  formatCount,
  formatDateTime,
  fulfillmentTone,
  humaniseToken,
  inventoryTone,
  maskedCode,
  orderTone,
  paymentTone,
  shortJson,
} from '@/app/admin/_lib/format';
import { loadOrderAudit, loadOrderDetail } from '@/app/admin/_lib/queries';

/**
 * ORDER DETAIL.
 *
 * The single page an operator opens when a customer says "I paid and got
 * nothing". It answers, in order: what was ordered and for how much, did the
 * money actually arrive, did a code leave inventory, did the email go out, is a
 * refund pending, and who touched this order.
 *
 * TWO THINGS THIS PAGE WILL NOT DO
 *
 *  1. IT NEVER RENDERS A FULL REDEEM CODE. `loadOrderDetail()` selects
 *     `codeLast4` and nothing else from InventoryCode — the ciphertext is not
 *     fetched, so it cannot be leaked by a bug in this file. Every code shown
 *     here goes through `maskedCode()`.
 *
 *  2. IT NEVER DISPLAYS A FULL CARD NUMBER. Only brand and last four, which
 *     is all the schema stores.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Order' };

const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{3,40}$/;

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function messageOf(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-subtle">{title}</h2>
      <div className="mt-2 rounded-lg border border-line bg-surface-2 p-4">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-1.5 last:border-0">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-sm text-fg">{value}</span>
    </div>
  );
}

export default async function AdminOrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePageSession('SUPPORT', '/admin/orders');

  const { reference: rawReference } = await params;
  const reference = rawReference.trim().toUpperCase();
  if (!REFERENCE_PATTERN.test(reference)) notFound();

  const query = await searchParams;
  const notice = firstValue(query.notice).trim();
  const actionError = firstValue(query.error).trim();

  const order = await loadOrderDetail(reference);
  if (!order) notFound();

  const auditRows = await loadOrderAudit(reference);
  const backHref = '/admin/orders';

  // -------------------------------------------------------------------------
  // Server Actions — identical contract to the ones on the list page:
  // re-authorise, verify origin, validate, write + audit in one transaction.
  // -------------------------------------------------------------------------

  async function moveToManualReview(formData: FormData): Promise<void> {
    'use server';
    const actor = await requireSession('ADMIN');
    await assertMutationOrigin({ action: 'order.detail.moveToManualReview' });

    const submitted = String(formData.get('reference') ?? '').trim().toUpperCase();
    let outcome: { ok: true; message: string } | { ok: false; message: string };

    try {
      if (!REFERENCE_PATTERN.test(submitted)) {
        throw errors.validation('That order reference is not a valid reference');
      }
      // The hidden field is attacker-controllable: re-resolve from it and make
      // sure we are acting on the order actually rendered on this page.
      if (submitted !== reference) {
        throw errors.forbidden('That order reference does not match this page');
      }
      const current = await prisma.order.findUnique({
        where: { reference },
        select: { id: true, reference: true, status: true },
      });
      if (!current) throw errors.notFound('Order');

      const note =
        String(formData.get('reason') ?? '').trim().slice(0, 500) ||
        'Held for manual review by an operator';

      await withTransaction(async (tx) => {
        await transitionOrder(
          current.id,
          'MANUAL_REVIEW',
          { reason: note, actor: actorLabel(actor), data: { manualReviewReason: note } },
          tx,
        );
        await appendAudit(tx, {
          actor: actorLabel(actor),
          actorId: actor.userId,
          action: 'order.manual_review.requested',
          entity: 'Order',
          entityId: current.id,
          metadata: { reference: current.reference, from: current.status, to: 'MANUAL_REVIEW', note },
        });
      });

      outcome = {
        ok: true,
        message: `${reference} moved to MANUAL_REVIEW. Inventory release is blocked until an operator resolves it.`,
      };
    } catch (error) {
      outcome = { ok: false, message: messageOf(error) };
    }

    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${reference}`);
    redirect(
      `/admin/orders/${reference}?${outcome.ok ? 'notice' : 'error'}=${encodeURIComponent(outcome.message)}`,
    );
  }

  async function retryFulfillment(formData: FormData): Promise<void> {
    'use server';
    const actor = await requireSession('ADMIN');
    await assertMutationOrigin({ action: 'order.detail.retryFulfillment' });

    const submitted = String(formData.get('reference') ?? '').trim().toUpperCase();
    let outcome: { ok: true; message: string } | { ok: false; message: string };

    try {
      if (!REFERENCE_PATTERN.test(submitted)) {
        throw errors.validation('That order reference is not a valid reference');
      }
      if (submitted !== reference) {
        throw errors.forbidden('That order reference does not match this page');
      }
      const current = await prisma.order.findUnique({
        where: { reference },
        select: {
          id: true,
          reference: true,
          status: true,
          fulfillmentJobs: { select: { attempts: true, maxAttempts: true, status: true }, take: 1 },
        },
      });
      if (!current) throw errors.notFound('Order');

      if (!canTransition(current.status, 'FULFILLMENT_PENDING')) {
        throw errors.validation(
          `${reference} is ${current.status}; a fulfillment retry cannot run from this state.`,
        );
      }

      const job = current.fulfillmentJobs[0];
      if (job && job.attempts >= job.maxAttempts) {
        throw new AppError(
          `${reference} has spent its entire fulfillment budget (${job.attempts}/${job.maxAttempts} attempts, job ${job.status}). ` +
            'The durable worker would skip this retry. Resolve the underlying cause first.',
          409,
          'INVALID_STATE_TRANSITION',
        );
      }

      await enqueueFulfillmentRetry({
        orderId: current.id,
        orderReference: current.reference,
        attempt: (job?.attempts ?? 0) + 1,
        reason: `admin retry requested by ${actor.email}`,
      });

      await tryWriteAuditLog({
        actor: actorLabel(actor),
        actorId: actor.userId,
        action: 'order.fulfillment.retry.requested',
        entity: 'Order',
        entityId: current.id,
        metadata: {
          reference: current.reference,
          status: current.status,
          attempt: (job?.attempts ?? 0) + 1,
          maxAttempts: job?.maxAttempts ?? null,
        },
      });

      outcome = {
        ok: true,
        message: `Fulfillment retry queued for ${reference}. The durable worker runs it; reload this page to see the job status change.`,
      };
    } catch (error) {
      outcome = { ok: false, message: messageOf(error) };
    }

    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${reference}`);
    redirect(
      `/admin/orders/${reference}?${outcome.ok ? 'notice' : 'error'}=${encodeURIComponent(outcome.message)}`,
    );
  }

  const canReview = canTransition(order.status, 'MANUAL_REVIEW');
  const canRetry = canTransition(order.status, 'FULFILLMENT_PENDING');
  const latestPayment = order.payments[order.payments.length - 1] ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={backHref} className="text-xs text-muted underline hover:text-fg">
            ← All orders
          </Link>
          <h1 className="mt-1 font-mono text-2xl font-semibold text-fg">{order.reference}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className={badgeClass(orderTone(order.status))}>
              Order: {humaniseToken(order.status)}
            </span>
            {latestPayment ? (
              <span className={badgeClass(paymentTone(latestPayment.status))}>
                Payment: {humaniseToken(latestPayment.status)}
              </span>
            ) : null}
            <span className="text-xs text-subtle">created {formatDateTime(order.createdAt)}</span>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          {canReview ? (
            <form action={moveToManualReview} className="flex items-end gap-2">
              <input type="hidden" name="reference" value={order.reference} />
              <input
                name="reason"
                type="text"
                maxLength={500}
                placeholder="Reason (optional)"
                aria-label="Reason for manual review"
                className="w-56 rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-fg placeholder:text-subtle"
              />
              <button
                type="submit"
                className="rounded-md border border-warning px-3 py-1.5 text-xs font-medium text-warning hover:bg-warning/10"
              >
                Send to manual review
              </button>
            </form>
          ) : null}
          {canRetry ? (
            <form action={retryFulfillment}>
              <input type="hidden" name="reference" value={order.reference} />
              <button
                type="submit"
                className="rounded-md border border-line px-3 py-1.5 text-xs text-muted hover:bg-surface-3 hover:text-fg"
              >
                Retry fulfillment
              </button>
            </form>
          ) : null}
          {!canReview && !canRetry ? (
            <p className="text-xs text-subtle">
              {order.status} is a state no operator action applies to.
            </p>
          ) : null}
        </div>
      </div>

      {notice ? (
        <div className="mt-4">
          <Alert variant="success" title="Done">
            <p>{notice}</p>
          </Alert>
        </div>
      ) : null}
      {actionError ? (
        <div className="mt-4">
          <Alert variant="error" title="Action refused">
            <p>{actionError}</p>
          </Alert>
        </div>
      ) : null}

      {order.status === 'MANUAL_REVIEW' && order.manualReviewReason ? (
        <div className="mt-4">
          <Alert variant="warning" title="Held for manual review">
            <p>{order.manualReviewReason}</p>
          </Alert>
        </div>
      ) : null}

      {/* --- Snapshot ------------------------------------------------------ */}
      <Card title="Order snapshot">
        <div className="grid gap-x-8 md:grid-cols-2">
          <div>
            <Row label="Product" value={`${order.productName} × ${order.quantity}`} />
            <Row
              label="Terms"
              value={displayPriceValue(order.sellingPriceMinor, order.faceValueMinor, order.currency)}
            />
            <Row
              label="Order total"
              value={`${formatMoney(order.totalMinor, order.currency)} (${formatCount(order.totalMinor)} minor units)`}
            />
            <Row label="Unit price" value={formatMoney(order.unitPriceMinor, order.currency)} />
            <Row
              label="Supplier cost (live)"
              value={formatMoney(order.product.supplierCostMinor, order.currency)}
            />
          </div>
          <div>
            <Row label="Customer" value={order.customerEmail} />
            <Row label="Region" value={order.region} />
            <Row label="Delivery" value={humaniseToken(order.deliveryMethod)} />
            <Row
              label="Risk"
              value={`${humaniseToken(order.riskLevel)} · ${humaniseToken(order.riskDecision)}${
                order.riskScore === null ? '' : ` · score ${order.riskScore}`
              }`}
            />
            <Row label="Paid at" value={formatDateTime(order.paidAt)} />
            <Row label="Completed at" value={formatDateTime(order.completedAt)} />
          </div>
        </div>
        <p className="mt-3 text-xs text-subtle">
          Prices are snapshotted at order creation and never change. Supplier cost is read live from
          the product, so a price rise today does not rewrite what this order earned.
        </p>
      </Card>

      {/* --- Payments ------------------------------------------------------ */}
      <Card title={`Payments (${formatCount(order.payments.length)})`}>
        {order.payments.length === 0 ? (
          <p className="text-sm text-muted">No payment rows. Nothing has been attempted.</p>
        ) : (
          <div className="space-y-4">
            {order.payments.map((payment) => (
              <div key={payment.id} className="rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={badgeClass(paymentTone(payment.status))}>
                    {humaniseToken(payment.status)}
                  </span>
                  <span className="text-xs text-subtle">{payment.provider}</span>
                  {payment.providerPaymentId ? (
                    <span className="font-mono text-xs text-muted">
                      {payment.providerPaymentId}
                    </span>
                  ) : null}
                  {payment.verifiedAt ? (
                    <span className="text-xs text-success">
                      verified {formatDateTime(payment.verifiedAt)}
                    </span>
                  ) : (
                    <span className="text-xs text-subtle">not verified</span>
                  )}
                </div>
                <div className="mt-2 grid gap-x-8 md:grid-cols-2">
                  <Row
                    label="Charged"
                    value={`${formatMoney(payment.amountMinor, payment.currency)} (${formatCount(payment.amountMinor)} minor units)`}
                  />
                  <Row
                    label="Net after fees"
                    value={
                      payment.netAmountMinor === null ? (
                        <span className="text-warning">not reported by the provider</span>
                      ) : (
                        formatMoney(payment.netAmountMinor, payment.currency)
                      )
                    }
                  />
                  <Row
                    label="Fee"
                    value={
                      payment.feeMinor === null
                        ? '—'
                        : formatMoney(payment.feeMinor, payment.currency)
                    }
                  />
                  <Row
                    label="Card"
                    value={
                      payment.cardLast4
                        ? `${payment.cardBrand ?? 'card'} ····${payment.cardLast4}`
                        : '—'
                    }
                  />
                </div>
                {payment.failureCode || payment.failureMessage || payment.declineCode ? (
                  <p className="mt-2 text-xs text-danger">
                    {payment.declineCode ? `decline ${payment.declineCode}` : ''}
                    {payment.failureCode ? ` · ${payment.failureCode}` : ''}
                    {payment.failureMessage ? ` · ${payment.failureMessage}` : ''}
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-subtle">
                  Created {formatDateTime(payment.createdAt)}
                  {payment.providerCheckoutId ? ` · checkout ${payment.providerCheckoutId}` : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* --- Fulfillment --------------------------------------------------- */}
      <Card title={`Fulfillment (${formatCount(order.fulfillmentJobs.length)})`}>
        {order.fulfillmentJobs.length === 0 ? (
          <p className="text-sm text-muted">No fulfillment job — nothing has been queued yet.</p>
        ) : (
          order.fulfillmentJobs.map((job) => (
            <div key={job.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={badgeClass(fulfillmentTone(job.status))}>
                  {humaniseToken(job.status)}
                </span>
                <span className="text-xs text-muted">
                  attempt {formatCount(job.attempts)} of {formatCount(job.maxAttempts)}
                </span>
              </div>
              <div className="mt-2 grid gap-x-8 md:grid-cols-2">
                <Row label="Next attempt" value={formatDateTime(job.nextAttemptAt)} />
                <Row
                  label="Inventory allocated"
                  value={job.inventoryAllocatedAt ? formatDateTime(job.inventoryAllocatedAt) : 'no'}
                />
                <Row label="Started" value={formatDateTime(job.startedAt)} />
                <Row label="Completed" value={formatDateTime(job.completedAt)} />
              </div>
              {job.lastError ? (
                <p className="mt-2 break-words text-xs text-danger">{job.lastError}</p>
              ) : null}
            </div>
          ))
        )}
      </Card>

      {/* --- Codes (masked, always) ---------------------------------------- */}
      <Card title={`Codes (${formatCount(order.inventoryCodes.length)})`}>
        <Alert variant="info">
          <p>
            Codes are shown as their last four characters only. The full code exists once, encrypted,
            in the delivery email the customer received — it is never rendered in this panel and is
            never selectable by any query behind it.
          </p>
        </Alert>
        {order.inventoryCodes.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No code has been allocated to this order.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-subtle">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">Code</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Face value</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Reserved</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Lease expires</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Delivered</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {order.inventoryCodes.map((code) => (
                  <tr key={code.id}>
                    <td className="py-2 pr-4 font-mono">{maskedCode(code.codeLast4)}</td>
                    <td className="py-2 pr-4">
                      <span className={badgeClass(inventoryTone(code.status))}>
                        {humaniseToken(code.status)}
                      </span>
                    </td>
                    <td className="py-2 pr-4 tabular-nums">
                      {formatMoney(code.faceValueMinor, code.currency)}
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted">
                      {formatDateTime(code.reservedAt)}
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted">
                      {formatDateTime(code.reservationExpiresAt)}
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted">
                      {formatDateTime(code.deliveredAt)}
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted">
                      {formatDateTime(code.expiresAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* --- Delivery ------------------------------------------------------ */}
      <Card title={`Delivery (${formatCount(order.deliveries.length)})`}>
        {order.deliveries.length === 0 ? (
          <p className="text-sm text-muted">No email has been queued for this order.</p>
        ) : (
          order.deliveries.map((delivery) => (
            <div key={delivery.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={badgeClass(emailTone(delivery.status))}>
                  {humaniseToken(delivery.status)}
                </span>
                <span className="text-xs text-subtle">
                  {delivery.provider} · {delivery.attempts} attempt(s)
                </span>
              </div>
              <div className="mt-2 grid gap-x-8 md:grid-cols-2">
                <Row label="To" value={delivery.email} />
                <Row label="Message id" value={delivery.providerMessageId ?? '—'} />
                <Row label="Sent" value={formatDateTime(delivery.sentAt)} />
                <Row label="Delivered" value={formatDateTime(delivery.deliveredAt)} />
              </div>
              {delivery.lastError ? (
                <p className="mt-2 break-words text-xs text-danger">{delivery.lastError}</p>
              ) : null}
            </div>
          ))
        )}
      </Card>

      {/* --- Refunds ------------------------------------------------------- */}
      <Card title={`Refunds (${formatCount(order.refunds.length)})`}>
        {order.refunds.length === 0 ? (
          <p className="text-sm text-muted">No refund has been requested.</p>
        ) : (
          order.refunds.map((refund) => (
            <div key={refund.id} className="grid gap-x-8 md:grid-cols-2">
              <Row
                label={`Status (${refund.status})`}
                value={formatMoney(refund.amountMinor, refund.currency)}
              />
              <Row label="Initiated by" value={refund.initiatedBy ?? '—'} />
              <Row label="Provider refund id" value={refund.providerRefundId ?? '—'} />
              <Row label="Reason" value={refund.reason ?? '—'} />
              <Row label="Created" value={formatDateTime(refund.createdAt)} />
              <Row label="Completed" value={formatDateTime(refund.completedAt)} />
              {refund.failureMessage ? (
                <p className="mt-2 break-words text-xs text-danger md:col-span-2">
                  {refund.failureMessage}
                </p>
              ) : null}
            </div>
          ))
        )}
        <p className="mt-3 text-xs text-subtle">
          <Link href="/admin/refunds" className="underline">
            Open the refunds console
          </Link>
        </p>
      </Card>

      {/* --- Timeline ------------------------------------------------------ */}
      <Card title="State timeline">
        {order.transitions.length === 0 ? (
          <p className="text-sm text-muted">No transitions recorded.</p>
        ) : (
          <ol className="space-y-3">
            {order.transitions.map((transition) => (
              <li key={transition.id} className="border-l-2 border-line pl-3">
                <p className="text-sm text-fg">
                  {transition.fromState ? (
                    <>
                      <span className="text-muted">{humaniseToken(transition.fromState)}</span> →{' '}
                    </>
                  ) : null}
                  <span className="font-medium">{humaniseToken(transition.toState)}</span>
                </p>
                <p className="text-xs text-subtle">
                  {formatDateTime(transition.createdAt)} · actor {transition.actor}
                  {transition.reason ? ` · ${transition.reason}` : ''}
                </p>
                {transition.metadata ? (
                  <p className="mt-1 break-words font-mono text-xs text-muted">
                    {shortJson(transition.metadata)}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Card>

      {/* --- Reconciliation ------------------------------------------------ */}
      <Card title={`Reconciliation (${formatCount(order.reconciliationRecords.length)})`}>
        {order.reconciliationRecords.length === 0 ? (
          <p className="text-sm text-muted">
            No discrepancies. Reconciliation has not flagged this order.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-subtle">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">Type</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Discrepancy</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Detected</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Resolved</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {order.reconciliationRecords.map((record) => (
                  <tr key={record.id}>
                    <td className="py-2 pr-4">{humaniseToken(record.type)}</td>
                    <td className="py-2 pr-4">{humaniseToken(record.status)}</td>
                    <td className="py-2 pr-4 text-xs text-muted">{record.discrepancy ?? '—'}</td>
                    <td className="py-2 pr-4 text-xs text-muted">
                      {formatDateTime(record.createdAt)}
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted">
                      {formatDateTime(record.resolvedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* --- Audit --------------------------------------------------------- */}
      <Card title={`Audit trail (${formatCount(auditRows.length)})`}>
        {auditRows.length === 0 ? (
          <p className="text-sm text-muted">No audited mutations recorded against this order.</p>
        ) : (
          <ul className="space-y-2">
            {auditRows.map((row) => (
              <li key={row.id} className="border-b border-line pb-2 last:border-0">
                <p className="text-sm text-fg">
                  <span className="font-mono">{row.action}</span>
                  <span className="ml-2 text-xs text-muted">{row.actor}</span>
                </p>
                <p className="text-xs text-subtle">
                  {formatDateTime(row.createdAt)}
                  {row.metadata ? ` · ${shortJson(row.metadata, 240)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
