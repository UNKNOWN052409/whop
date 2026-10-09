import { cn } from './cn';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  /** Announced to assistive tech. Also rendered visually-hidden. */
  label?: string;
  className?: string;
}

const SIZES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-4 w-4',
  md: 'h-6 w-6',
  lg: 'h-10 w-10',
};

/**
 * Indeterminate progress indicator. Announced as a status so the message is
 * read once; `aria-hidden` on the SVG keeps the animation itself silent.
 */
export function Spinner({ size = 'md', label = 'Loading', className }: SpinnerProps) {
  return (
    <span role="status" className="inline-flex items-center gap-2">
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        className={cn('animate-spin text-accent', SIZES[size], className)}
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" fill="none" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export default Spinner;