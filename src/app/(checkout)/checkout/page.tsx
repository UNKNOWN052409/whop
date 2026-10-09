import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getProductById, getProductBySlug } from '@/catalog';
import { checkoutReadiness } from '@/components/checkout-readiness';
import { CheckoutForm } from './CheckoutForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Checkout',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ product?: string | string[]; productId?: string | string[] }>;
}

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Checkout page (Server Component).
 *
 * Resolves the product from `?product=<slug>` or `?productId=<id>` using the
 * public catalog projection only, then hands the client form everything it is
 * allowed to know: display values, the enabled-and-supported payment methods,
 * and the honest checkout-readiness verdict.
 *
 * The price is re-derived server-side by the POST handler; the numbers here are
 * for display only and are never trusted by the client.
 */
export default async function CheckoutPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const slug = first(params.product)?.trim();
  const productId = first(params.productId)?.trim();

  if (!slug && !productId) redirect('/');

  const product =
    slug !== undefined
      ? await getProductBySlug(slug).catch(() => null)
      : productId !== undefined
        ? await getProductById(productId).catch(() => null)
        : null;

  if (!product) notFound();

  const readiness = checkoutReadiness();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-6 text-sm text-muted">
        <ol className="flex items-center gap-2">
          <li>
            <Link href="/" className="hover:text-fg hover:underline">
              Shop
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link
              href={`/product/${encodeURIComponent(product.slug)}`}
              className="hover:text-fg hover:underline"
            >
              {product.productName}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li className="text-fg" aria-current="page">
            Checkout
          </li>
        </ol>
      </nav>

      <h1 className="text-2xl font-bold tracking-tight text-fg">Checkout</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        You pay the price shown below and receive a redeem code worth the product&apos;s value,
        emailed to you once your payment is verified.
      </p>

      <div className="mt-8">
        <CheckoutForm
          product={{
            id: product.id,
            slug: product.slug,
            name: product.productName,
            currency: product.currency,
            unitPriceMinor: product.sellingPriceMinor,
            faceValueMinor: product.faceValueMinor,
            deliveryMethod: product.deliveryMethod,
            region: product.region,
            inStock: product.availability === 'IN_STOCK',
          }}
          methods={readiness.methods}
          providerName={readiness.providerName}
          providerStatus={readiness.providerStatus}
          emailStatus={readiness.emailStatus}
          canPay={readiness.canPay}
          blockedReason={readiness.blockedReason}
        />
      </div>
    </div>
  );
}