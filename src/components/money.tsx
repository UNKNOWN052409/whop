import { formatMoney } from '@/lib/money';
import { cn } from './cn';

export interface MoneyProps {
  /** Integer minor units (cents). Never a float. */
  amountMinor: number;
  currency: string;
  className?: string;
  /** Adds a non-breaking separator so an amount never wraps onto its own line. */
  nowrap?: boolean;
}

/**
 * Renders an amount through `formatMoney` — the single money formatter in the
 * codebase. This component takes integer minor units only; it has no notion of
 * major units and cannot be handed a float by accident at the type level.
 */
export function Money({ amountMinor, currency, className, nowrap = true }: MoneyProps) {
  return (
    <span className={cn(nowrap && 'whitespace-nowrap tabular-nums', className)}>
      {formatMoney(amountMinor, currency)}
    </span>
  );
}

export default Money;