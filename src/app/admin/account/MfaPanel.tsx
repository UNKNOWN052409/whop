'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { Alert } from '@/components/alert';
import {
  MfaEnrolError,
  formatSecretForTyping,
  postEnrolment,
  readEnrolUri,
  type EnrolUriParts,
} from '@/app/admin/account/mfa-api';

/**
 * MFA ENROLMENT CONTROL.
 *
 * This is the entire UI for `/api/auth/mfa/enrol`, and it is deliberately thin:
 * the server owns the secret, the state machine and the rate limits, and this
 * component owns only the steps a person has to take.
 *
 *   1. Prove the password   -> `start`   -> an `otpauth://` URI (secret inside)
 *   2. Put that secret in an authenticator app (typed setup key, no QR dep)
 *   3. Prove the app has it -> `confirm` -> MFA ON, recovery codes ONCE
 *   4. Later, if needed    -> `disable` -> MFA OFF, EVERY session revoked
 *
 * WHY STEP 1 IS NOT STEP 3
 *   `start` deliberately does not enable anything. It stores the secret
 *   encrypted and leaves `mfaEnabledAt` null, so an attacker holding a stolen
 *   session cookie cannot enrol their own authenticator and lock the owner out.
 *   The copy below says so on screen, because an operator who assumes `start`
 *   was enough will believe they are protected when they are not.
 *
 * WHAT THIS COMPONENT NEVER DOES
 *   - generate a TOTP, or "help" the operator by producing one client-side
 *   - fall back to a local success when the route refuses
 *   - put the secret, a code or a password into a URL, into storage, or into a log
 *   - keep the recovery codes after the operator dismisses them
 *
 * The only value that outlives a request is the recovery-code list, and only
 * because it is the sole delivery of a credential the server will never repeat.
 */

export type MfaUiState = 'NOT_ENABLED' | 'PENDING' | 'ENABLED';

export interface MfaPanelProps {
  /** Read from the database on the server; see the page for the exact columns. */
  state: MfaUiState;
  /** Disabling is OWNER-only on the route; a lesser role is told, not 403'd. */
  canDisable: boolean;
}

type Step = 'IDLE' | 'AWAITING_CODE' | 'RECOVERY_CODES' | 'DISABLED';

interface Failure {
  message: string;
  code: string;
  /** Extra guidance the route's message cannot carry on its own. */
  hint: string | null;
}

/**
 * Turns a typed route failure into something actionable.
 *
 * The route's own message is always kept: `jsonError` only forwards an
 * `AppError`'s text, and every distinct message the route emits is written to be
 * shown to a human. What is added here is the NEXT STEP, because "MFA is not
 * enabled" on its own does not tell an operator that they are looking at a stale
 * page rather than at a live state.
 */
function describeFailure(error: MfaEnrolError, atStep: Step): Failure {
  const base: Failure = { message: error.message, code: error.code, hint: null };

  if (error.notConfigured) {
    return {
      ...base,
      hint: 'SESSION_SECRET is missing or shorter than 32 characters, so no session can be signed at all. Set it and restart; this page will not pretend MFA is on until it is.',
    };
  }

  // The confirm branch's "Start enrolment again before confirming": the grant is
  // short-lived and single-purpose, so this is routine, not an attack.
  if (error.needsFreshEnrolment) {
    return { ...base, hint: 'The enrolment grant expired or was never issued. Start enrolment again to get a fresh one.' };
  }

  switch (error.code) {
    case 'DUPLICATE_REQUEST':
      return { ...base, hint: 'MFA is already on for this account. Reload this page to see its current state.' };
    case 'INVALID_STATE_TRANSITION':
      return { ...base, hint: 'Reload this page — the panel is showing a state the server no longer agrees with.' };
    case 'UNAUTHORIZED':
      return {
        ...base,
        hint:
          atStep === 'DISABLED'
            ? 'A signed-out session looks exactly like this too. Sign in again if you were not the one who just disabled MFA.'
            : 'That is usually the wrong password. If you changed it in another browser, use the new one.',
      };
    case 'FORBIDDEN':
      return { ...base, hint: 'The server could not prove this request came from this page. Reload and try again.' };
    case 'RATE_LIMITED':
      return {
        ...base,
        hint: error.retryAfterSeconds
          ? `Wait about ${Math.ceil(error.retryAfterSeconds / 60)} minute(s) before retrying — password re-checks are limited per account.`
          : 'Wait before retrying.',
      };
    case 'VALIDATION_FAILED':
      return {
        ...base,
        hint:
          atStep === 'AWAITING_CODE'
            ? 'Codes are six digits and change every 30 seconds. Enter the one showing now.'
            : null,
      };
    default:
      return base;
  }
}

function PasswordField({
  id,
  label,
  hint,
  value,
  disabled,
  onChange,
  onSubmit,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {/*
        Hand-rolled rather than `<Input>`: that component's `type` union excludes
        `password` on purpose (see src/app/admin/login/page.tsx), and widening it
        is not this page's business. The classes match the shared control.
      */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        <input
          id={id}
          name={label}
          type="password"
          autoComplete="current-password"
          required
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg hover:border-line-strong disabled:opacity-60"
        />
        <p className="text-xs text-muted">{hint}</p>
      </div>
      <button
        type="submit"
        disabled={disabled || value.length === 0}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
      >
        {label}
      </button>
    </form>
  );
}

export function MfaPanel({ state: initialState, canDisable }: MfaPanelProps) {
  const formId = useId();
  const errorRef = useRef<HTMLDivElement | null>(null);

  const [state, setState] = useState<MfaUiState>(initialState);
  const [step, setStep] = useState<Step>('IDLE');
  const [notice, setNotice] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  // `start` output. The `otpauth://` URI CONTAINS the shared secret, so this is
  // deliberately not written to sessionStorage, localStorage, a URL or the
  // console. Reloading discards it — the correct trade for a credential, and the
  // reason the page asks for the app to be ready first.
  const [enrolment, setEnrolment] = useState<{
    uri: string;
    issuer: string;
    digits: number;
    periodSeconds: number;
  } | null>(null);
  const parsedUri: EnrolUriParts | null = enrolment ? readEnrolUri(enrolment.uri) : null;

  /**
   * Recovery codes, in memory only.
   *
   * The server stores bcrypt hashes and exposes no endpoint that can return
   * these again, so this is the only copy that will ever exist. It is held until
   * the operator says they have saved them, then dropped — a durable copy would
   * turn a one-time display into a standing plaintext secret in browser storage.
   */
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const fail = useCallback((error: unknown, atStep: Step) => {
    setFailure(
      error instanceof MfaEnrolError
        ? describeFailure(error, atStep)
        : {
            message: 'Something went wrong talking to the enrolment service. Please try again.',
            code: 'UNKNOWN',
            hint: null,
          },
    );
    // Move focus to the alert so a keyboard or screen-reader user is told what
    // went wrong instead of watching a button do nothing.
    errorRef.current?.focus();
  }, []);

  const startEnrolment = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await postEnrolment({ action: 'start', password });
      // The password has served its purpose; it is not carried into step 2 and
      // never leaves this state again.
      setPassword('');
      setState('PENDING');
      setStep('AWAITING_CODE');
      setEnrolment({
        uri: result.uri,
        issuer: result.issuer,
        digits: result.digits,
        periodSeconds: result.periodSeconds,
      });
    } catch (error) {
      fail(error, 'IDLE');
    } finally {
      setBusy(false);
    }
  }, [fail, password]);

  const confirmEnrolment = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await postEnrolment({ action: 'confirm', code });
      setCode('');
      setEnrolment(null);
      setState('ENABLED');
      setStep('RECOVERY_CODES');
      setRecoveryCodes(result.recoveryCodes);
      setNotice(
        result.revokedOtherSessions > 0
          ? `MFA is active. ${result.revokedOtherSessions} other session(s) were signed out; this one stays signed in.`
          : 'MFA is active. No other sessions were active.',
      );
    } catch (error) {
      if (error instanceof MfaEnrolError && error.needsFreshEnrolment) {
        // The grant is gone, so the code box can never succeed. Go back to step 1
        // rather than leaving the operator retrying a code nobody will accept.
        setStep('IDLE');
        setEnrolment(null);
        setState('NOT_ENABLED');
      }
      fail(error, 'AWAITING_CODE');
    } finally {
      setBusy(false);
    }
  }, [code, fail]);

  const dismissRecoveryCodes = useCallback(() => {
    // The one and only place the codes are dropped. After this they exist only
    // as hashes on the server and in whatever the operator wrote down.
    setRecoveryCodes(null);
    setStep('IDLE');
  }, []);

  const disableMfa = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await postEnrolment({ action: 'disable', password });
      setPassword('');
      setState('NOT_ENABLED');
      setEnrolment(null);
      setStep('DISABLED');
      setNotice(
        `MFA is off. ${result.revokedSessions} session(s) were revoked, including this one. ` +
          'The only way back in is a password-only sign-in.',
      );
    } catch (error) {
      fail(error, 'DISABLED');
    } finally {
      setBusy(false);
    }
  }, [fail, password]);

  const resetToIdle = useCallback(() => {
    setStep('IDLE');
    setEnrolment(null);
    setCode('');
    setFailure(null);
  }, []);

  return (
    <div className="space-y-6">
      <div ref={errorRef} tabIndex={-1} className="focus-visible:outline-none">
        {failure ? (
          <Alert variant="error" title="That did not work" live="assertive">
            <p>{failure.message}</p>
            {failure.hint ? <p className="mt-1">{failure.hint}</p> : null}
            <p className="mt-1 font-mono text-[11px] text-subtle">Error code: {failure.code}</p>
          </Alert>
        ) : null}
        {notice ? (
          <Alert
            variant={step === 'DISABLED' ? 'warning' : 'success'}
            title={step === 'DISABLED' ? 'MFA disabled' : 'Done'}
          >
            <p>{notice}</p>
          </Alert>
        ) : null}
      </div>

      {/* --- Step 1: the password, and the enrolment key -------------------- */}
      {state !== 'ENABLED' && step !== 'RECOVERY_CODES' && step !== 'DISABLED' ? (
        <section className="rounded-xl border border-line bg-surface p-5">
          {step === 'IDLE' ? (
            <>
              <h2 className="text-sm font-semibold text-fg">Enable MFA</h2>
              <p className="mt-1 text-xs text-muted">
                Have an authenticator app ready (Google Authenticator, 1Password, Authy, Aegis)
                before you start — you will need it in about a minute.
              </p>

              {state === 'PENDING' ? (
                <div className="mt-4">
                  <Alert variant="warning" title="An earlier enrolment was never finished">
                    <p>
                      A secret from a previous attempt is stored on this account but was never
                      confirmed, so MFA is <strong>not</strong> active. Starting again replaces it
                      with a new one, which invalidates the old.
                    </p>
                  </Alert>
                </div>
              ) : null}

              <div className="mt-4 max-w-sm">
                <PasswordField
                  id={`${formId}-start-password`}
                  label="Start enrolment"
                  hint="Your account password, re-checked by the server. It is never rendered back and never logged."
                  value={password}
                  disabled={busy}
                  onChange={setPassword}
                  onSubmit={startEnrolment}
                />
              </div>

              <div className="mt-4">
                <Alert variant="info" title="This first step does not protect anything yet">
                  <p>
                    It only issues a secret for your app. MFA becomes active — and every session
                    except this one is signed out — when you confirm the code in the next step.
                  </p>
                </Alert>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-sm font-semibold text-fg">Add this account to your authenticator</h2>
              <p className="mt-1 text-xs text-muted">
                {enrolment?.issuer ?? 'This store'} · {enrolment?.digits ?? 6} digits ·{' '}
                {enrolment?.periodSeconds ?? 30}s
                {parsedUri?.label ? (
                  <>
                    {' '}
                    · account <span className="font-mono">{parsedUri.label}</span>
                  </>
                ) : null}
              </p>

              {!enrolment ? (
                <Alert variant="error" title="The enrolment key is gone">
                  <p>Start enrolment again to get a fresh one.</p>
                </Alert>
              ) : parsedUri ? (
                <>
                  <div className="mt-4 rounded-lg border border-line bg-surface-2 p-4">
                    <p className="text-xs uppercase tracking-wide text-subtle">
                      Setup key — type this into your app
                    </p>
                    <p className="mt-2 select-all break-all font-mono text-base tracking-widest text-fg">
                      {formatSecretForTyping(parsedUri.secretBase32)}
                    </p>
                    <p className="mt-2 text-xs text-muted">
                      {parsedUri.digits ?? 6}-digit, {parsedUri.period ?? 30}-second step, SHA1. Most
                      apps want the key alone; some also want the issuer (
                      {parsedUri.issuer ?? enrolment.issuer}) and the account label above typed in
                      separately.
                    </p>
                  </div>

                  {/*
                    The raw `otpauth://` URI is offered too: a handful of apps
                    (Aegis, 1Password) import it directly by URL or text, and this
                    repo has no QR encoder to render one as an image — adding one
                    would mean a third-party library handling a payload that
                    contains the shared secret. It is collapsed by default and
                    never logged.
                  */}
                  <details className="mt-3 rounded-lg border border-line bg-surface-2 p-4">
                    <summary className="cursor-pointer text-xs font-medium text-fg">
                      Show the otpauth:// link instead
                    </summary>
                    <p className="mt-2 break-all font-mono text-xs text-muted">{enrolment.uri}</p>
                  </details>
                </>
              ) : (
                <Alert variant="error" title="The enrolment key could not be read">
                  <p>
                    The service returned something this page cannot parse. Enrol from the
                    otpauth:// link below, or start again.
                  </p>
                  {enrolment ? (
                    <p className="mt-2 break-all font-mono text-xs">{enrolment.uri}</p>
                  ) : null}
                </Alert>
              )}

              <form
                className="mt-4 space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void confirmEnrolment();
                }}
              >
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${formId}-code`} className="text-sm font-medium text-fg">
                    6-digit code from your app
                  </label>
                  <input
                    id={`${formId}-code`}
                    name="code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={12}
                    required
                    disabled={busy}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    className="w-48 rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-lg tracking-[0.4em] text-fg hover:border-line-strong disabled:opacity-60"
                  />
                  <p className="text-xs text-muted">
                    Proves your app holds the same secret. MFA is <strong>not</strong> active until
                    this succeeds.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="submit"
                    disabled={busy || !/^[0-9]{6}$/.test(code)}
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? 'Checking…' : 'Confirm and enable MFA'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={resetToIdle}
                    className="rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm text-fg transition-colors hover:bg-surface-3"
                  >
                    Start over
                  </button>
                </div>
              </form>
            </>
          )}
        </section>
      ) : null}

      {/* --- Step 3: the one and only display of the recovery codes ---------- */}
      {step === 'RECOVERY_CODES' && recoveryCodes ? (
        <section className="rounded-xl border border-warning/40 bg-warning/5 p-5">
          <h2 className="text-sm font-semibold text-fg">
            Save your recovery codes — this is the only time you will ever see them
          </h2>
          <p className="mt-1 text-xs text-muted">
            The store keeps these only as bcrypt hashes. There is no way to display them again and
            nobody — including support — can retrieve them for you. Each code works once. Put them
            somewhere that is not this browser.
          </p>

          <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {recoveryCodes.map((recoveryCode, index) => (
              <li
                key={recoveryCode}
                className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-center font-mono text-sm tracking-wider text-fg"
              >
                <span className="mr-1 text-[10px] text-subtle">{index + 1}</span>
                {recoveryCode}
              </li>
            ))}
          </ul>

          <div className="mt-4">
            <button
              type="button"
              onClick={dismissRecoveryCodes}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
            >
              I have saved them
            </button>
          </div>
        </section>
      ) : null}

      {/* --- Step 4: disable ------------------------------------------------ */}
      {state === 'ENABLED' && step !== 'RECOVERY_CODES' ? (
        <section className="rounded-xl border border-line bg-surface p-5">
          <h2 className="text-sm font-semibold text-fg">Disable MFA</h2>
          <div className="mt-3">
            <Alert variant="warning" title="This signs you out everywhere">
              <p>
                Disabling MFA revokes <strong>every</strong> session on this account, including the
                one you are using right now. You will land back at the sign-in screen with a
                password-only login, and until MFA is on again this account has one factor instead
                of two.
              </p>
            </Alert>
          </div>

          {canDisable ? (
            <div className="mt-4 max-w-sm">
              <PasswordField
                id={`${formId}-disable-password`}
                label="Disable MFA"
                hint="OWNER only. Your password is re-checked so a hijacked session cannot quietly remove the second factor."
                value={password}
                disabled={busy}
                onChange={setPassword}
                onSubmit={disableMfa}
              />
            </div>
          ) : (
            <Alert variant="error" title="Only an OWNER can disable MFA">
              <p>
                Turning off the second factor is deliberately restricted: it is the control that
                stops someone who already has your password from staying in. Ask the account owner
                to do it.
              </p>
            </Alert>
          )}
        </section>
      ) : null}

      {step === 'DISABLED' ? (
        <p className="text-xs text-subtle">
          This page is still on screen only because the browser has not reloaded. The session
          behind it has already been revoked — reload and you will be asked to sign in again.
        </p>
      ) : null}
    </div>
  );
}

export default MfaPanel;