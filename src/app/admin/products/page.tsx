import type { Metadata } from 'next';
import Link from 'next/link';
import { ProductStatus } from '@prisma/client';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { Alert } from '@/components/alert';
import { withTransaction } from '@/db/prisma';
import { errors, isAppError } from '@/lib/errors';
import { discountBps as computeDiscountBps, formatMoney, marginBps as computeMarginBps } from '@/lib/money';
import {
  assertPublishable,
  computePricingForProduct,
  effectivePricingRule,
  loadPricingRules,
  type PricingResult,
} from '@/catalog/pricing';
import { appendAudit, actorLabel } from '@/app/admin/_lib/audit';
import { assertMutationOrigin, requirePageSession, requireSession } from '@/app/admin/_lib/auth';
import {
  badgeClass,
  bpsLabel,
  describeDiscountBps,
  describeMarginBps,
  formatCount,
  humaniseToken,
} from '@/app/admin/_lib/format';
import { amountInputValue, parseAmountInput } from '@/app/admin/_lib/money-input';
import { loadAdminProducts } from '@/app/admin/_lib/queries';

/**
 * PRODUCT PRICING.
 *
 * THE COMMERCIAL MODEL, STATED ONCE: the customer pays $3 and receives a $1
 * redeem code. `discountBps` is therefore NEGATIVE for this catalog — a $3 price
 * against a $1 face value is -20000 bps, a 200% premium, and it is never
 * sign-flipped anywhere on this page. `computePricing` compares the MAGNITUDE of
 * the gap against the rule's minimum and reports the direction in words, so the
 * rule cannot be satisfied by inverting the business.
 *
 * Every row shows the STORED bps columns and the COMPUTED verdict side by side.
 * If they disagree, the stored column is stale — which is itself worth seeing.
 *
 * Two Server Actions, both of which re-authorise, validate, and write an
 * AuditLog row inside the same transaction as the change.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Products' };

const EDITABLE_STATUSES = [
  ProductStatus.ACTIVE,
  ProductStatus.HIDDEN,
  ProductStatus.DRAFT,
  ProductStatus.ARCHIVED,
] as const;

function messageOf(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

/**
 * Module-level (NOT component-scoped) helpers.
 *
 * A Server Action's closure is serialised, so anything it captures must be a
 * plain serialisable value. A helper defined inside the component body would be
 * captured as a function, which React refuses to send. These live at module
 * scope, and each action re-reads the pricing rules from the database rather
 * than capturing them from the render — so an operator who edits a price after
 * somebody changed a rule is judged against the rule that is live NOW, not the
 * one that was on screen when the page loaded.
 */

async function loadProductForEdit(id: string) {
  const { prisma } = await import('@/db/prisma');
  return prisma.product.findUnique({
    where: { id },
    select: {
      id: true,
      slug: true,
      productName: true,
      category: true,
      currency: true,
      faceValueMinor: true,
      sellingPriceMinor: true,
      supplierCostMinor: true,
      discountBps: true,
      marginBps: true,
      status: true,
      inventoryCount: true,
    },
  });
}

type PricedProduct = {
  faceValueMinor: number;
  sellingPriceMinor: number;
  supplierCostMinor: number;
  currency: string;
  category: string;
};

/** Loads the live rules and evaluates one product against the one that covers it. */
async function evaluateAgainstLiveRule(product: PricedProduct): Promise<PricingResult> {
  const rules = await loadPricingRules();
  return computePricingForProduct(product, effectivePricingRule(product.category, rules));
}

export default async function AdminProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePageSession('ADMIN', '/admin/products');

  const params = await searchParams;
  const notice = typeof params.notice === 'string' ? params.notice : '';
  const actionError = typeof params.error === 'string' ? params.error : '';

  const [products, rules] = await Promise.all([loadAdminProducts(), loadPricingRules()]);

  // -------------------------------------------------------------------------
  // Server Actions
  // -------------------------------------------------------------------------

  async function savePricing(formData: FormData): Promise<void> {
    'use server';
    const actor = await requireSession('ADMIN');
    await assertMutationOrigin({ action: 'products.savePricing' });

    const productId = String(formData.get('productId') ?? '').trim();
    const rawSellingPrice = String(formData.get('sellingPrice') ?? '').trim();
    const rawFaceValue = String(formData.get('faceValue') ?? '').trim();

    let outcome: { ok: true; message: string } | { ok: false; message: string };

    try {
      if (productId.length === 0) throw errors.validation('No product was selected');

      const product = await loadProductForEdit(productId);
      if (!product) throw errors.notFound('Product');

      // Both fields are re-parsed here from the submitted major-unit string with
      // the exact decimal parser. The browser's value is never trusted, and a
      // value the currency cannot represent is rejected rather than truncated.
      const sellingPriceMinor = parseAmountInput(rawSellingPrice, product.currency, 'Selling price');
      const faceValueMinor = parseAmountInput(rawFaceValue, product.currency, 'Face value');

      if (sellingPriceMinor <= 0) {
        throw errors.validation(
          'Selling price must be greater than zero — this catalog sells at a markup, so the price is never zero',
        );
      }
      if (faceValueMinor <= 0) throw errors.validation('Face value must be greater than zero');

      // Evaluate the NEW numbers against the rule that actually covers this
      // category, so the verdict below is the verdict the storefront would get.
      const result = computePricingForProduct(
        {
          faceValueMinor,
          sellingPriceMinor,
          supplierCostMinor: product.supplierCostMinor,
          currency: product.currency,
          category: product.category,
        },
        effectivePricingRule(product.category, await loadPricingRules()),
      );

      const nextDiscountBps = computeDiscountBps(faceValueMinor, sellingPriceMinor);
      const nextMarginBps = computeMarginBps(sellingPriceMinor, product.supplierCostMinor);

      await withTransaction(async (tx) => {
        await tx.product.update({
          where: { id: product.id },
          data: {
            sellingPriceMinor,
            faceValueMinor,
            discountBps: nextDiscountBps,
            marginBps: nextMarginBps,
          },
        });
        await appendAudit(tx, {
          actor: actorLabel(actor),
          actorId: actor.userId,
          action: 'product.pricing.updated',
          entity: 'Product',
          entityId: product.id,
          metadata: {
            slug: product.slug,
            from: {
              sellingPriceMinor: product.sellingPriceMinor,
              faceValueMinor: product.faceValueMinor,
              discountBps: product.discountBps,
              marginBps: product.marginBps,
            },
            to: {
              sellingPriceMinor,
              faceValueMinor,
              discountBps: nextDiscountBps,
              marginBps: nextMarginBps,
            },
            currency: product.currency,
            rule: result.ruleName,
            publishable: result.publishable,
          },
        });
      });

      const verdict = result.publishable
        ? `It ${result.reason}`
        : `Saved, but it now ${result.reason} The product is still ${
            product.status === 'ACTIVE' ? 'ACTIVE' : product.status
          } — publishing checks will refuse it until the price or the rule is fixed, or you hide it.`;

      outcome = {
        ok: true,
        message: `${product.productName}: ${verdict}`,
      };
    } catch (error) {
      outcome = { ok: false, message: messageOf(error) };
    }

    revalidatePath('/admin/products');
    redirect(`/admin/products?${outcome.ok ? 'notice' : 'error'}=${encodeURIComponent(outcome.message)}`);
  }

  async function setStatus(formData: FormData): Promise<void> {
    'use server';
    const actor = await requireSession('ADMIN');
    await assertMutationOrigin({ action: 'products.setStatus' });

    const productId = String(formData.get('productId') ?? '').trim();
    const requested = String(formData.get('status') ?? '').trim().toUpperCase();
    const nextStatus = EDITABLE_STATUSES.find((value) => value === requested);

    let outcome: { ok: true; message: string } | { ok: false; message: string };

    try {
      if (!nextStatus) {
        throw errors.validation(
          `Unknown status "${requested}". Allowed: ${EDITABLE_STATUSES.join(', ')}`,
        );
      }
      const product = await loadProductForEdit(productId);
      if (!product) throw errors.notFound('Product');

      // Publishing is gated on the pricing rule. Hiding, archiving and drafting
      // are always allowed — hiding a failing product is an explicit decision
      // with an audit row, never a silent side effect of a margin check.
      if (nextStatus === ProductStatus.ACTIVE && product.status !== ProductStatus.ACTIVE) {
        const result = await evaluateAgainstLiveRule(product);
        assertPublishable(result, product.id);
      }

      await withTransaction(async (tx) => {
        await tx.product.update({ where: { id: product.id }, data: { status: nextStatus } });
        await appendAudit(tx, {
          actor: actorLabel(actor),
          actorId: actor.userId,
          action: `product.status.${nextStatus.toLowerCase()}`,
          entity: 'Product',
          entityId: product.id,
          metadata: { slug: product.slug, from: product.status, to: nextStatus },
        });
      });

      outcome = {
        ok: true,
        message: `${product.productName} is now ${nextStatus}.`,
      };
    } catch (error) {
      outcome = { ok: false, message: messageOf(error) };
    }

    revalidatePath('/admin/products');
    redirect(`/admin/products?${outcome.ok ? 'notice' : 'error'}=${encodeURIComponent(outcome.message)}`);
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-fg">Products</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        The customer pays the listed price and receives a code worth its face value. A negative
        discount is the intended premium, not an error — it is never flipped to make a rule pass.
      </p>

      {notice ? (
        <div className="mt-4">
          <Alert variant="success" title="Done">
            <p>{notice}</p>
          </Alert>
        </div>
      ) : null}
      {actionError ? (
        <div className="mt-4">
          <Alert variant="error" title="Change refused">
            <p>{actionError}</p>
          </Alert>
        </div>
      ) : null}

      {products.length === 0 ? (
        <p className="mt-8 text-sm text-muted">
          No products exist yet. Seed data or the catalog import creates them.
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          {products.map((product) => {
            const rule = effectivePricingRule(product.category, rules);

            // computePricing is total for well-formed rows but THROWS on a
            // structurally broken one (zero price, non-integer minor units). A
            // single bad draft must not take the whole panel down, so the
            // verdict is computed defensively and reported as invalid data.
            let verdict: PricingResult | null = null;
            let verdictError: string | null = null;
            try {
              verdict = computePricingForProduct(
                {
                  faceValueMinor: product.faceValueMinor,
                  sellingPriceMinor: product.sellingPriceMinor,
                  supplierCostMinor: product.supplierCostMinor,
                  currency: product.currency,
                  category: product.category,
                },
                rule,
              );
            } catch (error) {
              verdictError = messageOf(error);
            }

            const storedMatchesComputed =
              verdict !== null &&
              verdict.discountBps === product.discountBps &&
              verdict.marginBps === product.marginBps;

            const active = product.status === 'ACTIVE';

            return (
              <article
                key={product.id}
                className="rounded-lg border border-line bg-surface-2 p-4"
                id={`product-${product.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-fg">{product.productName}</h2>
                      <span
                        className={badgeClass(active ? 'good' : product.status === 'ARCHIVED' ? 'neutral' : 'warn')}
                      >
                        {humaniseToken(product.status)}
                      </span>
                      {verdict === null ? (
                        <span className={badgeClass('bad')}>Pricing data invalid</span>
                      ) : verdict.publishable ? (
                        <span className={badgeClass('good')}>Passes rule “{verdict.ruleName}”</span>
                      ) : (
                        <span className={badgeClass('bad')}>Fails rule “{verdict.ruleName}”</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-subtle">
                      {product.slug} · {product.brand} · {product.category} · {product.region} ·{' '}
                      {formatCount(product.inventoryCount)} in stock
                    </p>
                  </div>

                  <div className="text-right">
                    <p className="text-sm font-semibold text-fg">
                      {formatMoney(product.sellingPriceMinor, product.currency)}
                    </p>
                    <p className="text-xs text-muted">
                      value {formatMoney(product.faceValueMinor, product.currency)} · cost{' '}
                      {formatMoney(product.supplierCostMinor, product.currency)}
                    </p>
                  </div>
                </div>

                <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-subtle">Discount (stored)</dt>
                    <dd className="tabular-nums text-fg">{bpsLabel(product.discountBps)}</dd>
                    <dd className="text-xs text-muted">{describeDiscountBps(product.discountBps)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-subtle">Margin (stored)</dt>
                    <dd className="tabular-nums text-fg">{bpsLabel(product.marginBps)}</dd>
                    <dd className="text-xs text-muted">{describeMarginBps(product.marginBps)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-subtle">Gross profit</dt>
                    <dd className="tabular-nums text-fg">
                      {formatMoney(
                        product.sellingPriceMinor - product.supplierCostMinor,
                        product.currency,
                      )}
                    </dd>
                    <dd className="text-xs text-muted">
                      before processor fees — see the dashboard for realised net
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-subtle">Rule</dt>
                    <dd className="text-fg">{rule.name}</dd>
                    <dd className="text-xs text-muted">
                      min gap {bpsLabel(rule.minDiscountBps)} · min margin {bpsLabel(rule.minMarginBps)}
                      {rule.autoHideOnFail ? ' · auto-hide on fail' : ''}
                    </dd>
                  </div>
                </dl>

                {verdictError ? (
                  <div className="mt-3">
                    <Alert variant="error" title="Pricing cannot be evaluated">
                      <p>{verdictError}</p>
                    </Alert>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted">
                    {verdict?.reason}
                    {!storedMatchesComputed ? (
                      <span className="ml-2 text-warning">
                        Stored bps differ from the computed values — the stored columns are stale.
                      </span>
                    ) : null}
                  </p>
                )}

                {/* --- Actions ------------------------------------------------ */}
                <div className="mt-4 flex flex-wrap items-end gap-6 border-t border-line pt-4">
                  <form action={savePricing} className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="productId" value={product.id} />
                    <div className="flex flex-col gap-1">
                      <label htmlFor={`price-${product.id}`} className="text-xs text-muted">
                        Selling price ({product.currency.toUpperCase()})
                      </label>
                      <input
                        id={`price-${product.id}`}
                        name="sellingPrice"
                        type="text"
                        inputMode="decimal"
                        defaultValue={amountInputValue(product.sellingPriceMinor, product.currency)}
                        className="w-32 rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label htmlFor={`value-${product.id}`} className="text-xs text-muted">
                        Face value ({product.currency.toUpperCase()})
                      </label>
                      <input
                        id={`value-${product.id}`}
                        name="faceValue"
                        type="text"
                        inputMode="decimal"
                        defaultValue={amountInputValue(product.faceValueMinor, product.currency)}
                        className="w-32 rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg"
                      />
                    </div>
                    <button
                      type="submit"
                      className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink hover:bg-accent-strong"
                    >
                      Save pricing
                    </button>
                  </form>

                  <form action={setStatus} className="flex items-end gap-2">
                    <input type="hidden" name="productId" value={product.id} />
                    <div className="flex flex-col gap-1">
                      <label htmlFor={`status-${product.id}`} className="text-xs text-muted">
                        Publish state
                      </label>
                      <select
                        id={`status-${product.id}`}
                        name="status"
                        defaultValue={product.status}
                        className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg"
                      >
                        {EDITABLE_STATUSES.map((value) => (
                          <option key={value} value={value}>
                            {humaniseToken(value)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="submit"
                      className="rounded-md border border-line px-3 py-1.5 text-xs text-muted hover:bg-surface-3 hover:text-fg"
                    >
                      Apply
                    </button>
                  </form>

                  <Link
                    href={`/admin/inventory#product-${product.id}`}
                    className="pb-1.5 text-xs text-muted underline hover:text-fg"
                  >
                    Inventory
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
