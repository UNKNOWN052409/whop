import type { PublicProduct } from '@/catalog';
import { isLowStock } from '@/catalog/availability';
import { formatMoney } from '@/lib/money';
import Link from 'next/link';
import { AvailabilityBadge } from './availability-badge';
import { Button } from './button';
import { Money } from './money';
import { ProductImage } from './product-image';
import { cn } from './cn';

export interface ProductCardProps {
  product: PublicProduct;
  /** False when the provider is unconfigured or the product is sold out. */
  purchasable?: boolean;
  /** Shown instead of the price row when the provider is NOT CONFIGURED. */
  unavailableNotice?: string;
  className?: string;
  /** Heading level, so a card can sit under the right section heading. */
  headingLevel?: 2 | 3;
}

/**
 * Storefront product card.
 *
 * Pricing reads "Price $3.00 · Value $1.00" — the customer pays MORE than the
 * code is worth. This is a markup business and the card must never invert it
 * into "a $3 code for $1". Value is the code's face value, price is the charge.
 *
 * Server-safe: plain markup and next/link. The artwork is a small client island
 * (`product-image.tsx`) so a 404 image can fall back to its placeholder; the
 * card itself holds no client state.
 */
export function ProductCard({
  product,
  purchasable = true,
  unavailableNotice,
  className,
  headingLevel = 3,
}: ProductCardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const inStock = product.availability === 'IN_STOCK';
  const canBuy = purchasable && inStock;
  const checkoutHref = `/checkout?product=${encodeURIComponent(product.slug)}`;

  return (
    <article
      className={cn(
        'group flex flex-col overflow-hidden rounded-xl border border-line bg-surface',
        'transition-colors hover:border-line-strong',
        className,
      )}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-surface-2">
        <ProductImage src={product.imageUrl} alt={product.productName} caption={product.brand} />
        <div className="absolute left-3 top-3">
          <AvailabilityBadge
            availability={product.availability}
            lowStock={isLowStock(product.inventoryCount)}
          />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          {product.brand ? (
            <p className="truncate text-xs uppercase tracking-wide text-subtle">{product.brand}</p>
          ) : null}
          <Heading className="mt-0.5 truncate text-base font-semibold text-fg">
            <Link href={`/product/${encodeURIComponent(product.slug)}`} className="hover:underline">
              {product.productName}
            </Link>
          </Heading>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted">Value</dt>
          <dd className="text-right font-medium text-fg">
            <Money amountMinor={product.faceValueMinor} currency={product.currency} />
          </dd>
          <dt className="text-muted">Price</dt>
          <dd className="text-right font-semibold text-accent">
            <Money amountMinor={product.sellingPriceMinor} currency={product.currency} />
          </dd>
          <dt className="text-muted">Delivery</dt>
          <dd className="text-right text-fg">{product.deliveryMethod === 'EMAIL' ? 'Email' : product.deliveryMethod}</dd>
        </dl>

        <p className="text-xs text-subtle">
          You pay {formatMoney(product.sellingPriceMinor, product.currency)} and receive a code worth{' '}
          {formatMoney(product.faceValueMinor, product.currency)}.
        </p>

        <div className="mt-auto pt-1">
          {canBuy ? (
            <Button href={checkoutHref} size="md" className="w-full">
              BUY NOW
            </Button>
          ) : (
            <Button
              size="md"
              disabled
              className="w-full"
              aria-label={
                inStock
                  ? `Checkout unavailable for ${product.productName}`
                  : `${product.productName} is sold out`
              }
            >
              {inStock ? 'CHECKOUT UNAVAILABLE' : 'SOLD OUT'}
            </Button>
          )}
          {!canBuy && unavailableNotice ? (
            <p className="mt-2 text-xs text-muted">{unavailableNotice}</p>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export default ProductCard;