import {
  Button as BlueprintButton,
  type ButtonProps as BlueprintButtonProps,
  FormGroup,
  HTMLSelect,
  type HTMLSelectProps,
  InputGroup,
  type InputGroupProps
} from "@blueprintjs/core";
import { forwardRef, type ReactNode, useId } from "react";

type ButtonProps = Omit<BlueprintButtonProps, "variant"> & {
  variant?: "default" | "primary" | "ghost";
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", className, ...props },
  ref
) {
  const intent = variant === "primary" ? "primary" : undefined;
  const minimal = variant === "ghost";
  return (
    <BlueprintButton
      ref={ref}
      type="button"
      className={`btn${variant === "primary" ? " btn--primary" : variant === "ghost" ? " btn--ghost" : ""}${className ? ` ${className}` : ""}`}
      intent={intent}
      minimal={minimal}
      {...props}
    />
  );
});

type IconButtonProps = BlueprintButtonProps & {
  label: string;
  children: ReactNode;
};

export function IconButton({ label, children, className, ...props }: IconButtonProps) {
  return (
    <BlueprintButton
      type="button"
      className={`icon-button${className ? ` ${className}` : ""}`}
      minimal
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </BlueprintButton>
  );
}

type TextFieldProps = Omit<InputGroupProps, "inputClassName" | "inputRef" | "leftElement" | "rightElement"> & {
  label?: string;
  hint?: string;
  mono?: boolean;
};

export function TextField({ label, hint, mono, id: providedId, className, ...props }: TextFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  return (
    <FormGroup className="field" label={label} labelFor={id} helperText={hint}>
      <InputGroup
        id={id}
        fill
        inputClassName={`input${mono ? " input--mono" : ""}${className ? ` ${className}` : ""}`}
        {...props}
      />
    </FormGroup>
  );
}

type SelectFieldProps = Omit<HTMLSelectProps, "multiple" | "options"> & {
  label?: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
};

export function SelectField({ label, options, id: providedId, className, ...props }: SelectFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  return (
    <FormGroup className="field" label={label} labelFor={id}>
      <HTMLSelect
        id={id}
        className={`select-shell${className ? ` ${className}` : ""}`}
        fill
        options={options}
        {...props}
      />
    </FormGroup>
  );
}
