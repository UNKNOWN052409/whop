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
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      {/* Hero ------------------------------------------------------------- */}
      <section aria-labelledby="hero-heading" className="border-b border-line pb-10">
        <p className="text-xs font-medium uppercase tracking-widest text-accent">
          Digital codes · delivered by email
        </p>
        <h1 id="hero-heading" className="mt-3 max-w-3xl text-3xl font-bold tracking-tight text-fg sm:text-4xl">
          Buy a digital redeem code, get it in your inbox.
        </h1>
        <p className="mt-4 max-w-2xl text-base text-muted">
          Each product shows two numbers clearly: the <strong className="text-fg">Value</strong> of the
          code you receive, and the <strong className="text-fg">Price</strong> you pay. For example, a
          code worth $1.00 costs $3.00. You always know both before you pay.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button href="#catalog" size="md">
            Browse products
          </Button>
          <CheckoutReadinessNotice readiness={readiness} className="max-w-md" />
        </div>
      </section>

      {/* How it works ------------------------------------------------------ */}
      <section id="how-it-works" aria-labelledby="how-heading" className="border-b border-line py-10">
        <h2 id="how-heading" className="text-xl font-semibold text-fg">
          How it works
        </h2>
        <ol className="mt-4 grid gap-4 sm:grid-cols-4">
          {[
            { title: 'Choose a product', body: 'Value, price, region and availability are on every card.' },
            { title: 'Pay securely', body: `Card details are entered on ${readiness.providerName}'s hosted checkout, never on this site.` },
            { title: 'We verify', body: 'The payment is confirmed server-to-server, not from the browser.' },
            { title: 'Check your email', body: 'Your code is sent to the address you entered at checkout.' },
          ].map((step, index) => (
            <li key={step.title} className="rounded-lg border border-line bg-surface p-4">
              <p className="text-xs font-semibold text-accent">Step {index + 1}</p>
              <p className="mt-1 text-sm font-semibold text-fg">{step.title}</p>
              <p className="mt-1 text-sm text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-subtle">
          Redeem codes are never displayed in this website. Email is the delivery channel — if it does
          not arrive, contact us with your order reference and we will resend it.
        </p>
      </section>

      {/* Catalog ---------------------------------------------------------- */}
      <section id="catalog" aria-labelledby="catalog-heading" className="py-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="catalog-heading" className="text-xl font-semibold text-fg">
            Products
          </h2>
          <p className="text-sm text-muted">
            {inStock.length} available
            {soldOut.length > 0 ? ` · ${soldOut.length} sold out` : ''}
          </p>
        </div>

        {!readiness.canPay ? (
          <div className="mt-4">
            <CheckoutReadinessNotice readiness={readiness} />
          </div>
        ) : null}

        {failed ? (
          <div className="mt-6">
            <Alert variant="error" title="Catalog unavailable">
              The product catalogue could not be loaded. Please try again in a moment.
            </Alert>
          </div>
        ) : null}

        {!failed && products.length === 0 ? (
          <div className="mt-6">
            <Alert variant="info" title="No products listed yet">
              Products appear here as soon as they are published with inventory available.
            </Alert>
          </div>
        ) : null}

        {products.length > 0 ? (
          <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
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
      </section>
    </div>
  );
}