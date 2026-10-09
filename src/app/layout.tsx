import type { Metadata, Viewport } from 'next';
import { Fraunces, Inter } from 'next/font/google';
import './globals.css';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';

/**
 * TYPOGRAPHY
 *
 * `next/font` downloads these at BUILD time and serves the woff2 files from
 * our own origin as hashed static assets. That is what lets the strict CSP in
 * `next.config.ts` keep `font-src 'self'` — a `<link>` to fonts.googleapis.com
 * at runtime would require opening that directive to a third-party origin and
 * would leak every visitor's IP to Google on first paint. Self-hosting also
 * means no render-blocking round trip and no layout shift, because the metrics
 * are known before first paint.
 *
 * Fraunces is a display serif with optical sizing, used only for headings and
 * the hero. Inter carries all UI and body text. The split is the whole point:
 * one expressive face doing the typographic work and one neutral face doing
 * everything a shopper has to actually read quickly.
 *
 * `display: 'swap'` keeps text readable while the font loads. Because the
 * fallback is the same system stack already in `--font-sans`, the swap is a
 * small reflow rather than a flash of invisible text.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

/**
 * Only the optical size axis and the weight range actually used are requested.
 * A full variable font is a larger download, and these two axes cover every
 * heading on the site.
 */
const fraunces = Fraunces({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-fraunces',
  axes: ['opsz', 'SOFT', 'WONK'],
});

/**
 * ROOT layout.
 *
 * The single owner of <html>/<body> for every route, including /admin. Route
 * groups ((storefront), (checkout)) never define their own html/body — they
 * contribute pages only.
 */
export const metadata: Metadata = {
  title: {
    default: 'Redeem Store — digital codes delivered by email',
    template: '%s · Redeem Store',
  },
  description:
    'Buy digital redeem codes and gift cards. You pay the listed price and receive a code worth its face value, delivered to your email once your payment is verified.',
  applicationName: 'Redeem Store',
  robots: { index: true, follow: true },
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  themeColor: '#07080b',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The font variables are attached to <html> so every token that references
    // --font-display / --font-sans resolves, including anything rendered into a
    // portal or a scroll-driven effect outside <body>.
    <html lang="en" className={`${inter.variable} ${fraunces.variable}`}>
      <body className="min-h-dvh bg-bg text-fg antialiased">
        <a
          href="#main"
          className="sr-only-focusable absolute left-4 top-4 z-50 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-ink"
        >
          Skip to main content
        </a>
        <div className="flex min-h-dvh flex-col">
          <SiteHeader />
          <main id="main" className="flex-1">
            {children}
          </main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}