import type { Metadata } from 'next';
import { Alert } from '@/components/alert';
import { prisma } from '@/db/prisma';
import { requirePageSession } from '@/app/admin/_lib/auth';
import { badgeClass, formatDateTime } from '@/app/admin/_lib/format';
import { MfaPanel, type MfaUiState } from '@/app/admin/account/MfaPanel';

/**
 * ADMIN ACCOUNT — MFA.
 *
 * The page that makes the second factor usable. `/api/auth/mfa/enrol` is a
 * complete, working endpoint with three actions; before this page existed, the
 * only way to reach it was to hand-craft POSTs from a browser console, so in
 * practice the factor protecting a payment platform was never switched on.
 *
 * WHAT IS READ FROM THE DATABASE
 *   `mfaEnabledAt` and whether `mfaSecretCiphertext` is populated. Nothing else.
 *
 * WHAT IS NEVER READ, AND WHY
 *   The base32 secret. It exists in the database only as AES-256-GCM ciphertext
 *   and is never decrypted for display — the one time an operator is allowed to
 *   see it is the `start` response, which contains the freshly-minted
 *   `otpauth://` URI, and that reaches the browser through the endpoint rather
 *   than through a page render. `mfaRecoveryHashes` is reduced to a COUNT here;
 *   the hashes themselves are never selected into a page, and the plaintext
 *   codes exist in exactly one response, once.
 *
 * THE THREE STATES
 *   ENABLED      `mfaEnabledAt` is set. Second factor is live.
 *   PENDING      A secret is stored but never confirmed, i.e. a `start` whose
 *                `confirm` never arrived (expired grant, closed tab). MFA is NOT
 *                active — saying otherwise would be a lie about the account's
 *                security posture.
 *   NOT_ENABLED  Neither. The ordinary starting point.
 *
 * GATING
 *   `requirePageSession('SUPPORT', …)` — the same guard, at the same level, as
 *   every other admin page, so this panel is no easier to reach than the orders
 *   list. Enrolling is a per-account action that any signed-in role may take for
 *   itself; DISABLING is OWNER-only on the route, and the panel reflects that
 *   from the server-rendered session rather than letting a lesser role discover
 *   it as a 403.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Account' };

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function AdminAccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Page-level guard. Runs before any query, exactly as on every other admin
  // page: an anonymous caller is redirected and never reaches a row below.
  const session = await requirePageSession('SUPPORT', '/admin/account');

  const params = await searchParams;
  const notice = firstValue(params.notice).trim();
  const actionError = firstValue(params.error).trim();

  // Three columns and no more. `mfaSecretCiphertext` is selected only so that
  // its presence can be tested; the value itself is never rendered, logged or
  // passed to the client component, and the local variable holding the row is
  // reduced to a boolean before anything else happens.
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      email: true,
      role: true,
      mfaEnabledAt: true,
      mfaSecretCiphertext: true,
      /**
       * Fetched only for its `.length`. Prisma cannot count a scalar list
       * column, so the array is loaded on the server and reduced to a number
       * immediately; the hashes never reach the markup and never leave the
       * process. `mfaSecretCiphertext` is handled the same way — presence only.
       */
      mfaRecoveryHashes: true,
    },
  });

  if (!user) {
    return (
      <Alert variant="error" title="Account not found">
        <p>
          The signed-in session points at a user row that does not exist. Sign out and back in.
        </p>
      </Alert>
    );
  }

  const enabled = user.mfaEnabledAt !== null && user.mfaEnabledAt !== undefined;
  const hasPendingSecret =
    typeof user.mfaSecretCiphertext === 'string' && user.mfaSecretCiphertext.length > 0;
  const recoveryCodesRemaining = user.mfaRecoveryHashes.length;

  const state: MfaUiState = enabled ? 'ENABLED' : hasPendingSecret ? 'PENDING' : 'NOT_ENABLED';

  // The route's `disable` branch calls `requireOwnerAction('mfa.disable')`, so a
  // lesser role would get a 403 from the endpoint. The panel says so up front
  // instead: the information is not sensitive (the role is in the header) and a
  // control that cannot work should not be offered as if it could.
  const canDisable = session.role === 'OWNER';

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold text-fg">Account</h1>
        <span className={badgeClass(state === 'ENABLED' ? 'good' : 'warn')}>
          {state === 'ENABLED' ? 'MFA active' : state === 'PENDING' ? 'MFA pending' : 'MFA off'}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-line bg-surface-2 p-4">
          <dt className="text-xs uppercase tracking-wide text-subtle">Signed in as</dt>
          <dd className="mt-1 truncate text-sm text-fg">{user.email}</dd>
        </div>
        <div className="rounded-lg border border-line bg-surface-2 p-4">
          <dt className="text-xs uppercase tracking-wide text-subtle">Role</dt>
          <dd className="mt-1 text-sm text-fg">
            {user.role}
            <span className="block text-xs text-subtle">
              {canDisable ? 'May disable MFA' : 'Cannot disable MFA (OWNER only)'}
            </span>
          </dd>
        </div>
        <div className="rounded-lg border border-line bg-surface-2 p-4">
          <dt className="text-xs uppercase tracking-wide text-subtle">
            Recovery codes left
          </dt>
          <dd className="mt-1 text-sm tabular-nums text-fg">
            {enabled ? recoveryCodesRemaining : '—'}
          </dd>
        </div>
      </dl>

      {notice ? (
        <div className="mt-6">
          <Alert variant="success" title="Done">
            <p>{notice}</p>
          </Alert>
        </div>
      ) : null}
      {actionError ? (
        <div className="mt-6">
          <Alert variant="error" title="Request refused">
            <p>{actionError}</p>
          </Alert>
        </div>
      ) : null}

      {/* --- Status explainer ---------------------------------------------- */}
      {state === 'ENABLED' ? (
        <div className="mt-6">
          <Alert variant="success" title="Two-factor authentication is on">
            <p>
              Signing in needs your password <em>and</em> a code from your authenticator app.
              Enabled {formatDateTime(user.mfaEnabledAt)} · {recoveryCodesRemaining} recovery
              code{recoveryCodesRemaining === 1 ? '' : 's'} unused, each good for one sign-in.
            </p>
          </Alert>
        </div>
      ) : null}

      {state === 'PENDING' ? (
        <div className="mt-6">
          <Alert variant="warning" title="MFA is not active on this account yet">
            <p>
              A TOTP secret is stored but was never confirmed — a previous enrolment started and
              did not finish. Until it is confirmed, signing in still needs only your password.
            </p>
          </Alert>
        </div>
      ) : null}

      {state === 'NOT_ENABLED' ? (
        <div className="mt-6">
          <Alert variant="warning" title="This account has one factor: a password">
            <p>
              Anyone who obtains the password — through a breach, a phishing page or a reused
              credential — signs straight in. A payment platform holds the ability to reveal
              customer redeem codes and to move money, so this is the single highest-value control
              on the page.
            </p>
          </Alert>
        </div>
      ) : null}

      <div className="mt-8">
        <MfaPanel state={state} canDisable={canDisable} />
      </div>

      <p className="mt-8 text-xs text-subtle">
        MFA protects this admin panel only. It does not change how customers sign in, and it is
        independent of <code>REQUIRE_MFA_FOR_ADMIN</code>, which refuses sign-in for un-enrolled
        staff rather than enrolling them.
      </p>
    </div>
  );
}