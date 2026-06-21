import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost";
};

export function Button({ variant = "default", className, ...props }: ButtonProps) {
  const variantClass = variant === "primary" ? " btn--primary" : variant === "ghost" ? " btn--ghost" : "";
  return <button type="button" className={`btn${variantClass}${className ? ` ${className}` : ""}`} {...props} />;
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
};

export function IconButton({ label, children, className, ...props }: IconButtonProps) {
  return (
    <button type="button" className={`icon-button${className ? ` ${className}` : ""}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  mono?: boolean;
};

export function TextField({ label, hint, mono, id, className, ...props }: TextFieldProps) {
  return (
    <label className="field" htmlFor={id}>
      {label ? <span className="field__label">{label}</span> : null}
      <input id={id} className={`input${mono ? " input--mono" : ""}${className ? ` ${className}` : ""}`} {...props} />
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  options: Array<{ value: string; label: string }>;
};

export function SelectField({ label, options, id, className, ...props }: SelectFieldProps) {
  return (
    <label className="field" htmlFor={id}>
      {label ? <span className="field__label">{label}</span> : null}
      <select id={id} className={`select${className ? ` ${className}` : ""}`} {...props}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
