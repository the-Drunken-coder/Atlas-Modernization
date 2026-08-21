import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useId
} from "react";
import { DoubleCaretVerticalIcon } from "./icons.js";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost";
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", className, ...props },
  ref
) {
  const variantClass =
    variant === "primary" ? " bp6-intent-primary btn--primary" : variant === "ghost" ? " bp6-minimal btn--ghost" : "";
  return (
    <button
      ref={ref}
      type="button"
      className={`bp6-button btn${variantClass}${className ? ` ${className}` : ""}`}
      {...props}
    />
  );
});

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
};

export function IconButton({ label, children, className, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`bp6-button bp6-minimal bp6-small icon-button${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  mono?: boolean;
};

export function TextField({ label, hint, mono, id: providedId, className, ...props }: TextFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  return (
    <label className="bp6-label field" htmlFor={id}>
      {label ? <span className="field__label">{label}</span> : null}
      <input
        id={id}
        className={`bp6-input bp6-fill input${mono ? " input--mono" : ""}${className ? ` ${className}` : ""}`}
        {...props}
      />
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
};

export function SelectField({ label, options, id: providedId, className, ...props }: SelectFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  return (
    <label className="bp6-label field" htmlFor={id}>
      {label ? <span className="field__label">{label}</span> : null}
      <span className="bp6-html-select bp6-fill select-shell">
        <select id={id} className={`select${className ? ` ${className}` : ""}`} {...props}>
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <DoubleCaretVerticalIcon size={12} />
      </span>
    </label>
  );
}
