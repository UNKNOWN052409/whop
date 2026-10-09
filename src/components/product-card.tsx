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
        'group panel flex flex-col overflow-hidden',
        // Lift and reveal, but only for a card that can actually be acted on. A
        // sold-out card that rises on hover implies it is buyable, which is a
        // small lie told through motion.
        canBuy &&
          'transition-[transform,border-color,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ' +
            'hover:-translate-y-0.5 hover:border-line-strong ' +
            'hover:shadow-[0_12px_32px_-12px_rgb(0_0_0/0.6)]',
        className,
      )}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-surface-2">
        <ProductImage src={product.imageUrl} alt={product.productName} caption={product.brand} />
        <div className="absolute left-4 top-4">
          <AvailabilityBadge
            availability={product.availability}
            lowStock={isLowStock(product.inventoryCount)}
          />
        </div>
      </div>

      <div className="flex flex-1 flex-col p-5">
        <div className="min-w-0">
          {product.brand ? <p className="eyebrow">{product.brand}</p> : null}
          <Heading className="mt-2 text-lg font-medium leading-snug text-fg">
            <Link
              href={`/product/${encodeURIComponent(product.slug)}`}
              // The underline is what tells you the title is the link. A colour
              // change alone is invisible to anyone who cannot distinguish the
              // two colours.
              className="decoration-line-strong decoration-1 underline-offset-4 hover:underline"
            >
              {product.productName}
            </Link>
          </Heading>
        </div>

        {/* PRICE IS THE HEADLINE, NOT A TABLE ROW.
            A shopper's eye goes to the largest number on a card, and that number
            is the one they pay. So the price leads, in the accent, at display
            scale; the face value of the code sits beneath it as the secondary
            fact. Both stay labelled — this business sells ABOVE face value, and
            an unlabelled pair of numbers invites the reader to invert them. */}
        <div className="mt-5 border-t border-line pt-5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-muted">Price</span>
            <span className="text-2xl font-semibold text-accent">
              <Money amountMinor={product.sellingPriceMinor} currency={product.currency} />
            </span>
          </div>
          <div className="mt-1.5 flex items-baseline justify-between gap-3">
            <span className="text-sm text-muted">Value</span>
            <span className="text-sm text-fg">
              <Money amountMinor={product.faceValueMinor} currency={product.currency} />
            </span>
          </div>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-subtle">
          You pay {formatMoney(product.sellingPriceMinor, product.currency)} and receive a code
          worth {formatMoney(product.faceValueMinor, product.currency)}.
          {product.deliveryMethod === 'EMAIL' ? ' Delivered by email.' : null}
        </p>

        <div className="mt-auto pt-5">
          {canBuy ? (
            <Button href={checkoutHref} size="md" className="w-full">
              Buy now
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
              {inStock ? 'Checkout unavailable' : 'Sold out'}
            </Button>
          )}
          {!canBuy && unavailableNotice ? (
            <p className="mt-3 text-xs text-muted">{unavailableNotice}</p>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export default ProductCard;