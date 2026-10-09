import type { Availability } from '@/catalog';
import { cn } from './cn';

export interface AvailabilityBadgeProps {
  availability: Availability;
  /** Optional remaining-units hint. Never rendered when absent. */
  count?: number;
  className?: string;
}

/**
 * Availability is conveyed by text, not by colour alone: the label reads
 * "In stock" / "Sold out" so it survives greyscale and screen readers.
 */
export function AvailabilityBadge({ availability, count, className }: AvailabilityBadgeProps) {
  const inStock = availability === 'IN_STOCK';
  const label = inStock ? 'In stock' : 'Sold out';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        inStock
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-line bg-surface-2 text-muted',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 rounded-full', inStock ? 'bg-success' : 'bg-subtle')}
      />
      {label}
      {inStock && typeof count === 'number' && count > 0 ? (
        <span className="text-muted">· {count} left</span>
      ) : null}
    </span>
  );
}

export default AvailabilityBadge;