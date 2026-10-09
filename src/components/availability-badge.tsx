import type { Availability } from '@/catalog';
import { cn } from './cn';

export interface AvailabilityBadgeProps {
  availability: Availability;
  /**
   * Scarcity hint. A BOOLEAN, never a unit count — see `isLowStock()` in
   * `src/catalog/availability.ts` for why the exact figure is not published.
   * Derive it with that helper so the two cannot drift apart.
   */
  lowStock?: boolean;
  className?: string;
}

/**
 * Availability is conveyed by text, not by colour alone: the label reads
 * "In stock" / "Low stock" / "Sold out" so it survives greyscale and screen
 * readers.
 *
 * The three states are the whole disclosure. There is deliberately no
 * "N left": an exact remaining-units figure on a public page is a free stock
 * oracle for anyone enumerating the catalog.
 */
export function AvailabilityBadge({ availability, lowStock, className }: AvailabilityBadgeProps) {
  const inStock = availability === 'IN_STOCK';
  const label = inStock ? (lowStock ? 'Low stock' : 'In stock') : 'Sold out';

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
    </span>
  );
}

export default AvailabilityBadge;