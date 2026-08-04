import type { JSONValue } from "@the-drunken-coder/atlas-sdk";
import { useEffect, useId, useRef, useState } from "react";
import type { CommandDefinition, CommandParameterSchema } from "../../atlas/command-model.js";
import type { CommandTargeting } from "../../atlas/command-targeting.js";
import { Button, IconButton } from "../../ui/primitives/controls.js";
import { CloseIcon } from "../../ui/primitives/icons.js";

export type CommandFormProps = {
  command: CommandDefinition;
  targeting: CommandTargeting;
  formParameters: Array<[string, CommandParameterSchema]>;
  mapPoint?: { lat: number; lng: number };
  submitting: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (parameters: Record<string, JSONValue>) => void;
};

export function CommandForm(props: CommandFormProps) {
  const { command, targeting, formParameters, mapPoint, submitting, error, onCancel, onSubmit } = props;
  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...(Number.isFinite(mapPoint?.lat) ? { latitude: String(mapPoint?.lat) } : {}),
    ...(Number.isFinite(mapPoint?.lng) ? { longitude: String(mapPoint?.lng) } : {})
  }));
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );

  useEffect(() => {
    const restoreDialogFocus = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node | null)) return;
      firstDialogControl(dialog)?.focus();
    };
    document.addEventListener("focusin", restoreDialogFocus);
    return () => {
      document.removeEventListener("focusin", restoreDialogFocus);
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, []);

  const setValue = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));

  const displayedParameters =
    targeting === "map_point" ? [...coordinateParameters(command), ...formParameters] : formParameters;
  const missingRequired = displayedParameters.some(
    ([name, schema]) => schema.required && schema.type !== "boolean" && !values[name]?.trim()
  );
  const invalidParameter = displayedParameters.some(
    ([name, schema]) => parameterError(schema, values[name]) !== undefined
  );
  const canSubmit = !submitting && !missingRequired && !invalidParameter;

  const submit = () => {
    const parameters: Record<string, JSONValue> = {};
    for (const [name, schema] of displayedParameters) {
      const raw = values[name];
      if (schema.type === "boolean") {
        if (raw === "true") parameters[name] = true;
        else if (raw === "false") parameters[name] = false;
        else if (schema.required) parameters[name] = false;
        continue;
      }
      if (raw === undefined || raw.trim() === "") continue;
      parameters[name] = schema.type === "number" ? Number(raw) : raw;
    }
    onSubmit(parameters);
  };

  return (
    <div
      ref={dialogRef}
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        } else if (event.key === "Tab") {
          keepFocusInDialog(event, dialogRef.current);
        }
      }}
    >
      <div className="modal">
        <div className="modal__header">
          <span className="modal__title" id={titleId}>
            Send {command.name}
          </span>
          <IconButton label={submitting ? "Hide pending command" : "Close"} autoFocus onClick={onCancel}>
            <CloseIcon size={16} />
          </IconButton>
        </div>
        <div className="modal__body stack">
          <p style={{ margin: 0, color: "var(--text-2)" }}>{command.description}</p>

          {targeting === "map_point" && mapPoint ? (
            <div className="banner banner--info">
              Position filled from the map. Review the coordinates before sending.
            </div>
          ) : null}

          {displayedParameters.map(([name, schema]) => {
            const value = values[name] ?? "";
            return (
              <ParameterField
                key={name}
                name={name}
                schema={schema}
                value={value}
                error={parameterError(schema, value)}
                onChange={(next) => setValue(name, next)}
              />
            );
          })}

          {error ? <div className="banner banner--error">{error}</div> : null}
        </div>
        <div className="modal__footer">
          <Button variant="ghost" onClick={onCancel}>
            {submitting ? "Hide" : "Cancel"}
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {submitting ? "Sending…" : "Send command"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function keepFocusInDialog(event: { preventDefault(): void; shiftKey: boolean }, dialog: HTMLElement | null): void {
  if (!dialog) return;
  const controls = dialogControls(dialog);
  if (controls.length === 0) {
    event.preventDefault();
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  const activeElement = document.activeElement;
  const reachedEdge = event.shiftKey ? activeElement === first : activeElement === last;
  if (reachedEdge || !dialog.contains(activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

function firstDialogControl(dialog: HTMLElement): HTMLElement | undefined {
  return dialogControls(dialog)[0];
}

function dialogControls(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );
}

function ParameterField({
  name,
  schema,
  value,
  error,
  onChange
}: {
  name: string;
  schema: CommandParameterSchema;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const label = `${name}${schema.required ? " *" : ""}`;
  if (schema.type === "boolean") {
    return (
      <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={value === "true"}
          onChange={(event) => onChange(event.target.checked ? "true" : "false")}
        />
        <span className="field__label">{label}</span>
      </label>
    );
  }
  const bounds: string[] = [];
  if (schema.minimum !== undefined) bounds.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined) bounds.push(`max ${schema.maximum}`);
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        className="input"
        type={schema.type === "number" ? "number" : "text"}
        min={schema.type === "number" ? schema.minimum : undefined}
        max={schema.type === "number" ? schema.maximum : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <span className="field__error">{error}</span>
      ) : (
        <span className="field__hint">{[schema.description, bounds.join(", ")].filter(Boolean).join(" · ")}</span>
      )}
    </label>
  );
}

function parameterError(schema: CommandParameterSchema, raw: string | undefined): string | undefined {
  if (schema.type !== "number") return undefined;
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return "Enter a finite number";
  if (schema.minimum !== undefined && value < schema.minimum) return `Must be >= ${schema.minimum}`;
  if (schema.maximum !== undefined && value > schema.maximum) return `Must be <= ${schema.maximum}`;
  return undefined;
}

function coordinateParameters(command: CommandDefinition): Array<[string, CommandParameterSchema]> {
  const latitude = command.parameters_schema.latitude;
  const longitude = command.parameters_schema.longitude;
  if (!latitude || !longitude) return [];
  return [
    ["latitude", { ...latitude, minimum: latitude.minimum ?? -90, maximum: latitude.maximum ?? 90 }],
    ["longitude", { ...longitude, minimum: longitude.minimum ?? -180, maximum: longitude.maximum ?? 180 }]
  ];
}
