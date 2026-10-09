import { cn } from './cn';

export interface InputProps {
  id: string;
  name: string;
  label: string;
  type?: 'text' | 'email' | 'number' | 'tel';
  value?: string | number;
  defaultValue?: string | number;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  inputMode?: 'text' | 'email' | 'numeric' | 'tel';
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  className?: string;
  /** Marks the field invalid and wires aria-invalid + aria-describedby. */
  invalid?: boolean;
  /** id of the element holding the error/help text. */
  describedBy?: string;
  hint?: React.ReactNode;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
}

/**
 * Labelled text input. The <label> is always rendered and always bound via
 * `htmlFor`, so the control is reachable by name in a screen reader. Validation
 * state is exposed with `aria-invalid` + `aria-describedby`, never colour alone.
 */
export function Input({
  id,
  name,
  label,
  type = 'text',
  className,
  invalid = false,
  describedBy,
  hint,
  ...rest
}: InputProps) {
  const described = cn(hint ? `${id}-hint` : '', describedBy ?? '').trim();

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        aria-invalid={invalid || undefined}
        aria-describedby={described.length > 0 ? described : undefined}
        aria-required={rest.required || undefined}
        className={cn(
          'w-full rounded-lg border bg-surface-2 px-3 py-2 text-sm text-fg',
          'placeholder:text-subtle disabled:opacity-60',
          invalid ? 'border-danger' : 'border-line hover:border-line-strong',
          className,
        )}
        {...rest}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export default Input;