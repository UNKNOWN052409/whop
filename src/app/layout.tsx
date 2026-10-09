import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';

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
    <html lang="en">
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