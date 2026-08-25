import {
  Button as BlueprintButton,
  type ButtonProps as BlueprintButtonProps,
  FormGroup,
  HTMLSelect,
  type HTMLSelectProps,
  InputGroup,
  type InputGroupProps,
  Intent
} from "@blueprintjs/core";
import { forwardRef, useId } from "react";

type ButtonVariant = "default" | "primary" | "ghost";
type ButtonProps = Omit<BlueprintButtonProps, "intent" | "variant"> & { variant?: ButtonVariant };

/** Atlas button vocabulary backed by Blueprint's focus, loading, and disabled behavior. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", className, ...props },
  ref
) {
  return (
    <BlueprintButton
      ref={ref}
      intent={variant === "primary" ? Intent.PRIMARY : Intent.NONE}
      variant={variant === "ghost" ? "minimal" : "solid"}
      className={`btn${variant === "primary" ? " btn--primary" : variant === "ghost" ? " btn--ghost" : ""}${className ? ` ${className}` : ""}`}
      {...props}
    />
  );
});

type IconButtonProps = Omit<ButtonProps, "variant"> & { label: string };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, className, ...props },
  ref
) {
  return (
    <BlueprintButton
      ref={ref}
      type="button"
      variant="minimal"
      size="small"
      className={`icon-button${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </BlueprintButton>
  );
});

type TextFieldProps = InputGroupProps & {
  label?: string;
  hint?: string;
  mono?: boolean;
};

export function TextField({ label, hint, mono, id: providedId, className, ...props }: TextFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  return (
    <FormGroup
      className="field"
      helperText={hint}
      intent={props["aria-invalid"] ? Intent.DANGER : Intent.NONE}
      label={label}
      labelFor={id}
    >
      <InputGroup
        id={id}
        fill
        size="small"
        className={`input${mono ? " input--mono" : ""}${className ? ` ${className}` : ""}`}
        {...props}
      />
    </FormGroup>
  );
}

type SelectFieldProps = HTMLSelectProps & { label?: string };

export function SelectField({ label, id: providedId, className, ...props }: SelectFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  return (
    <FormGroup className="field" label={label} labelFor={id}>
      <HTMLSelect id={id} fill className={`select-shell${className ? ` ${className}` : ""}`} {...props} />
    </FormGroup>
  );
}
