import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert } from '@/components/alert';
import { cn } from '@/components/cn';
import { hasRole, readSession, ROLE_RANK, type AdminSession } from '@/app/admin/_lib/auth';

/**
 * ADMIN SHELL.
 *
 * Two things happen here and they are deliberately different things:
 *
 *  1. THE CHROME — nav, identity, sign-out. Rendered for any signed-in staff
 *     account. It contains no data and reads nothing from the database, so it
 *     is safe to render before a page-level guard has run.
 *
 *  2. THE VISIBILITY NOTICE — when the caller has no session, or has a session
 *     whose role is below SUPPORT, the shell says so plainly instead of
 *     pretending. It does NOT redirect.
 *
 * WHY IT DOES NOT REDIRECT: `/admin/login` lives underneath this layout. A
 * redirect here would bounce the sign-in form to itself, forever. The real
 * boundary is `requirePageSession()`, which every page calls at its top before
 * it touches a single row — see the note there. This layout is a convenience
 * layer over that boundary, never a substitute for it.
 *
 * `readSession()` FAILS CLOSED: when `@/auth/session` is not wired up it throws
 * rather than returning a session. That throw is caught here and rendered as an
 * explicit NOT CONFIGURED notice, because a panel that crashes with a stack
 * trace teaches an operator nothing; one that says "admin authentication is NOT
 * CONFIGURED" tells them exactly what to fix.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · Admin · Redeem Store' },
  // An operator panel must never end up in a search index.
  robots: { index: false, follow: false, nocache: true },
};

const NAV_ITEMS = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/orders', label: 'Orders' },
  { href: '/admin/products', label: 'Products' },
  { href: '/admin/inventory', label: 'Inventory' },
  { href: '/admin/refunds', label: 'Refunds' },
  // Last: it is per-account, not a section of the business, so it belongs after
  // the operational areas rather than among them.
  { href: '/admin/account', label: 'Account' },
] as const;

/**
 * Never throws. Returns `unavailable: true` when the session provider itself is
 * missing, which is a deployment fault rather than an authentication failure —
 * the two deserve different words on screen.
 */
async function loadLayoutSession(): Promise<{
  session: AdminSession | null;
  unavailable: boolean;
}> {
  try {
    return { session: await readSession(), unavailable: false };
  } catch {
    return { session: null, unavailable: true };
  }
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { session, unavailable } = await loadLayoutSession();

  const signedIn = session !== null;
  const authorised = session !== null && hasRole(session, 'SUPPORT');
  const tooLow =
    session !== null && !authorised;

  const roleRank = session ? (ROLE_RANK[session.role] ?? 0) : -1;

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
          <Link href="/admin" className="text-sm font-semibold tracking-tight text-fg">
            Redeem Store <span className="text-muted">/ Admin</span>
          </Link>

          {authorised ? (
            <nav aria-label="Admin sections" className="flex flex-wrap items-center gap-1">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg',
                    item.href === '/admin' ? 'font-medium text-fg' : null,
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          ) : null}

          <div className="ml-auto flex items-center gap-3">
            {session ? (
              <>
                <span className="text-xs text-muted">
                  {session.email}
                  <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 ring-1 ring-line">
                    {session.role}
                  </span>
                </span>
                {/*
                  Sign-out is a POST to the auth route, not a link: a GET that
                  mutates session state is a CSRF-able logout and, worse, a
                  logout a prefetching crawler can trigger.
                */}
                <form method="post" action="/api/auth/logout">
                  <button
                    type="submit"
                    className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                  >
                    Sign out
                  </button>
                </form>
              </>
            ) : (
              <Link
                href="/admin/login"
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {unavailable ? (
          <div className="mb-6">
            <Alert variant="error" title="Admin authentication is NOT CONFIGURED">
              <p>
                The session provider (<code>@/auth/session</code>) is not available, so this panel
                cannot identify an operator. Every admin page below will refuse to render. This is
                deliberate — an admin panel that cannot prove who is asking answers nobody&apos;s
                questions.
              </p>
            </Alert>
          </div>
        ) : null}

        {!signedIn && !unavailable ? (
          <div className="mb-6">
            <Alert variant="info" title="You are not signed in">
              <p>
                <Link href="/admin/login" className="underline">
                  Sign in
                </Link>{' '}
                with a staff account to use the admin panel.
              </p>
            </Alert>
          </div>
        ) : null}

        {tooLow ? (
          <div className="mb-6">
            <Alert variant="error" title={`Your role (${session.role}) cannot access this panel`}>
              <p>
                The admin panel requires SUPPORT or above. Your account is ranked{' '}
                {roleRank} and SUPPORT requires {ROLE_RANK.SUPPORT}. Pages under{' '}
                <code>/admin</code> will refuse to render and no order, payment, product or
                inventory data is loaded for this session.
              </p>
            </Alert>
          </div>
        ) : null}

        {children}
      </main>
    </div>
  );
}
