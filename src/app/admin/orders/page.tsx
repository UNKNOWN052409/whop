import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { Alert } from '@/components/alert';
import { prisma, withTransaction } from '@/db/prisma';
import { enqueueFulfillmentRetry } from '@/fulfillment/enqueue';
import { transitionOrder } from '@/fulfillment/order-transitions';
import { AppError, errors, isAppError } from '@/lib/errors';
import { canTransition, ORDER_STATUSES } from '@/orders/state-machine';
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
  maskedCode,
  orderTone,
  paymentTone,
} from '@/app/admin/_lib/format';
import { ORDER_PAGE_SIZE, searchOrders } from '@/app/admin/_lib/queries';

/**
 * ORDER SEARCH.
 *
 * Three statuses are shown per order and they are deliberately NOT collapsed
 * into one "status" column, because they answer different questions and move
 * independently:
 *
 *   ORDER      — where the order is in the state machine
 *   PAYMENT    — what the processor thinks (only ever written by a verified
 *                webhook or a server-side provider check)
 *   EMAIL      — whether the code actually reached the customer
 *
 * An order sitting in PAYMENT_VERIFIED with a FAILED email is the case this
 * table exists to surface: the customer paid, and nobody has their code.
 *
 * NO REDEEM CODE IS EVER SELECTED OR RENDERED HERE — only `codeLast4`, through
 * `maskedCode()`.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Orders' };

/** Order references are generated, but the filter stays permissive on purpose. */
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

function parseStatusFilter(raw: string): string {
  const value = raw.trim().toUpperCase();
  if (value === '' || value === 'ALL') return 'ALL';
  return (ORDER_STATUSES as readonly string[]).includes(value) ? value : 'ALL';
}

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePageSession('SUPPORT', '/admin/orders');

  const params = await searchParams;
  const q = firstValue(params.q).trim();
  const status = parseStatusFilter(firstValue(params.status));
  const pageParam = Number.parseInt(firstValue(params.page) ?? '1', 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
  const notice = firstValue(params.notice).trim();
  const actionError = firstValue(params.error).trim();

  const result = await searchOrders({ q, status, page, pageSize: ORDER_PAGE_SIZE });
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));

  // -------------------------------------------------------------------------
  // Server Actions
  //
  // Each one follows the same four steps, in this order, with no exceptions:
  //   1. re-authorise server-side (the session is re-read; the page guard is
  //      not trusted because a prefetched form carries no proof of anything)
  //   2. verify the mutation origin (CSRF)
  //   3. validate every field, then re-read the order inside the write
  //   4. write the change and its audit row in ONE transaction
  // -------------------------------------------------------------------------

  async function moveToManualReview(formData: FormData): Promise<void> {
    'use server';
    const actor = await requireSession('ADMIN');
    await assertMutationOrigin({ action: 'orders.moveToManualReview' });

    const listUrl = buildListUrl({ q, status, page });
    const rawReference = String(formData.get('reference') ?? '').trim();
    const reason = String(formData.get('reason') ?? '').trim().slice(0, 500);

    let outcome: { ok: true; message: string } | { ok: false; message: string };
    try {
      if (!REFERENCE_PATTERN.test(rawReference)) {
        throw errors.validation('That order reference is not a valid reference');
      }
      const reference = rawReference.toUpperCase();
      const order = await prisma.order.findUnique({
        where: { reference },
        select: { id: true, reference: true, status: true },
      });
      if (!order) throw errors.notFound('Order');

      const note = reason.length > 0 ? reason : 'Held for manual review by an operator';

      await withTransaction(async (tx) => {
        // transitionOrder writes the OrderStateTransition row; passing `tx`
        // joins it to our transaction so the state change and the audit row
        // commit or roll back together.
        await transitionOrder(
          order.id,
          'MANUAL_REVIEW',
          {
            reason: note,
            actor: actorLabel(actor),
            data: { manualReviewReason: note },
          },
          tx,
        );
        await appendAudit(tx, {
          actor: actorLabel(actor),
          actorId: actor.userId,
          action: 'order.manual_review.requested',
          entity: 'Order',
          entityId: order.id,
          metadata: { reference: order.reference, from: order.status, to: 'MANUAL_REVIEW', note },
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
    revalidatePath(`/admin/orders/${rawReference.toUpperCase()}`);
    redirect(
      outcome.ok
        ? `${listUrl}${listUrl.includes('?') ? '&' : '?'}notice=${encodeURIComponent(outcome.message)}`
        : `${listUrl}${listUrl.includes('?') ? '&' : '?'}error=${encodeURIComponent(outcome.message)}`,
    );
  }

  async function retryFulfillment(formData: FormData): Promise<void> {
    'use server';
    const actor = await requireSession('ADMIN');
    await assertMutationOrigin({ action: 'orders.retryFulfillment' });

    const listUrl = buildListUrl({ q, status, page });
    const rawReference = String(formData.get('reference') ?? '').trim();

    let outcome: { ok: true; message: string } | { ok: false; message: string };
    try {
      if (!REFERENCE_PATTERN.test(rawReference)) {
        throw errors.validation('That order reference is not a valid reference');
      }
      const reference = rawReference.toUpperCase();
      const order = await prisma.order.findUnique({
        where: { reference },
        select: {
          id: true,
          reference: true,
          status: true,
          fulfillmentJobs: {
            select: { attempts: true, maxAttempts: true, status: true },
            take: 1,
          },
        },
      });
      if (!order) throw errors.notFound('Order');

      if (!canTransition(order.status, 'FULFILLMENT_PENDING')) {
        throw errors.validation(
          `${reference} is ${order.status}; there is nothing for a fulfillment retry to do from this state.`,
        );
      }

      const job = order.fulfillmentJobs[0];
      if (job && job.attempts >= job.maxAttempts) {
        // Refusing here is honest. The durable worker would accept the event
        // and then no-op it, and an operator who was told "retry queued" would
        // reasonably believe the customer had been looked after.
        throw new AppError(
          `${reference} has spent its entire fulfillment budget (${job.attempts}/${job.maxAttempts} attempts, job ${job.status}). ` +
            'A retry would be skipped by the worker. Resolve the underlying cause — usually out of inventory — before retrying.',
          409,
          'INVALID_STATE_TRANSITION',
        );
      }

      // The retry is a DURABLE re-queue, not an inline run: fulfillment inside a
      // request handler is exactly what the Inngest workstream exists to avoid.
      await enqueueFulfillmentRetry({
        orderId: order.id,
        orderReference: order.reference,
        attempt: (job?.attempts ?? 0) + 1,
        reason: `admin retry requested by ${actor.email}`,
      });

      await tryWriteAuditLog({
        actor: actorLabel(actor),
        actorId: actor.userId,
        action: 'order.fulfillment.retry.requested',
        entity: 'Order',
        entityId: order.id,
        metadata: {
          reference: order.reference,
          status: order.status,
          attempt: (job?.attempts ?? 0) + 1,
          maxAttempts: job?.maxAttempts ?? null,
        },
      });

      outcome = {
        ok: true,
        message: `Fulfillment retry queued for ${reference}. The durable worker runs it; watch the job status on the order page.`,
      };
    } catch (error) {
      outcome = { ok: false, message: messageOf(error) };
    }

    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${rawReference.toUpperCase()}`);
    redirect(
      outcome.ok
        ? `${listUrl}${listUrl.includes('?') ? '&' : '?'}notice=${encodeURIComponent(outcome.message)}`
        : `${listUrl}${listUrl.includes('?') ? '&' : '?'}error=${encodeURIComponent(outcome.message)}`,
    );
  }

  function buildListUrl(input: { q: string; status: string; page: number }): string {
    const query = new URLSearchParams();
    if (input.q) query.set('q', input.q);
    if (input.status && input.status !== 'ALL') query.set('status', input.status);
    if (input.page > 1) query.set('page', String(input.page));
    const encoded = query.toString();
    return encoded ? `/admin/orders?${encoded}` : '/admin/orders';
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div>
      <h1 className="text-2xl font-semibold text-fg">Orders</h1>

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

      {/* --- Filters ------------------------------------------------------- */}
      <form method="get" action="/admin/orders" className="mt-6 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="order-search" className="text-sm font-medium text-fg">
            Search
          </label>
          <input
            id="order-search"
            name="q"
            type="search"
            defaultValue={q}
            placeholder="ORD-7QK2M4XB or customer@example.com"
            className="w-72 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-subtle hover:border-line-strong"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="order-status" className="text-sm font-medium text-fg">
            Status
          </label>
          <select
            id="order-status"
            name="status"
            defaultValue={status}
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg hover:border-line-strong"
          >
            <option value="ALL">All statuses</option>
            {ORDER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {humaniseToken(value)}
              </option>
            ))}
          </select>
        </div>

        <input type="hidden" name="page" value="1" />
        <button
          type="submit"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-strong"
        >
          Search
        </button>
        <Link
          href="/admin/orders"
          className="rounded-lg border border-line px-4 py-2 text-sm text-muted hover:text-fg"
        >
          Reset
        </Link>
      </form>

      <p className="mt-3 text-xs text-subtle">
        {formatCount(result.total)} order{result.total === 1 ? '' : 's'} match
        {q ? ` "${q}"` : ''}
        {status !== 'ALL' ? ` in ${humaniseToken(status)}` : ''}. Page {result.page} of {totalPages}.
      </p>

      {/* --- Table --------------------------------------------------------- */}
      {result.orders.length === 0 ? (
        <p className="mt-8 text-sm text-muted">No orders match those filters.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {result.orders.map((order) => {
            const canReview = canTransition(order.status, 'MANUAL_REVIEW');
            const canRetry = canTransition(order.status, 'FULFILLMENT_PENDING');
            return (
              <article
                key={order.id}
                className="rounded-lg border border-line bg-surface-2 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/admin/orders/${order.reference}`}
                        className="font-mono text-sm font-semibold text-fg underline hover:text-accent"
                      >
                        {order.reference}
                      </Link>
                      <span className={badgeClass(orderTone(order.status))}>
                        {humaniseToken(order.status)}
                      </span>
                      {order.paymentStatus ? (
                        <span className={badgeClass(paymentTone(order.paymentStatus))}>
                          Payment: {humaniseToken(order.paymentStatus)}
                        </span>
                      ) : (
                        <span className={badgeClass('neutral')}>Payment: none</span>
                      )}
                      {order.fulfillmentStatus ? (
                        <span className={badgeClass(fulfillmentTone(order.fulfillmentStatus))}>
                          Fulfillment: {humaniseToken(order.fulfillmentStatus)}
                        </span>
                      ) : (
                        <span className={badgeClass('neutral')}>Fulfillment: none</span>
                      )}
                      {order.emailStatus ? (
                        <span className={badgeClass(emailTone(order.emailStatus))}>
                          Email: {humaniseToken(order.emailStatus)}
                        </span>
                      ) : (
                        <span className={badgeClass('neutral')}>Email: none</span>
                      )}
                    </div>

                    <p className="mt-2 text-sm text-muted">
                      {order.productName} × {order.quantity} · {order.customerEmail}
                    </p>
                    <p className="mt-1 text-xs text-subtle">
                      {formatDateTime(order.createdAt)} ·{' '}
                      {displayPriceValue(order.totalMinor, order.faceValueMinor, order.currency)}{' '}
                      · code {maskedCode(order.codeLast4)}
                    </p>
                  </div>

                  <div className="flex flex-col items-end gap-2">
                    {canReview ? (
                      <form action={moveToManualReview} className="flex items-end gap-2">
                        <input type="hidden" name="reference" value={order.reference} />
                        <div className="flex flex-col gap-1">
                          <label
                            htmlFor={`reason-${order.id}`}
                            className="text-xs text-subtle"
                          >
                            Reason (optional)
                          </label>
                          <input
                            id={`reason-${order.id}`}
                            name="reason"
                            type="text"
                            maxLength={500}
                            placeholder="e.g. customer reports no email"
                            className="w-56 rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-fg placeholder:text-subtle"
                          />
                        </div>
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
                        No operator action available from {humaniseToken(order.status)}.
                      </p>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* --- Pagination ---------------------------------------------------- */}
      {totalPages > 1 ? (
        <nav aria-label="Pagination" className="mt-8 flex items-center gap-3">
          {result.page > 1 ? (
            <Link
              href={buildListUrl({ q, status, page: result.page - 1 })}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg"
            >
              Previous
            </Link>
          ) : null}
          <span className="text-xs text-subtle">
            Page {result.page} / {totalPages}
          </span>
          {result.page < totalPages ? (
            <Link
              href={buildListUrl({ q, status, page: result.page + 1 })}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg"
            >
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
