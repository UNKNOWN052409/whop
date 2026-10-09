import { listActiveProducts, type PublicProduct } from '@/catalog';
import { Alert } from '@/components/alert';
import { Button } from '@/components/button';
import { CheckoutReadinessNotice } from '@/components/checkout-readiness-notice';
import { checkoutReadiness } from '@/components/checkout-readiness';
import { ProductCard } from '@/components/product-card';

/**
 * Storefront landing page (Server Component).
 *
 * Reads the catalog through `listActiveProducts`, which returns a deliberately
 * narrow public projection — no supplier cost, no inventory rows.
 *
 * Pricing language is fixed by the business rule: the customer PAYS $3 and
 * RECEIVES a code worth $1. The card renders Value and Price as separate rows
 * so the two numbers can never be conflated or inverted.
 *
 * TYPOGRAPHY
 * ----------
 * One display serif (Fraunces) does the large-scale work and the UI sans does
 * everything a shopper reads quickly. The rule that keeps it coherent: the
 * serif never sits below 24px, and the sans never sits above it. A serif used
 * for UI labels looks like a novelty; a serif used only for impact looks
 * deliberate.
 *
 * The hero leads with a stat line rather than a promise. On a page whose whole
 * job is to be trusted with a card number, "verified server-side, emailed in
 * seconds" is worth more than an adjective.
 */
export const dynamic = 'force-dynamic';

interface CatalogResult {
  products: PublicProduct[];
  failed: boolean;
}

async function loadCatalog(): Promise<CatalogResult> {
  try {
    return { products: await listActiveProducts(), failed: false };
  } catch {
    // A catalogue read failure is surfaced, never masked with fake products.
    return { products: [], failed: true };
  }
}

export default async function HomePage() {
  const [{ products, failed }, readiness] = await Promise.all([
    loadCatalog(),
    Promise.resolve(checkoutReadiness()),
  ]);
  const inStock = products.filter((product) => product.availability === 'IN_STOCK');
  const soldOut = products.filter((product) => product.availability !== 'IN_STOCK');

  return (
    <div>
      {/* Hero ------------------------------------------------------------- */}
      <section aria-labelledby="hero-heading" className="relative isolate overflow-hidden">
        {/* Atmosphere only. `aria-hidden` so it is never announced, and it sits
            behind everything via `isolate` + this being the first child. */}
        <div aria-hidden="true" className="aurora" />

        <div className="relative mx-auto w-full max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pb-24 sm:pt-24">
          <p className="eyebrow">Digital codes · delivered by email</p>

          <h1
            id="hero-heading"
            className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.05] text-fg sm:text-6xl"
          >
            Buy a digital code.{' '}
            <span className="text-muted">Get it in your inbox.</span>
          </h1>

          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
            Every product shows two numbers before you pay: the{' '}
            <strong className="font-medium text-fg">Value</strong> of the code you receive, and the{' '}
            <strong className="font-medium text-fg">Price</strong> you pay. A code worth $1.00
            costs $3.00. You always know both.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button href="#catalog" size="lg">
              Browse products
            </Button>
            <Button href="#how-it-works" variant="secondary" size="lg">
              How it works
            </Button>
          </div>

          <CheckoutReadinessNotice readiness={readiness} className="mt-6 max-w-md" />

          {/* Reassurance, stated as mechanism rather than marketing. Each item
              is a specific technical fact this codebase actually enforces. */}
          <dl className="mt-12 grid max-w-2xl gap-x-8 gap-y-5 border-t border-line pt-8 sm:grid-cols-3">
            {[
              { term: 'Verified server-side', detail: 'Never confirmed from the browser' },
              { term: 'Card details off-site', detail: `Entered on ${readiness.providerName}'s checkout` },
              { term: 'Codes by email only', detail: 'Never displayed on this site' },
            ].map((item) => (
              <div key={item.term}>
                <dt className="text-sm font-medium text-fg">{item.term}</dt>
                <dd className="mt-1 text-sm text-subtle">{item.detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* How it works ------------------------------------------------------ */}
      <section
        id="how-it-works"
        aria-labelledby="how-heading"
        className="border-t border-line bg-surface/40"
      >
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <p className="eyebrow">The process</p>
          <h2 id="how-heading" className="mt-3 text-3xl font-semibold text-fg sm:text-4xl">
            Four steps, no surprises
          </h2>

          <ol className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                title: 'Choose a product',
                body: 'Value, price, region and availability are on every card.',
              },
              {
                title: 'Pay securely',
                body: `Card details are entered on ${readiness.providerName}'s hosted checkout, never on this site.`,
              },
              {
                title: 'We verify',
                body: 'The payment is confirmed server-to-server, not from the browser.',
              },
              {
                title: 'Check your email',
                body: 'Your code is sent to the address you entered at checkout.',
              },
            ].map((step, index) => (
              <li key={step.title} className="bg-surface p-6">
                {/* The numeral is set in the display face and de-emphasised. It
                    is a wayfinding mark, not content, so it is aria-hidden and
                    the list position is left to the <ol> semantics. */}
                <span
                  aria-hidden="true"
                  className="font-display text-3xl text-accent"
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
                <p className="mt-4 text-base font-medium text-fg">{step.title}</p>
                <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
              </li>
            ))}
          </ol>

          <p className="mt-6 max-w-2xl text-sm leading-relaxed text-subtle">
            Redeem codes are never displayed on this website. Email is the delivery channel — if a
            code does not arrive, contact us with your order reference and we will resend it.
          </p>
        </div>
      </section>

      {/* Catalog ---------------------------------------------------------- */}
      <section id="catalog" aria-labelledby="catalog-heading" className="scroll-mt-20">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="eyebrow">The catalog</p>
              <h2 id="catalog-heading" className="mt-3 text-3xl font-semibold text-fg sm:text-4xl">
                Products
              </h2>
            </div>
            <p className="text-sm text-muted">
              {inStock.length} available
              {soldOut.length > 0 ? ` · ${soldOut.length} sold out` : ''}
            </p>
          </div>

          {!readiness.canPay ? (
            <div className="mt-8">
              <CheckoutReadinessNotice readiness={readiness} />
            </div>
          ) : null}

          {failed ? (
            <div className="mt-8">
              <Alert variant="error" title="Catalog unavailable">
                The product catalogue could not be loaded. Please try again in a moment.
              </Alert>
            </div>
          ) : null}

          {!failed && products.length === 0 ? (
            <div className="mt-8">
              <Alert variant="info" title="No products listed yet">
                Products appear here as soon as they are published with inventory available.
              </Alert>
            </div>
          ) : null}

          {products.length > 0 ? (
            <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {products.map((product) => (
                <li key={product.id} className="flex">
                  <ProductCard
                    product={product}
                    purchasable={readiness.canPay}
                    unavailableNotice={readiness.blockedReason ?? undefined}
                    className="w-full"
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
    </div>
  );
}