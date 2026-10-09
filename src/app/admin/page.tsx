import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert } from '@/components/alert';
import { requirePageSession } from '@/app/admin/_lib/auth';
import {
  badgeClass,
  displayPriceValue,
  formatCount,
  formatDateTime,
  humaniseToken,
  inventoryTone,
  signedMoney,
} from '@/app/admin/_lib/format';
import { loadDashboard, startOfUtcToday, type CurrencyRevenue } from '@/app/admin/_lib/queries';
import { isDatabaseConfigured } from '@/db/prisma';
import { formatMoney, marginBps } from '@/lib/money';
import { logger } from '@/lib/logger';

/**
 * OPERATOR DASHBOARD.
 *
 * THE ONE NUMBER THAT MATTERS IS NET, NOT GROSS.
 *
 * A $1 code sold for $3 looks like 200% margin on `Order.totalMinor`. It is not.
 * The processor takes a percentage AND a fixed amount, and on a $3 ticket the
 * fixed amount is the majority of the fee — the percentage is nearly a
 * rounding error. So this page:
 *
 *   - reports revenue GROSS and NET side by side, where NET prefers
 *     `Payment.netAmountMinor` (Whop's `amount_after_fees`) and counts how many
 *     captured payments were missing that field, because a net figure silently
 *     estimated for half the book is not a net figure;
 *   - shows the fee as its own line rather than netting it away;
 *   - computes margin on NET, not on the order total, and subtracts real COGS.
 *
 * All arithmetic is integer minor units. Currencies are never summed together:
 * each currency gets its own row, its own margin and its own fee percentage.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Dashboard' };

/**
 * Whop's published schedule for this deployment, in integer units so the
 * illustration below is exact rather than float-approximate.
 *
 * THIS IS AN ILLUSTRATION, NOT A SOURCE OF TRUTH. The authoritative per-payment
 * fee is `Payment.feeMinor` / `netAmountMinor - amountMinor`, which the
 * revenue table reports directly. These constants exist only to show the
 * operator WHY a low-ticket SKU is dominated by the fixed component: at $3.00
 * the percentage is ~8c and the fixed part is 30c, so roughly four fifths of the
 * fee does not scale with the sale.
 */
const FEE_PERCENT_BPS = 270; // 2.70%
const FEE_FIXED_MINOR = 30; // $0.30

/** Fee on one ticket, in integer minor units, for a 2-exponent currency. */
function illustrativeFee(ticketMinor: number): number {
  return Math.round((ticketMinor * FEE_PERCENT_BPS) / 10_000) + FEE_FIXED_MINOR;
}

function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-success'
      : tone === 'warn'
        ? 'text-warning'
        : tone === 'bad'
          ? 'text-danger'
          : 'text-fg';
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-4">
      <p className="text-xs uppercase tracking-wide text-subtle">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function Section({
  title,
  description,
  id,
  children,
}: {
  title: string;
  description?: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10" id={id}>
      <h2 className="text-lg font-semibold text-fg">{title}</h2>
      {description ? <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * Net margin for one currency: real net revenue minus real cost of goods sold.
 * Integer arithmetic throughout; the bps figure comes from `@/lib/money` so the
 * dashboard cannot disagree with the pricing engine about what a margin is.
 */
function netMarginFor(
  revenue: CurrencyRevenue,
  cogsMinor: number | null,
): { profitMinor: number; marginBps: number | null } | null {
  if (revenue.capturedPayments === 0) return null;
  const profit = revenue.netMinor - (cogsMinor ?? 0);
  return {
    profitMinor: profit,
    marginBps: revenue.netMinor === 0 ? null : marginBps(revenue.netMinor, cogsMinor ?? 0),
  };
}

export default async function AdminDashboardPage() {
  // Page-level guard. Runs before any query; an unauthenticated caller gets a
  // redirect to the sign-in screen and never reaches a single row below.
  await requirePageSession('SUPPORT', '/admin');

  if (!isDatabaseConfigured()) {
    return (
      <Alert variant="error" title="DATABASE IS NOT CONFIGURED">
        <p>
          <code>DATABASE_URL</code> is unset, so no dashboard figures can be read. This panel does
          not show placeholder or sample numbers — an operator cannot tell a real zero from a
          missing database, so it refuses to draw.
        </p>
      </Alert>
    );
  }

  let snapshot;
  try {
    snapshot = await loadDashboard();
  } catch (error) {
    logger.error('Admin dashboard failed to load', {
      error: error instanceof Error ? error.message : String(error),
    });
    return (
      <Alert variant="error" title="The dashboard could not be loaded">
        <p>
          The query failed. Check the database connection and the server log. No figures are shown
          because a partially-loaded dashboard is worse than none.
        </p>
      </Alert>
    );
  }

  const {
    revenue,
    successfulPayments,
    failedPayments,
    pendingPayments,
    expiredPayments,
    disputedPayments,
    completedOrders,
    manualReviewOrders,
    failedFulfillmentOrders,
    fulfillmentJobs,
    refunds,
    cogs,
    productsByStatus,
    lowStock,
    inventory,
    generatedAt,
  } = snapshot;

  const cogsByCurrency = new Map(cogs.map((row) => [row.currency, row.cogsMinor]));
  const todayBoundary = startOfUtcToday(generatedAt);
  const illustrativeTicket = 300; // $3.00 — the catalog's standard tier
  const ticketFee = illustrativeFee(illustrativeTicket);

  const totalNet = revenue.reduce((sum, row) => sum + row.netMinor, 0);
  const totalGross = revenue.reduce((sum, row) => sum + row.grossMinor, 0);
  const totalFees = revenue.reduce((sum, row) => sum + row.feeMinor, 0);
  const todayNet = revenue.reduce((sum, row) => sum + row.todayNetMinor, 0);
  const todayCount = revenue.reduce((sum, row) => sum + row.todayCount, 0);
  const paymentsMissingNet = revenue.reduce((sum, row) => sum + row.paymentsWithoutNet, 0);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold text-fg">Dashboard</h1>
        <p className="text-xs text-subtle">Generated {formatDateTime(generatedAt)}</p>
      </div>

      {/* --- Headline ------------------------------------------------------ */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Total revenue (net, post-fee)"
          value={
            revenue.length === 0
              ? '—'
              : revenue.length === 1
                ? formatMoney(totalNet, revenue[0]?.currency ?? 'USD')
                : `${formatMoney(totalNet, revenue[0]?.currency ?? 'USD')} + ${revenue.length - 1} more`
          }
          hint={
            revenue.length === 0
              ? 'No captured payments yet'
              : `${formatMoney(totalGross, revenue[0]?.currency ?? 'USD')} gross · ${formatMoney(totalFees, revenue[0]?.currency ?? 'USD')} fees`
          }
        />
        <StatTile
          label={`Today (UTC from ${formatDateTime(todayBoundary)})`}
          value={
            revenue.length === 0 ? '—' : formatMoney(todayNet, revenue[0]?.currency ?? 'USD')
          }
          hint={`${formatCount(todayCount)} captured payment${todayCount === 1 ? '' : 's'}`}
        />
        <StatTile
          label="Successful payments"
          value={formatCount(successfulPayments)}
          tone="good"
          hint="PAID, partially refunded or refunded"
        />
        <StatTile
          label="Failed payments"
          value={formatCount(failedPayments)}
          tone={failedPayments > 0 ? 'bad' : 'neutral'}
          hint={`${formatCount(pendingPayments)} pending · ${formatCount(expiredPayments)} expired · ${formatCount(disputedPayments)} disputed/reversed`}
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Completed orders"
          value={formatCount(completedOrders)}
          tone="good"
          hint={`${formatCount(manualReviewOrders)} awaiting manual review`}
        />
        <StatTile
          label="Failed fulfillment"
          value={formatCount(failedFulfillmentOrders)}
          tone={failedFulfillmentOrders > 0 ? 'bad' : 'neutral'}
          hint={`${formatCount(
            fulfillmentJobs.find((job) => job.status === 'DEAD_LETTER')?.count ?? 0,
          )} dead-lettered job(s)`}
        />
        <StatTile
          label="Refunds"
          value={formatCount(refunds.count)}
          tone={refunds.failedCount > 0 ? 'bad' : 'neutral'}
          hint={`${formatCount(refunds.succeededCount)} succeeded · ${formatCount(refunds.pendingCount)} pending · ${formatCount(refunds.failedCount)} failed`}
        />
        <StatTile
          label="Inventory codes"
          value={formatCount(inventory.total)}
          hint={`${formatCount(inventory.reservedForOrders)} reserved or assigned · ${formatCount(inventory.expiredReservations)} lease(s) expired`}
        />
      </div>

      {manualReviewOrders > 0 || failedFulfillmentOrders > 0 ? (
        <div className="mt-6">
          <Alert variant="warning" title="Orders need a human">
            <p>
              <Link href="/admin/orders?status=MANUAL_REVIEW" className="underline">
                {formatCount(manualReviewOrders)} in MANUAL_REVIEW
              </Link>{' '}
              ·{' '}
              <Link href="/admin/orders?status=FULFILLMENT_FAILED" className="underline">
                {formatCount(failedFulfillmentOrders)} with FULFILLMENT_FAILED
              </Link>
              . Both hold inventory or money that a customer paid for.
            </p>
          </Alert>
        </div>
      ) : null}

      {/* --- Revenue ------------------------------------------------------- */}
      <Section
        title="Revenue by currency"
        description="Gross is what the customer was charged. Net is what actually landed, preferring Payment.netAmountMinor (post-fee) over Order.totalMinor. Currencies are never added together."
      >
        {revenue.length === 0 ? (
          <p className="text-sm text-muted">No captured payments yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-xs uppercase tracking-wide text-subtle">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Currency</th>
                  <th scope="col" className="px-4 py-3 font-medium">Gross</th>
                  <th scope="col" className="px-4 py-3 font-medium">Net (post-fee)</th>
                  <th scope="col" className="px-4 py-3 font-medium">Processor fees</th>
                  <th scope="col" className="px-4 py-3 font-medium">Fee %</th>
                  <th scope="col" className="px-4 py-3 font-medium">Today (net)</th>
                  <th scope="col" className="px-4 py-3 font-medium">Captured</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {revenue.map((row) => {
                  const feePct =
                    row.grossMinor === 0
                      ? null
                      : Math.round((row.feeMinor * 10_000) / row.grossMinor);
                  return (
                    <tr key={row.currency} className="align-top">
                      <td className="px-4 py-3 font-medium uppercase">{row.currency}</td>
                      <td className="px-4 py-3 tabular-nums">{formatMoney(row.grossMinor, row.currency)}</td>
                      <td className="px-4 py-3 tabular-nums font-medium">
                        {formatMoney(row.netMinor, row.currency)}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-warning">
                        {signedMoney(-row.feeMinor, row.currency)}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted">
                        {feePct === null ? '—' : `${(feePct / 100).toFixed(2)}%`}
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {formatMoney(row.todayNetMinor, row.currency)}
                        <span className="ml-1 text-xs text-subtle">({formatCount(row.todayCount)})</span>
                      </td>
                      <td className="px-4 py-3 tabular-nums">{formatCount(row.capturedPayments)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {paymentsMissingNet > 0 ? (
          <div className="mt-3">
            <Alert variant="warning" title="Some net figures are estimated">
              <p>
                {formatCount(paymentsMissingNet)} captured payment(s) have no
                <code> netAmountMinor</code>, so their net was assumed equal to gross (zero fees).
                The net column is therefore an upper bound until those payments report
                <code> amount_after_fees</code>.
              </p>
            </Alert>
          </div>
        ) : null}
      </Section>

      {/* --- Refunds ------------------------------------------------------- */}
      <Section
        id="refunds"
        title="Refunds by currency"
        description="Refunds that actually succeeded, one row per currency. Refund amounts are never added across currencies — the same rule the revenue table above follows, and for the same reason."
      >
        {refunds.byCurrency.length === 0 ? (
          <p className="text-sm text-muted">No refunds have been requested.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-xs uppercase tracking-wide text-subtle">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Currency</th>
                  <th scope="col" className="px-4 py-3 font-medium">Refunded</th>
                  <th scope="col" className="px-4 py-3 font-medium">Succeeded</th>
                  <th scope="col" className="px-4 py-3 font-medium">Pending</th>
                  <th scope="col" className="px-4 py-3 font-medium">Failed</th>
                  <th scope="col" className="px-4 py-3 font-medium">All refunds</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {refunds.byCurrency.map((row) => (
                  <tr key={row.currency} className="align-top">
                    <td className="px-4 py-3 font-medium uppercase">{row.currency}</td>
                    <td className="px-4 py-3 tabular-nums font-medium text-warning">
                      {formatMoney(row.succeededMinor, row.currency)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{formatCount(row.succeededCount)}</td>
                    <td className="px-4 py-3 tabular-nums">{formatCount(row.pendingCount)}</td>
                    <td className="px-4 py-3 tabular-nums">{formatCount(row.failedCount)}</td>
                    <td className="px-4 py-3 tabular-nums text-muted">{formatCount(row.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* --- Why low-ticket SKUs are thin ---------------------------------- */}
      <Section
        title="Why low-ticket SKUs are thin"
        description="The percentage fee is not what hurts a $3 sale — the fixed fee is."
      >
        <div className="rounded-lg border border-line bg-surface-2 p-4 text-sm">
          <p className="text-muted">
            On a{' '}
            <span className="font-semibold text-fg">
              {formatMoney(illustrativeTicket, 'USD')}
            </span>{' '}
            ticket, a {FEE_PERCENT_BPS / 100}% + {formatMoney(FEE_FIXED_MINOR, 'USD')} schedule costs{' '}
            <span className="font-semibold text-warning">{formatMoney(ticketFee, 'USD')}</span> —
            that is{' '}
            <span className="font-semibold text-fg">
              {Math.round((ticketFee * 10_000) / illustrativeTicket) / 100}%
            </span>{' '}
            of the sale, of which {formatMoney(FEE_FIXED_MINOR, 'USD')} does not scale with the
            price at all.
          </p>
          <p className="mt-3 text-muted">
            Realised fee rate on captured payments:{' '}
            {totalGross === 0 ? (
              '—'
            ) : (
              <span className="font-semibold text-fg">
                {((Math.round((totalFees * 10_000) / totalGross) || 0) / 100).toFixed(2)}%
              </span>
            )}{' '}
            ({formatMoney(totalFees, revenue[0]?.currency ?? 'USD')} of{' '}
            {formatMoney(totalGross, revenue[0]?.currency ?? 'USD')}).
          </p>
        </div>
      </Section>

      {/* --- Margin -------------------------------------------------------- */}
      <Section
        title="Gross margin on net revenue"
        description="Net revenue (post-fee) minus cost of goods sold. Cost is priced from the live Product row — Order snapshots the price the customer paid, not today's supplier cost."
      >
        {revenue.length === 0 ? (
          <p className="text-sm text-muted">Nothing to report until a payment is captured.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-xs uppercase tracking-wide text-subtle">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Currency</th>
                  <th scope="col" className="px-4 py-3 font-medium">Net revenue</th>
                  <th scope="col" className="px-4 py-3 font-medium">COGS</th>
                  <th scope="col" className="px-4 py-3 font-medium">Gross profit (net)</th>
                  <th scope="col" className="px-4 py-3 font-medium">Margin</th>
                  <th scope="col" className="px-4 py-3 font-medium">Orders with released stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {revenue.map((row) => {
                  const margin = netMarginFor(row, cogsByCurrency.get(row.currency) ?? null);
                  const cogsMissing = !cogsByCurrency.has(row.currency);
                  return (
                    <tr key={row.currency} className="align-top">
                      <td className="px-4 py-3 font-medium uppercase">{row.currency}</td>
                      <td className="px-4 py-3 tabular-nums">{formatMoney(row.netMinor, row.currency)}</td>
                      <td className="px-4 py-3 tabular-nums">
                        {cogsMissing && margin ? (
                          <span className="text-subtle">no released orders</span>
                        ) : (
                          formatMoney(cogsByCurrency.get(row.currency) ?? 0, row.currency)
                        )}
                      </td>
                      <td
                        className={`px-4 py-3 tabular-nums font-medium ${
                          margin && margin.profitMinor < 0 ? 'text-danger' : 'text-fg'
                        }`}
                      >
                        {margin ? formatMoney(margin.profitMinor, row.currency) : '—'}
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {margin?.marginBps === null || margin === null
                          ? '—'
                          : `${(margin.marginBps / 100).toFixed(2)}%`}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted">
                        {formatCount(cogs.find((entry) => entry.currency === row.currency)?.orders ?? 0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* --- Inventory ----------------------------------------------------- */}
      <Section
        title="Inventory"
        description="Counts by status across every product. Expired reservation leases are stock a crashed checkout is still holding."
      >
        <div className="flex flex-wrap gap-2">
          {inventory.byStatus.length === 0 ? (
            <p className="text-sm text-muted">No inventory has been imported.</p>
          ) : (
            inventory.byStatus.map((entry) => (
              <span
                key={entry.status}
                className={badgeClass(inventoryTone(entry.status))}
              >
                {humaniseToken(entry.status)}: {formatCount(entry.count)}
              </span>
            ))
          )}
        </div>

        {inventory.expiredReservations > 0 ? (
          <div className="mt-4">
            <Alert variant="warning" title="Expired reservation leases">
              <p>
                {formatCount(inventory.expiredReservations)} code(s) are RESERVED past their lease.
                The inventory reaper reclaims them; until it runs they are unsellable stock.
              </p>
            </Alert>
          </div>
        ) : null}

        {lowStock.length > 0 ? (
          <div className="mt-4 overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-xs uppercase tracking-wide text-subtle">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Product</th>
                  <th scope="col" className="px-4 py-3 font-medium">Terms</th>
                  <th scope="col" className="px-4 py-3 font-medium">Available</th>
                  <th scope="col" className="px-4 py-3 font-medium">&nbsp;</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {lowStock.map((product) => (
                  <tr key={product.id}>
                    <td className="px-4 py-3">
                      <span className="font-medium">{product.productName}</span>
                      <span className="ml-2 text-xs text-subtle">{product.slug}</span>
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {displayPriceValue(
                        product.sellingPriceMinor,
                        product.faceValueMinor,
                        product.currency,
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {product.inventoryCount === 0 ? (
                        <span className="text-danger">out of stock</span>
                      ) : (
                        <span className={product.inventoryCount <= 5 ? 'text-warning' : undefined}>
                          {formatCount(product.inventoryCount)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/inventory#product-${product.id}`}
                        className="text-xs text-muted underline hover:text-fg"
                      >
                        Inventory
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <p className="mt-4 text-xs text-subtle">
          <Link href="/admin/inventory" className="underline">
            Full inventory and CSV import
          </Link>
        </p>
      </Section>

      {/* --- Operations ---------------------------------------------------- */}
      <Section title="Pipeline health">
        <div className="grid gap-6 lg:grid-cols-3">
          <div>
            <h3 className="text-sm font-semibold text-fg">Fulfillment jobs</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {fulfillmentJobs.length === 0 ? (
                <li className="text-muted">No fulfillment jobs yet.</li>
              ) : (
                fulfillmentJobs.map((job) => (
                  <li key={job.status} className="flex items-center justify-between">
                    <span className="text-muted">{humaniseToken(job.status)}</span>
                    <span className="tabular-nums">{formatCount(job.count)}</span>
                  </li>
                ))
              )}
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-fg">Products</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {productsByStatus.length === 0 ? (
                <li className="text-muted">No products defined.</li>
              ) : (
                productsByStatus.map((entry) => (
                  <li key={entry.status} className="flex items-center justify-between">
                    <span className="text-muted">{humaniseToken(entry.status)}</span>
                    <span className="tabular-nums">{formatCount(entry.count)}</span>
                  </li>
                ))
              )}
            </ul>
            <p className="mt-2 text-xs text-subtle">
              <Link href="/admin/products" className="underline">
                Pricing and publish state
              </Link>
            </p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-fg">Refunds</h3>
            <ul className="mt-2 space-y-1 text-sm">
              <li className="flex items-center justify-between">
                <span className="text-muted">Succeeded</span>
                <span className="tabular-nums">{formatCount(refunds.succeededCount)}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-muted">Pending</span>
                <span className="tabular-nums">{formatCount(refunds.pendingCount)}</span>
              </li>
              <li className="flex items-center justify-between">
                <span className="text-muted">Failed</span>
                <span className="tabular-nums">{formatCount(refunds.failedCount)}</span>
              </li>
            </ul>
            <p className="mt-2 text-xs text-subtle">
              <Link href="/admin/refunds" className="underline">
                Refunds, per currency
              </Link>
            </p>
          </div>
        </div>

        {refunds.count > 0 ? (
          <p className="mt-4 text-xs text-subtle">
            The counts above are rows, not amounts, so they are stated for the whole book. Refund{' '}
            <em>amounts</em> are reported per currency in{' '}
            <Link href="#refunds" className="underline">
              Refunds by currency
            </Link>{' '}
            and on the{' '}
            <Link href="/admin/refunds" className="underline">
              refunds page
            </Link>
            .
          </p>
        ) : null}
      </Section>
    </div>
  );
}
