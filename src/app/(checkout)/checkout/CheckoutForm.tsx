'use client';

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { formatMoney } from '@/lib/money';
import { Alert } from '@/components/alert';
import { Button } from '@/components/button';
import { Input } from '@/components/input';
import { Spinner } from '@/components/spinner';
import { CheckoutApiError, createCheckout } from '@/components/checkout-api';
import type { IntegrationStatus } from '@/lib/env';

export interface CheckoutProduct {
  id: string;
  slug: string;
  name: string;
  currency: string;
  /** Integer minor units. The customer pays this. */
  unitPriceMinor: number;
  /** Integer minor units. The delivered code is worth this. */
  faceValueMinor: number;
  deliveryMethod: string;
  region: string;
  inStock: boolean;
}

export interface CheckoutFormProps {
  product: CheckoutProduct;
  /** Enabled AND provider-supported methods, computed on the server. */
  methods: readonly string[];
  providerName: string;
  /** 'SANDBOX' is shown honestly as sandbox rather than passed off as live. */
  providerStatus: IntegrationStatus;
  emailStatus: IntegrationStatus;
  canPay: boolean;
  blockedReason: string | null;
}

const METHOD_LABELS: Record<string, string> = {
  CARD: 'Card — credit or debit',
  UPI: 'UPI',
  WALLET: 'Wallet',
  NETBANKING: 'Netbanking',
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 320;
const MAX_QUANTITY = 10;

function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email.trim());
}

function methodLabel(key: string): string {
  return METHOD_LABELS[key.toUpperCase()] ?? key;
}

/**
 * Checkout form.
 *
 * Order of operations that matter:
 *   1. Client-side validation (email, method, quantity, explicit confirmation).
 *   2. POST /api/checkout — the SERVER decides the price; nothing here is
 *      trusted, this only makes the form usable.
 *   3. Redirect to the provider's hosted checkout via `window.location.href`,
 *      so the buyer's session and the payment page live in one navigation.
 *
 * The redeem code is never part of this component: it is not in the request, not
 * in the response, and not in the DOM. Delivery is email.
 */
export function CheckoutForm({
  product,
  methods,
  providerName,
  providerStatus,
  emailStatus,
  canPay,
  blockedReason,
}: CheckoutFormProps) {
  const formId = useId();
  const errorRef = useRef<HTMLDivElement | null>(null);

  const [quantity, setQuantity] = useState(1);
  const [email, setEmail] = useState('');
  const [method, setMethod] = useState<string>(methods[0] ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiErrorCode, setApiErrorCode] = useState<string | null>(null);

  const clampedQuantity = Math.min(Math.max(1, Math.trunc(quantity) || 1), MAX_QUANTITY);
  // Integer minor units throughout — total is a sum of integer cents, never a
  // float multiplication of dollars.
  const totalMinor = product.unitPriceMinor * clampedQuantity;
  const totalValueMinor = product.faceValueMinor * clampedQuantity;

  const emailError = useMemo(() => {
    if (!emailTouched) return null;
    if (email.trim().length === 0) return 'Email address is required.';
    if (!isValidEmail(email)) return 'Enter a valid email address, for example you@example.com.';
    return null;
  }, [email, emailTouched]);

  const methodError = methods.length === 0 ? 'No payment method is available.' : null;

  const formValid =
    canPay &&
    product.inStock &&
    methods.length > 0 &&
    isValidEmail(email) &&
    email.trim().length > 0 &&
    confirmed;

  const emailId = `${formId}-email`;
  const emailErrorId = `${emailId}-error`;
  const methodErrorId = `${formId}-method-error`;
  const confirmId = `${formId}-confirm`;

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setEmailTouched(true);
      setApiError(null);
      setApiErrorCode(null);

      if (!formValid || submitting) {
        // Move focus to the first problem so a keyboard/screen-reader user is
        // told what is wrong instead of silently failing.
        errorRef.current?.focus();
        return;
      }

      setSubmitting(true);
      try {
        const result = await createCheckout({
          productId: product.id,
          quantity: clampedQuantity,
          email: email.trim(),
          paymentMethod: method,
        });

        if (!result.checkoutUrl) {
          setApiError('The checkout service did not return a payment link. Please try again.');
          errorRef.current?.focus();
          return;
        }

        // Full navigation to the provider's hosted checkout.
        window.location.href = result.checkoutUrl;
      } catch (error) {
        const message =
          error instanceof CheckoutApiError
            ? error.message
            : 'Something went wrong starting checkout. Please try again.';
        const code = error instanceof CheckoutApiError ? error.code : 'UNKNOWN';
        setApiError(message);
        setApiErrorCode(code);
        errorRef.current?.focus();
      } finally {
        setSubmitting(false);
      }
    },
    [clampedQuantity, confirmed, email, formValid, method, product.id, submitting],
  );

  return (
    <form onSubmit={handleSubmit} noValidate className="grid gap-6 lg:grid-cols-[1fr_360px]">
      {/* Left column: the form ------------------------------------------- */}
      <div className="flex flex-col gap-6">
        {/* Focus target: the error alert is rendered inside this node so the
            ref always points at the same element. */}
        <div ref={errorRef} tabIndex={-1} className="focus-visible:outline-none">
          {apiError ? (
            <Alert variant="error" title="Checkout could not be started" live="assertive">
              {apiError}
              {apiErrorCode ? (
                <p className="mt-1 font-mono text-[11px] text-subtle">Error code: {apiErrorCode}</p>
              ) : null}
            </Alert>
          ) : null}
        </div>

        {blockedReason ? (
          <Alert variant={providerStatus === 'NOT_CONFIGURED' ? 'warning' : 'error'}>
            {blockedReason}
          </Alert>
        ) : null}

        {!product.inStock ? (
          <Alert variant="warning" title="Out of stock">
            This product has no available codes right now, so it cannot be ordered.
          </Alert>
        ) : null}

        {canPay && emailStatus === 'NOT_CONFIGURED' ? (
          <Alert variant="warning" title="Email delivery unavailable">
            No email provider is configured, so codes could not be delivered after payment. Checkout
            is disabled rather than taking money it cannot deliver.
          </Alert>
        ) : null}

        {/* Product line ------------------------------------------------- */}
        <fieldset className="rounded-xl border border-line bg-surface p-5">
          <legend className="px-1 text-sm font-semibold text-fg">Product</legend>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-fg">{product.name}</p>
              <p className="text-xs text-subtle">
                {product.deliveryMethod === 'EMAIL' ? 'Delivered by email' : product.deliveryMethod}
                {product.region ? ` · ${product.region}` : ''}
              </p>
            </div>
            <p className="shrink-0 text-sm font-semibold text-accent">
              {formatMoney(product.unitPriceMinor, product.currency)} each
            </p>
          </div>

          <div className="mt-4">
            <label htmlFor={`${formId}-quantity`} className="text-sm font-medium text-fg">
              Quantity
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setQuantity((q) => Math.max(1, Math.trunc(q) - 1))}
                disabled={clampedQuantity <= 1 || submitting}
                aria-label="Decrease quantity"
                className="h-10 w-10 rounded-lg border border-line bg-surface-2 text-lg leading-none text-fg hover:bg-surface-3 disabled:opacity-40"
              >
                &minus;
              </button>
              <input
                id={`${formId}-quantity`}
                name="quantity"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_QUANTITY}
                step={1}
                value={clampedQuantity}
                disabled={submitting}
                onChange={(event) => setQuantity(Number.parseInt(event.target.value, 10) || 1)}
                className="h-10 w-20 rounded-lg border border-line bg-surface-2 px-3 text-center text-sm text-fg"
              />
              <button
                type="button"
                onClick={() => setQuantity((q) => Math.min(MAX_QUANTITY, Math.trunc(q) + 1))}
                disabled={clampedQuantity >= MAX_QUANTITY || submitting}
                aria-label="Increase quantity"
                className="h-10 w-10 rounded-lg border border-line bg-surface-2 text-lg leading-none text-fg hover:bg-surface-3 disabled:opacity-40"
              >
                +
              </button>
              <span className="text-xs text-subtle">Maximum {MAX_QUANTITY} per order</span>
            </div>
          </div>
        </fieldset>

        {/* Email -------------------------------------------------------- */}
        <div className="rounded-xl border border-line bg-surface p-5">
          <h2 className="text-sm font-semibold text-fg">Delivery email</h2>
          <p className="mt-1 text-xs text-muted">
            Your redeem code is emailed here after the payment is verified. We never display it on
            this website.
          </p>
          <div className="mt-4">
            <Input
              id={emailId}
              name="email"
              type="email"
              label="Email address"
              autoComplete="email"
              inputMode="email"
              maxLength={MAX_EMAIL_LENGTH}
              required
              placeholder="you@example.com"
              value={email}
              disabled={submitting}
              invalid={emailError !== null}
              describedBy={emailError ? emailErrorId : undefined}
              onChange={(event) => setEmail(event.target.value)}
              onBlur={() => setEmailTouched(true)}
              hint="Check this address — the code is only sent once."
            />
            {emailError ? (
              <p id={emailErrorId} role="alert" className="mt-1 text-xs text-danger">
                {emailError}
              </p>
            ) : null}
          </div>
        </div>

        {/* Payment method ------------------------------------------------ */}
        <fieldset
          className="rounded-xl border border-line bg-surface p-5"
          aria-describedby={methodError ? methodErrorId : undefined}
        >
          <legend className="px-1 text-sm font-semibold text-fg">Payment method</legend>
          <p className="text-xs text-muted">
            You will be taken to {providerName}
            {providerStatus === 'SANDBOX' ? ' sandbox ' : ' '}
            checkout to enter your card details. We never see or store them.
          </p>

          {methodError ? (
            <p id={methodErrorId} role="alert" className="mt-3 text-xs text-danger">
              {methodError}
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {methods.map((option) => {
                const optionId = `${formId}-method-${option}`;
                const selected = method === option;
                return (
                  <li key={option}>
                    <label
                      htmlFor={optionId}
                      className={`flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
                        selected
                          ? 'border-accent bg-accent/10 text-fg'
                          : 'border-line bg-surface-2 text-muted hover:border-line-strong'
                      }`}
                    >
                      <input
                        id={optionId}
                        type="radio"
                        name="paymentMethod"
                        value={option}
                        checked={selected}
                        disabled={submitting || !canPay}
                        onChange={() => setMethod(option)}
                        className="h-4 w-4 accent-[var(--color-accent)]"
                      />
                      {methodLabel(option)}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      </div>

      {/* Right column: order summary -------------------------------------- */}
      <aside aria-labelledby={`${formId}-summary`} className="lg:sticky lg:top-24 lg:self-start">
        <div className="rounded-xl border border-line bg-surface p-5">
          <h2 id={`${formId}-summary`} className="text-sm font-semibold text-fg">
            Order summary
          </h2>

          <dl className="mt-4 space-y-2.5 text-sm">
            <div className="flex items-start justify-between gap-4">
              <dt className="text-muted">Product</dt>
              <dd className="text-right text-fg">
                {product.name}
                <span className="block text-xs text-subtle">Qty {clampedQuantity}</span>
              </dd>
            </div>

            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted">Value</dt>
              <dd className="text-right font-medium text-fg">
                {formatMoney(totalValueMinor, product.currency)}
              </dd>
            </div>

            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted">Customer price</dt>
              <dd className="text-right font-medium text-fg">
                {formatMoney(product.unitPriceMinor * clampedQuantity, product.currency)}
              </dd>
            </div>

            <div className="flex items-start justify-between gap-4">
              <dt className="text-muted">Email</dt>
              <dd className="text-right text-fg">{email.trim() || '—'}</dd>
            </div>

            <div className="flex items-start justify-between gap-4">
              <dt className="text-muted">Payment method</dt>
              <dd className="text-right text-fg">{method ? methodLabel(method) : '—'}</dd>
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-line pt-3">
              <dt className="font-semibold text-fg">TOTAL</dt>
              <dd className="text-right text-xl font-bold text-accent">
                {formatMoney(totalMinor, product.currency)}
              </dd>
            </div>
          </dl>

          <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            You pay <strong className="text-fg">{formatMoney(totalMinor, product.currency)}</strong>{' '}
            and receive code(s) worth{' '}
            <strong className="text-fg">{formatMoney(totalValueMinor, product.currency)}</strong>.
            Codes are emailed to you after your payment is verified.
          </p>

          {/* Explicit confirmation — PAY stays disabled until checked. */}
          <div className="mt-4">
            <label
              htmlFor={confirmId}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface-2 px-3 py-3 text-sm text-fg"
            >
              <input
                id={confirmId}
                name="confirm"
                type="checkbox"
                checked={confirmed}
                disabled={submitting || !canPay}
                required
                aria-required="true"
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
              />
              <span>
                I confirm the total of{' '}
                <strong className="font-semibold text-accent">{formatMoney(totalMinor, product.currency)}</strong>{' '}
                and the email address above, and I understand the code I receive will be worth{' '}
                {formatMoney(totalValueMinor, product.currency)}.
              </span>
            </label>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            <Button type="submit" size="lg" disabled={!formValid || submitting} loading={submitting}>
              {submitting ? 'Starting checkout…' : `PAY ${formatMoney(totalMinor, product.currency)}`}
            </Button>
            {!formValid && canPay && product.inStock ? (
              <p className="text-center text-xs text-muted">
                Enter a valid email and tick the confirmation box to continue.
              </p>
            ) : null}
            {canPay && product.inStock ? (
              <p className="text-center text-xs text-subtle">
                You will be redirected to {providerName} to complete payment.
              </p>
            ) : null}
          </div>

          {submitting ? (
            <p className="mt-3 flex items-center justify-center gap-2 text-xs text-muted">
              <Spinner size="sm" label="Starting checkout" />
              Contacting the payment provider…
            </p>
          ) : null}
        </div>
      </aside>
    </form>
  );
}

export default CheckoutForm;