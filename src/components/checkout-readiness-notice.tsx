import type { CheckoutReadiness } from './checkout-readiness';
import { Alert } from './alert';
import { cn } from './cn';

export interface CheckoutReadinessNoticeProps {
  readiness: CheckoutReadiness;
  className?: string;
  /** 'banner' for checkout, 'inline' for a product card. */
  tone?: 'banner' | 'inline';
}

/**
 * Honest unconfigured-state notice.
 *
 * When the payment provider is NOT CONFIGURED this is what the customer sees
 * instead of a buy button — a greyed-out control with no explanation would
 * read as a broken page, and a working-looking button would be a lie.
 */
export function CheckoutReadinessNotice({
  readiness,
  className,
  tone = 'banner',
}: CheckoutReadinessNoticeProps) {
  if (readiness.canPay) {
    return (
      <p className={cn('text-xs text-muted', className)}>
        Payments by {readiness.providerName}
        {readiness.providerStatus === 'SANDBOX' ? ' (sandbox)' : ''} · codes delivered by email
      </p>
    );
  }

  const providerDown = readiness.providerStatus === 'NOT_CONFIGURED';

  return (
    <Alert
      variant={providerDown ? 'warning' : 'error'}
      title={providerDown ? 'Payment provider not configured' : 'Checkout unavailable'}
      className={cn(tone === 'inline' && 'text-xs', className)}
    >
      {readiness.blockedReason}
    </Alert>
  );
}

export default CheckoutReadinessNotice;