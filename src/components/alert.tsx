import { cn } from './cn';

export type AlertVariant = 'info' | 'success' | 'warning' | 'error';

export interface AlertProps {
  variant?: AlertVariant;
  title?: string;
  className?: string;
  children?: React.ReactNode;
  /** Live-region politeness. Errors interrupt; everything else waits. */
  live?: 'polite' | 'assertive' | 'off';
}

const VARIANTS: Record<AlertVariant, { box: string; role: 'alert' | 'status' }> = {
  info: { box: 'border-info/40 bg-info/10 text-fg', role: 'status' },
  success: { box: 'border-success/40 bg-success/10 text-fg', role: 'status' },
  warning: { box: 'border-warning/40 bg-warning/10 text-fg', role: 'status' },
  error: { box: 'border-danger/50 bg-danger/10 text-fg', role: 'alert' },
};

/**
 * Inline notice. Errors use role="alert" (assertive), informational notices use
 * role="status" so a screen reader announces them without stealing focus.
 */
export function Alert({
  variant = 'info',
  title,
  className,
  children,
  live = 'polite',
}: AlertProps) {
  const { box, role } = VARIANTS[variant];
  return (
    <div
      role={role}
      aria-live={live === 'off' ? undefined : live}
      className={cn('rounded-lg border px-4 py-3 text-sm', box, className)}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cn(title && 'mt-1', 'text-muted')}>{children}</div> : null}
    </div>
  );
}

export default Alert;