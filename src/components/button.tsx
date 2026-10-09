import Link from 'next/link';
import { cn } from './cn';

/**
 * Button — renders an anchor (via next/link) when `href` is given, otherwise a
 * real `<button>`. Server-safe: no hooks, no browser APIs, so it can be used
 * from both Server Components and Client Components.
 *
 * `disabled` is only meaningful on the button; the anchor path is given
 * `aria-disabled` + `tabIndex={-1}` instead of the HTML attribute, because a
 * disabled anchor is not focusable and therefore invisible to a keyboard user.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  href?: string;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  /** Renders a busy affordance and blocks activation. */
  loading?: boolean;
  className?: string;
  children?: React.ReactNode;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-controls'?: string;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-ink hover:bg-accent-strong disabled:hover:bg-accent font-semibold',
  secondary: 'bg-surface-2 text-fg border border-line hover:bg-surface-3 hover:border-line-strong',
  ghost: 'bg-transparent text-muted hover:text-fg hover:bg-surface-2',
  danger: 'bg-danger text-[#2b0606] hover:bg-[#ef5f5f] font-semibold',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm rounded-md gap-1.5',
  md: 'px-4 py-2 text-sm rounded-lg gap-2',
  lg: 'px-6 py-3 text-base rounded-lg gap-2',
};

const BASE =
  'inline-flex items-center justify-center font-medium transition-colors select-none ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export function Button({
  variant = 'primary',
  size = 'md',
  href,
  type = 'button',
  disabled = false,
  loading = false,
  className,
  children,
  ...aria
}: ButtonProps) {
  const classes = cn(BASE, VARIANTS[variant], SIZES[size], className);
  const inactive = disabled || loading;

  if (href !== undefined) {
    const linkProps = {
      href,
      'aria-disabled': inactive ? true : undefined,
      'aria-label': aria['aria-label'],
      'aria-describedby': aria['aria-describedby'],
      'aria-controls': aria['aria-controls'],
      tabIndex: inactive ? -1 : undefined,
      className: cn(classes, inactive && 'pointer-events-none opacity-50'),
    };
    // Internal hrefs get client-side navigation; external ones stay a plain
    // anchor so Link's router handling never applies to a provider's URL.
    return href.startsWith('/') ? <Link {...linkProps}>{children}</Link> : <a {...linkProps}>{children}</a>;
  }

  return (
    <button
      type={type}
      disabled={inactive}
      aria-busy={loading || undefined}
      aria-label={aria['aria-label']}
      aria-describedby={aria['aria-describedby']}
      aria-controls={aria['aria-controls']}
      className={classes}
    >
      {children}
    </button>
  );
}

export default Button;