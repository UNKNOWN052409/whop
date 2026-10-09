import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProductBySlug } from '@/catalog';
import { isLowStock } from '@/catalog/availability';
import { Alert } from '@/components/alert';
import { AvailabilityBadge } from '@/components/availability-badge';
import { Button } from '@/components/button';
import { CheckoutReadinessNotice } from '@/components/checkout-readiness-notice';
import { checkoutReadiness } from '@/components/checkout-readiness';
import { Money } from '@/components/money';
import { ProductImage } from '@/components/product-image';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug).catch(() => null);
  if (!product) return { title: 'Product not found' };

  // "Price $3.00 · Value $1.00" — the price is what they pay, the value is
  // what the code is worth. Never the other way round.
  return {
    title: product.productName,
    description: `${product.productName}. Price ${product.priceFormatted} · Value ${product.valueFormatted}. Delivered by email after your payment is verified.`,
    openGraph: {
      title: product.productName,
      description: `Price ${product.priceFormatted} · Value ${product.valueFormatted}`,
      images: product.imageUrl ? [product.imageUrl] : undefined,
    },
  };
}

export default async function ProductPage({ params }: PageProps) {
  const { slug } = await params;

  // An unknown slug and a non-ACTIVE slug are both null: a draft must be
  // indistinguishable from a missing product to a customer.
  const product = await getProductBySlug(slug).catch(() => null);
  if (!product) notFound();

  const readiness = checkoutReadiness();
  const inStock = product.availability === 'IN_STOCK';
  const canBuy = inStock && readiness.canPay;
  const premium = product.sellingPriceMinor - product.faceValueMinor;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-8 text-sm text-muted">
        <ol className="flex items-center gap-2">
          <li>
            <Link href="/" className="hover:text-fg hover:underline">
              Shop
            </Link>
          </li>
          <li aria-hidden="true" className="text-subtle">
            /
          </li>
          <li className="truncate text-fg" aria-current="page">
            {product.productName}
          </li>
        </ol>
      </nav>

      <div className="grid gap-10 md:grid-cols-2 md:gap-14">
        <div className="panel overflow-hidden">
          <div className="aspect-[4/3] w-full">
            <ProductImage
              src={product.imageUrl}
              alt={product.productName}
              caption={product.brand}
              loading="eager"
            />
          </div>
        </div>

        <div className="flex flex-col gap-6">
          <div>
            {product.brand ? <p className="eyebrow">{product.brand}</p> : null}
            {/* Display serif at the largest size on the site. This is the one
                page where the product name is the entire argument, so it gets
                the full type scale. */}
            <h1 className="mt-2.5 text-3xl font-semibold leading-tight text-fg sm:text-4xl">
              {product.productName}
            </h1>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <AvailabilityBadge
                availability={product.availability}
                lowStock={isLowStock(product.inventoryCount)}
              />
              <span className="rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-xs text-muted">
                Region: {product.region || 'Worldwide'}
              </span>
              {product.deliveryMethod === 'EMAIL' ? (
                <span className="rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-xs text-muted">
                  Delivery: Email
                </span>
              ) : null}
            </div>
          </div>

          {/* Value vs price — stated explicitly, never left to inference.
              The price leads at display scale because that is the number the
              shopper is about to be charged; the face value of the code is the
              secondary fact. Both stay labelled — this business sells ABOVE
              face value, and an unlabelled pair of numbers invites the reader
              to invert them. */}
          <div className="panel p-6">
            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3">
              <dt className="text-sm text-muted">Customer price</dt>
              <dd className="text-right text-3xl font-semibold text-accent">
                <Money amountMinor={product.sellingPriceMinor} currency={product.currency} />
              </dd>
              <dt className="text-sm text-muted">Value you receive</dt>
              <dd className="text-right text-base font-medium text-fg">
                <Money amountMinor={product.faceValueMinor} currency={product.currency} />
              </dd>
              {premium !== 0 ? (
                <>
                  <dt className="text-sm text-muted">Premium over value</dt>
                  <dd className="text-right text-base font-medium text-fg">
                    <Money amountMinor={premium} currency={product.currency} />
                  </dd>
                </>
              ) : null}
            </dl>

            <p className="mt-5 border-t border-line pt-4 text-sm leading-relaxed text-muted">
              You pay <strong className="font-medium text-fg">{product.priceFormatted}</strong> for
              a single <strong className="font-medium text-fg">worth {product.valueFormatted}</strong>
              . The price is the amount charged to your payment method; the value is what the
              delivered code is worth.
            </p>
          </div>

          {product.description ? (
            <p className="whitespace-pre-line text-sm leading-relaxed text-muted">{product.description}</p>
          ) : null}

          {!inStock ? (
            <Alert variant="warning" title="Sold out">
              This product is currently out of stock. Codes are only sold from inventory that is
              already available, so we will not take an order we cannot fill.
            </Alert>
          ) : null}

          {!readiness.canPay ? <CheckoutReadinessNotice readiness={readiness} /> : null}

          <div className="flex flex-col gap-3">
            {canBuy ? (
              <Button
                href={`/checkout?product=${encodeURIComponent(product.slug)}`}
                size="lg"
                className="w-full"
              >
                Buy now — {product.priceFormatted}
              </Button>
            ) : (
              <Button size="lg" disabled className="w-full">
                {inStock ? 'Checkout unavailable' : 'Sold out'}
              </Button>
            )}
            <p className="text-xs leading-relaxed text-subtle">
              Payment is taken on our provider&apos;s hosted checkout page. Your redeem code is
              emailed to you after the payment is verified — it is never shown on this site.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}