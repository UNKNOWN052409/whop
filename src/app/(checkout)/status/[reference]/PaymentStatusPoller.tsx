'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchOrderStatus, type OrderPhase } from '@/components/checkout-api';
import { Alert } from '@/components/alert';
import { Button } from '@/components/button';
import { Spinner } from '@/components/spinner';

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 100; // ~5 minutes, then stop polling and explain.

export interface PaymentStatusPollerProps {
  reference: string;
}

interface ViewState {
  phase: OrderPhase;
  statusLabel: string;
  loading: boolean;
  error: string | null;
  timedOut: boolean;
  /** Bumped on every successful poll; drives the live-region announcement. */
  tick: number;
}

const INITIAL: ViewState = {
  phase: 'PROCESSING',
  statusLabel: 'PENDING',
  loading: true,
  error: null,
  timedOut: false,
  tick: 0,
};

const TERMINAL: ReadonlySet<OrderPhase> = new Set<OrderPhase>([
  'DELIVERED',
  'FAILED',
  'CANCELED',
  'REVERSED',
]);

/**
 * Order status poller.
 *
 * Shows "Payment processing..." until the SERVER reports a terminal state.
 * The browser's own view of the payment is never trusted and never displayed —
 * this component renders a phase derived from `/api/payments/status` only.
 *
 * The redeem code is deliberately absent: this function extracts a phase and a
 * status label and nothing else, so no code can reach the DOM here. Email is
 * the delivery channel.
 */
export function PaymentStatusPoller({ reference }: PaymentStatusPollerProps) {
  const [state, setState] = useState<ViewState>(INITIAL);
  const pollsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const poll = useCallback(async () => {
    try {
      const result = await fetchOrderStatus(reference);
      if (!mountedRef.current) return;

      pollsRef.current += 1;
      const done = TERMINAL.has(result.phase);
      const timedOut = !done && pollsRef.current >= MAX_POLLS;

      setState((previous) => ({
        phase: result.phase,
        statusLabel: result.statusLabel,
        loading: false,
        error: null,
        timedOut,
        tick: previous.tick + 1,
      }));

      if (!done && !timedOut) {
        timerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    } catch (error) {
      if (!mountedRef.current) return;

      pollsRef.current += 1;
      const timedOut = pollsRef.current >= MAX_POLLS;
      setState((previous) => ({
        ...previous,
        loading: false,
        error: error instanceof Error ? error.message : 'Could not read your order status.',
        timedOut,
      }));

      if (!timedOut) {
        timerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    }
  }, [reference]);

  useEffect(() => {
    pollsRef.current = 0;
    setState(INITIAL);
    void poll();
  }, [poll]);

  const { phase, statusLabel, loading, error, timedOut, tick } = state;
  const settled = phase === 'DELIVERED';

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="rounded-xl border border-line bg-surface p-6"
      >
        <div className="flex items-center gap-3">
          {loading || (!TERMINAL.has(phase) && !timedOut) ? (
            <Spinner size="md" label="Payment processing" />
          ) : null}
          <div>
            <p className="text-lg font-semibold text-fg">{headlineFor(phase)}</p>
            <p className="mt-0.5 text-sm text-muted">{detailFor(phase)}</p>
          </div>
        </div>

        {/* Re-announced only when a poll actually returns a new state. */}
        <p className="sr-only" key={tick}>
          {headlineFor(phase)}
        </p>

        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-line pt-4 text-sm">
          <dt className="text-muted">Order reference</dt>
          <dd className="text-right font-mono text-fg">{reference}</dd>
          <dt className="text-muted">Status</dt>
          <dd className="text-right font-mono text-fg">{statusLabel}</dd>
        </dl>
      </div>

      {error ? (
        <div className="mt-4">
          <Alert variant="warning" title="Status check interrupted">
            {error} We will keep trying. You can also refresh this page.
          </Alert>
        </div>
      ) : null}

      {timedOut && !TERMINAL.has(phase) ? (
        <div className="mt-4">
          <Alert variant="info" title="Still processing">
            This is taking longer than usual. You can close this page — delivery happens by email and
            continues in the background. If nothing arrives, contact support with your order
            reference.
          </Alert>
        </div>
      ) : null}

      {settled ? (
        <div className="mt-4">
          <Alert variant="success" title="Delivered">
            Your redeem code has been emailed to the address you entered at checkout. It is never
            displayed in the browser.
          </Alert>
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        <Button href="/" variant="secondary">
          Back to shop
        </Button>
        <p className="self-center text-xs text-subtle">
          This page refreshes automatically. You can safely close it.
        </p>
      </div>
    </div>
  );
}

function headlineFor(phase: OrderPhase): string {
  switch (phase) {
    case 'DELIVERED':
      return 'Payment verified — delivered to your email';
    case 'PAID':
      return 'Payment verified — sending your code';
    case 'FAILED':
      return 'Payment failed';
    case 'CANCELED':
      return 'Payment not completed';
    case 'REVERSED':
      return 'Payment reversed';
    case 'REVIEW':
      return 'Order under review';
    case 'PROCESSING':
    default:
      return 'Payment processing…';
  }
}

function detailFor(phase: OrderPhase): string {
  switch (phase) {
    case 'DELIVERED':
      return 'Check your inbox for the email containing your redeem code.';
    case 'PAID':
      return 'Your payment is confirmed. Your code is on its way to your inbox.';
    case 'FAILED':
      return 'No charge was completed. If you were charged, contact support with your reference.';
    case 'CANCELED':
      return 'The payment window closed before it completed. You have not been charged.';
    case 'REVERSED':
      return 'This payment was reversed. If you did not request this, contact support immediately.';
    case 'REVIEW':
      return 'We are checking this order manually. No further action is needed from you right now.';
    case 'PROCESSING':
    default:
      return 'Waiting for confirmation from the payment provider. This page updates automatically.';
  }
}

export default PaymentStatusPoller;