import type { Metadata } from 'next';
import { Alert } from '@/components/alert';
import { Input } from '@/components/input';

/**
 * ADMIN SIGN-IN.
 *
 * A plain HTML form that POSTs to `/api/auth/login` — that route is owned by the
 * auth workstream, so this page deliberately contains no password handling, no
 * session creation and no credential comparison of its own. A page that
 * "temporarily" checks a password locally is a page that eventually ships a
 * password comparison to the client bundle.
 *
 * WHAT THE FORM SENDS
 *   email     — the operator's address
 *   password  — never read, never logged, never rendered back
 *   next      — where to send the operator after a successful sign-in, so a
 *               deep link like /admin/orders/ORD-7QK2M4XB survives the detour
 *               through this screen
 *
 * WHAT IT EXPECTS BACK
 *   The route is expected to set the session cookie and redirect to `next`.
 *   If it instead returns an error, this page renders it from the `error`
 *   query parameter (a redirect back to /admin/login?error=…). The password
 *   field is always rendered empty on a re-render: a failed attempt must not
 * * echo the submitted secret back into the DOM.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/**
 * Only a same-origin path is ever reflected into the form. An attacker-supplied
 * absolute URL here would turn this page into an open redirect that starts on
 * our own domain.
 */
function safeNext(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith('/')) return '/admin';
  if (value.startsWith('//')) return '/admin';
  return value;
}

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = firstValue(params.error).trim();
  const notice = firstValue(params.notice).trim();
  const next = safeNext(firstValue(params.next));

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-semibold text-fg">Sign in to the admin panel</h1>
      <p className="mt-2 text-sm text-muted">
        Staff accounts only. The panel requires the SUPPORT role or above; money-changing actions
        require ADMIN.
      </p>

      {error ? (
        <div className="mt-6">
          <Alert variant="error" title="Sign-in failed">
            <p>{error}</p>
          </Alert>
        </div>
      ) : null}

      {notice ? (
        <div className="mt-6">
          <Alert variant="info" title="Signed out">
            <p>{notice}</p>
          </Alert>
        </div>
      ) : null}

      <form
        method="post"
        action="/api/auth/login"
        className="mt-6 space-y-4 rounded-lg border border-line bg-surface-2 p-6"
      >
        <input type="hidden" name="next" value={next} />

        <Input
          id="admin-email"
          name="email"
          label="Email"
          type="email"
          autoComplete="username"
          required
          autoFocus
        />

        {/*
          Rendered by hand rather than with `<Input>`: that component's `type`
          union deliberately excludes `password`, and widening it is not this
          page's business. The classes match the shared control exactly so the
          form still looks like the rest of the product.
        */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="admin-password" className="text-sm font-medium text-fg">
            Password
          </label>
          <input
            id="admin-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-subtle hover:border-line-strong"
          />
        </div>

        <button
          type="submit"
          className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
        >
          Sign in
        </button>

        <p className="text-xs text-subtle">
          Sessions are cookie-based and server-verified on every admin request. Signing out revokes
          the session server-side; it is not a client-side flag.
        </p>
      </form>
    </div>
  );
}
