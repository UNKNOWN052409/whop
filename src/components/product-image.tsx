'use client';

import { CreditCard } from 'lucide-react';
import { useState } from 'react';
import { cn } from './cn';

export interface ProductImageProps {
  /** Absolute or site-relative URL from `Product.imageUrl`. Null/blank renders the placeholder. */
  src?: string | null;
  /**
   * The accessible name in BOTH states. The placeholder is `role="img"` with
   * this label, so a screen reader announces the same thing whether the
   * artwork loaded or not — an `aria-hidden` empty box would announce nothing.
   */
  alt: string;
  /** Short secondary line for the placeholder, normally the brand. */
  caption?: string | null;
  className?: string;
  loading?: 'lazy' | 'eager';
}

/**
 * Product artwork with one deliberate empty state.
 *
 * A product's `imageUrl` is optional and, on this catalog, is a SITE-RELATIVE
 * path into `public/products` (see `prisma/seed.ts`). Three things can go
 * wrong with it and all three must render as a designed state rather than a
 * browser artefact:
 *
 *   1. Null or blank — a product with no artwork, or one whose row was written
 *      before imagery existed.
 *   2. Set but 404 — a stale path, or an operator-supplied URL that has since
 *      moved. This can only be detected in the browser, so this is the one
 *      place in the storefront that needs client state.
 *   3. Set and loading — the normal case.
 *
 * Cases 1 and 2 collapse to the same placeholder, so a broken path and a
 * missing one are indistinguishable to a customer — which is the intent: the
 * card still reads as a product, and the name, price and value below it are
 * always legible regardless of whether any image exists.
 *
 * WHY A CLIENT ISLAND: an `onError` handler cannot be attached from a Server
 * Component, and every caller here is one. The island is deliberately tiny —
 * one `useState` and a single `CreditCard` glyph — and everything above it
 * stays server-rendered.
 *
 * WHY NOT next/image: product imagery is customer-supplied, and adding an
 * untrusted origin to next/image's remote allow-list is a config change the UI
 * layer must not make on its own. `<img>` also keeps static assets in `public/`
 * renderable without `dangerouslyAllowSVG` and without the optimizer's format
 * negotiation, which matters because a 404 through the optimizer degrades
 * worse than a 404 on a plain `<img>`.
 */
export function ProductImage({
  src,
  alt,
  caption,
  className,
  loading = 'lazy',
}: ProductImageProps) {
  // The failed URL is remembered rather than a boolean, so a client-side
  // navigation to a DIFFERENT product with a working image resets the state
  // without an effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const url = typeof src === 'string' && src.trim() !== '' ? src.trim() : null;
  const label = caption && caption.trim() !== '' ? caption : alt;

  if (url === null || failedSrc === url) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-2 bg-surface-2 px-4 text-center',
          className,
        )}
      >
        <CreditCard aria-hidden="true" className="h-6 w-6 shrink-0 text-subtle" strokeWidth={1.5} />
        <span className="line-clamp-2 text-sm font-medium text-muted">{label}</span>
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      loading={loading}
      decoding="async"
      onError={() => setFailedSrc(url)}
      className={cn('h-full w-full object-cover', className)}
    />
  );
}

export default ProductImage;
