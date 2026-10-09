import Link from 'next/link';

/**
 * Site header. Server-safe: navigation only, no state.
 *
 * The current route is not marked as current because the header is rendered by
 * the ROOT layout, which is a Server Component with no pathname. Adding
 * `aria-current` client-side would require a client boundary in the root
 * layout, which is not worth the bundle for a static nav.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2.5 font-display text-base font-semibold tracking-tight text-fg"
        >
          {/* Mark rather than a plain square: a rounded gradient tile with an
              inner light edge reads as an object, and it is the only place the
              accent appears above the fold outside a CTA. */}
          <span
            aria-hidden="true"
            className="inline-block h-6 w-6 rounded-md shadow-[0_1px_0_rgb(255_255_255/0.25)_inset,0_2px_8px_-2px_rgb(52_211_153/0.45)]"
            style={{
              backgroundImage: 'linear-gradient(135deg, var(--color-accent), var(--color-accent-strong))',
            }}
          />
          Redeem Store
        </Link>

        <nav aria-label="Main">
          <ul className="flex items-center gap-1 text-sm">
            <li>
              <Link
                href="/"
                className="rounded-lg px-3 py-2 text-muted transition-colors duration-200 hover:bg-surface-2 hover:text-fg"
              >
                Shop
              </Link>
            </li>
            <li>
              <Link
                href="/#how-it-works"
                className="rounded-lg px-3 py-2 text-muted transition-colors duration-200 hover:bg-surface-2 hover:text-fg"
              >
                How it works
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}

export default SiteHeader;