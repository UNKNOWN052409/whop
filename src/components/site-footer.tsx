import Link from 'next/link';

/** Site footer. Server-safe, static content only. */
export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line bg-surface/50">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 text-sm sm:grid-cols-3 sm:px-6">
        <div>
          <p className="font-display text-base font-semibold text-fg">Redeem Store</p>
          <p className="mt-2.5 leading-relaxed text-muted">
            Digital redeem codes and gift cards, delivered automatically to your email after your
            payment is verified.
          </p>
        </div>

        <div>
          <p className="eyebrow">Orders</p>
          <ul className="mt-3 space-y-2 text-muted">
            <li>
              <Link href="/" className="transition-colors hover:text-fg">
                All products
              </Link>
            </li>
            <li>
              <Link href="/checkout" className="transition-colors hover:text-fg">
                Checkout
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <p className="eyebrow">Security</p>
          <ul className="mt-3 space-y-2 leading-relaxed text-muted">
            <li>Redeem codes are never shown in the browser — email is the delivery channel.</li>
            <li>Card details are handled by our payment provider&apos;s hosted checkout.</li>
            <li>Every payment is verified server-to-server before any code is sent.</li>
          </ul>
        </div>
      </div>

      <div className="border-t border-line">
        <div className="mx-auto max-w-6xl px-4 py-6 text-xs leading-relaxed text-subtle sm:px-6">
          <p>
            All prices are shown in the product&apos;s own currency and include the face value of the
            code you receive. Codes are issued only from inventory supplied by authorised
            resellers.
          </p>
        </div>
      </div>
    </footer>
  );
}

export default SiteFooter;