import { useState } from "react";
import type { JSONValue } from "@the-drunken-coder/atlas-sdk";
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
  const [values, setValues] = useState<Record<string, string>>({});

  const setValue = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));

  const hasValidMapPoint = targeting !== "map_point" || isFiniteMapPoint(mapPoint);
  const missingRequired = formParameters.some(([name, schema]) => schema.required && schema.type !== "boolean" && !(values[name]?.trim()));
  const invalidParameter = formParameters.some(([name, schema]) => parameterError(schema, values[name]) !== undefined);
  const canSubmit = !submitting && hasValidMapPoint && !missingRequired && !invalidParameter;

  const submit = () => {
    const parameters: Record<string, JSONValue> = {};
    if (targeting === "map_point" && isFiniteMapPoint(mapPoint)) {
      parameters.latitude = mapPoint.lat;
      parameters.longitude = mapPoint.lng;
    }
    for (const [name, schema] of formParameters) {
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
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Send ${command.name}`}>
      <div className="modal">
        <div className="modal__header">
          <span className="modal__title">{command.name}</span>
          <IconButton label="Close" onClick={onCancel}>
            <CloseIcon size={16} />
          </IconButton>
        </div>
        <div className="modal__body stack">
          <p style={{ margin: 0, color: "var(--text-2)" }}>{command.description}</p>

          {targeting === "map_point" && mapPoint ? (
            <div className="banner banner--info">
              Target: {mapPoint.lat.toFixed(5)}, {mapPoint.lng.toFixed(5)}
            </div>
          ) : null}

          {formParameters.map(([name, schema]) => {
            const value = values[name] ?? "";
            return <ParameterField key={name} name={name} schema={schema} value={value} error={parameterError(schema, value)} onChange={(next) => setValue(name, next)} />;
          })}

          {error ? <div className="banner banner--error">{error}</div> : null}
        </div>
        <div className="modal__footer">
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {submitting ? "Sending…" : "Send command"}
          </Button>
        </div>
      </div>
    </div>
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
        <input type="checkbox" checked={value === "true"} onChange={(event) => onChange(event.target.checked ? "true" : "false")} />
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
      {error ? <span className="field__error">{error}</span> : <span className="field__hint">{[schema.description, bounds.join(", ")].filter(Boolean).join(" · ")}</span>}
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

function isFiniteMapPoint(value: { lat: number; lng: number } | undefined): value is { lat: number; lng: number } {
  return value !== undefined && Number.isFinite(value.lat) && Number.isFinite(value.lng);
}
