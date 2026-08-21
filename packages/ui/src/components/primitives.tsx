import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Icon, type IconName } from './Icon.js';

/* -------------------------------------------------------------------------- */
/* Button                                                                      */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ControlSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
  loading?: boolean;
  icon?: IconName;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, icon, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className="scp-button"
      data-variant={variant}
      data-size={size}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="scp-spinner" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control needs an accessible name. */
  label: string;
  icon: IconName;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, ...rest },
  ref,
) {
  return (
    <button ref={ref} type="button" className="scp-icon-button" aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
});

/* -------------------------------------------------------------------------- */
/* Field wrapper                                                               */
/* -------------------------------------------------------------------------- */

/**
 * An explanation that stays out of the way until it is wanted.
 *
 * A hint under the control pushes everything below it down and competes with
 * the value for attention; for something a reader needs once and then knows,
 * that is the wrong trade. This opens on click rather than hover, so it works
 * on a touch screen and cannot be triggered by a passing cursor, and it is
 * positioned absolutely so opening it never moves the form.
 */
export function HelpPopover({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: MouseEvent): void => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  return (
    <span className="scp-help" ref={wrapper}>
      <button
        type="button"
        className="scp-help-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`What does "${label}" mean?`}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="help" />
      </button>
      {open ? (
        <span className="scp-help-panel" id={panelId} role="note">
          {children}
        </span>
      ) : null}
    </span>
  );
}

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  /** Shown behind a question mark beside the label, rather than under the control. */
  help?: ReactNode;
  error?: string | null;
  optional?: boolean;
  htmlFor?: string;
  children: ReactNode;
}

export function Field({ label, hint, help, error, optional, htmlFor, children }: FieldProps): JSX.Element {
  return (
    <div className="scp-field">
      {/* The trigger sits beside the label rather than inside it: a button
          nested in a label is activated twice, once for each. */}
      <span className="scp-label-row">
        <label className="scp-label" htmlFor={htmlFor}>
          {label} {optional ? <span className="scp-label-optional">(optional)</span> : null}
        </label>
        {help ? <HelpPopover label={label}>{help}</HelpPopover> : null}
      </span>
      {children}
      {error ? (
        <span className="scp-error-text" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="scp-hint">{hint}</span>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, optional, id, ...rest },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = `${inputId}-description`;
  return (
    <Field label={label} hint={hint} error={error} optional={optional} htmlFor={inputId}>
      <input
        ref={ref}
        id={inputId}
        className="scp-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? describedBy : undefined}
        {...rest}
      />
      <span id={describedBy} className="scp-visually-hidden">
        {error ?? (typeof hint === 'string' ? hint : '')}
      </span>
    </Field>
  );
});

export interface PasswordInputProps extends InputProps {
  /**
   * When true the field represents an already stored secret: it renders a
   * placeholder and never a value, because an existing password is never shown
   * again (PRODUCT.md section 16).
   */
  existing?: boolean;
}

export function PasswordInput({ existing, hint, ...props }: PasswordInputProps): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const generated = useId();
  const inputId = props.id ?? generated;

  if (existing) {
    return (
      <Field label={props.label} hint={hint ?? 'Stored passwords are never displayed.'} htmlFor={inputId}>
        <input
          id={inputId}
          className="scp-input"
          type="password"
          value="••••••••••••"
          readOnly
          disabled
          aria-label={`${props.label} (stored, not readable)`}
        />
      </Field>
    );
  }

  return (
    <Field label={props.label} hint={hint} error={props.error} optional={props.optional} htmlFor={inputId}>
      <div className="scp-input-wrap">
        <input
          {...props}
          id={inputId}
          className="scp-input"
          type={revealed ? 'text' : 'password'}
          autoComplete="new-password"
          aria-invalid={props.error ? true : undefined}
        />
        <span className="scp-input-affix">
          <IconButton
            label={revealed ? 'Hide password' : 'Show password'}
            icon={revealed ? 'eyeOff' : 'eye'}
            onClick={() => setRevealed((value) => !value)}
            tabIndex={-1}
          />
        </span>
      </div>
    </Field>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
}

export function Textarea({ label, hint, error, optional, id, ...rest }: TextareaProps): JSX.Element {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <Field label={label} hint={hint} error={error} optional={optional} htmlFor={fieldId}>
      <textarea id={fieldId} className="scp-textarea" aria-invalid={error ? true : undefined} {...rest} />
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  options: SelectOption[];
  hint?: ReactNode;
  help?: ReactNode;
  error?: string | null;
  placeholder?: string;
}

export function Select({ label, options, hint, help, error, placeholder, id, ...rest }: SelectProps): JSX.Element {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <Field label={label} hint={hint} help={help} error={error} htmlFor={fieldId}>
      <select id={fieldId} className="scp-select" {...rest}>
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, id, ...rest }: CheckboxProps): JSX.Element {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <label className="scp-checkbox" htmlFor={fieldId}>
      <input id={fieldId} type="checkbox" {...rest} />
      <span>
        <span>{label}</span>
        {description ? <div className="scp-hint">{description}</div> : null}
      </span>
    </label>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, description, disabled }: SwitchProps): JSX.Element {
  return (
    <label className="scp-switch-control">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className="scp-switch"
        data-checked={checked}
        onClick={() => onChange(!checked)}
      />
      <span>
        <span>{label}</span>
        {description ? <div className="scp-hint">{description}</div> : null}
      </span>
    </label>
  );
}

export interface RadioCardProps {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  title: string;
  description?: ReactNode;
  disabled?: boolean;
}

export function RadioCard({
  name,
  value,
  checked,
  onChange,
  title,
  description,
  disabled,
}: RadioCardProps): JSX.Element {
  return (
    <label className="scp-radio-card" data-selected={checked}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
      />
      <span>
        <span className="scp-radio-card-title">{title}</span>
        {description ? <div className="scp-radio-card-description">{description}</div> : null}
      </span>
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Form layout                                                                 */
/* -------------------------------------------------------------------------- */

export interface FormSectionProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}

export function FormSection({ title, description, children }: FormSectionProps): JSX.Element {
  return (
    <section className="scp-form-section">
      <div>
        <h3 className="scp-form-section-title">{title}</h3>
        {description ? <p className="scp-form-section-description">{description}</p> : null}
      </div>
      <div className="scp-stack">{children}</div>
    </section>
  );
}

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  label = 'Search',
}: SearchInputProps): JSX.Element {
  const id = useId();
  return (
    <div className="scp-search">
      <label className="scp-visually-hidden" htmlFor={id}>
        {label}
      </label>
      <div className="scp-input-wrap">
        <input
          id={id}
          className="scp-input"
          type="search"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="scp-input-affix" aria-hidden="true">
          <span className="scp-icon-button">
            <Icon name="search" />
          </span>
        </span>
      </div>
    </div>
  );
}

export function FilterBar({ children }: { children: ReactNode }): JSX.Element {
  return <div className="scp-filter-bar">{children}</div>;
}
