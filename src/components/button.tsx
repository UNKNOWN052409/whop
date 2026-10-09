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

/**
 * The primary button carries a low-opacity accent bloom on hover. It is the one
 * place in the system where light appears to come from the control itself,
 * which is what makes it read as the main action rather than just another
 * rectangle.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-ink font-semibold ' +
    'shadow-[0_1px_0_rgb(255_255_255/0.15)_inset] ' +
    'hover:bg-accent-strong hover:shadow-[0_1px_0_rgb(255_255_255/0.2)_inset,0_8px_24px_-8px_rgb(52_211_153/0.5)] ' +
    'active:translate-y-px',
  secondary:
    'bg-surface-2 text-fg border border-line hover:bg-surface-3 hover:border-line-strong active:translate-y-px',
  ghost: 'bg-transparent text-muted hover:text-fg hover:bg-surface-2',
  danger: 'bg-danger text-[#2b0606] font-semibold hover:bg-[#ef5f5f] active:translate-y-px',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3.5 py-2 text-sm rounded-lg gap-1.5',
  md: 'px-5 py-2.5 text-sm rounded-lg gap-2',
  lg: 'px-7 py-3.5 text-base rounded-xl gap-2',
};

const BASE =
  'inline-flex items-center justify-center font-medium select-none ' +
  'transition-[background-color,border-color,box-shadow,transform,color] ' +
  'duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ' +
  'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:translate-y-0';

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