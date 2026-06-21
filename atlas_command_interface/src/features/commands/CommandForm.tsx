import { useState } from "react";
import type { JSONValue } from "../../../../atlas_sdk/src/index.js";
import type { CommandDefinition, CommandParameterSchema } from "../../atlas/command-model.js";
import type { CommandTargeting } from "../../atlas/command-targeting.js";
import { Button, IconButton } from "../../ui/primitives/controls.js";
import { CloseIcon } from "../../ui/primitives/icons.js";

export type CommandFormProps = {
  command: CommandDefinition;
  targeting: CommandTargeting;
  formParameters: Array<[string, CommandParameterSchema]>;
  mapPoint?: { lat: number; lng: number };
  credential: string;
  onCredentialChange: (value: string) => void;
  submitting: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (parameters: Record<string, JSONValue>) => void;
};

export function CommandForm(props: CommandFormProps) {
  const { command, targeting, formParameters, mapPoint, credential, onCredentialChange, submitting, error, onCancel, onSubmit } = props;
  const [values, setValues] = useState<Record<string, string>>({});

  const setValue = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));

  const missingRequired = formParameters.some(([name, schema]) => schema.required && schema.type !== "boolean" && !(values[name]?.trim()));
  const canSubmit = !submitting && credential.trim().length > 0 && !missingRequired;

  const submit = () => {
    const parameters: Record<string, JSONValue> = {};
    if (targeting === "map_point" && mapPoint) {
      parameters.latitude = mapPoint.lat;
      parameters.longitude = mapPoint.lng;
    }
    for (const [name, schema] of formParameters) {
      const raw = values[name];
      if (schema.type === "boolean") {
        if (raw === "true") parameters[name] = true;
        else if (schema.required) parameters[name] = false;
        continue;
      }
      if (raw === undefined || raw.trim() === "") continue;
      parameters[name] = raw;
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

          {formParameters.map(([name, schema]) => (
            <ParameterField key={name} name={name} schema={schema} value={values[name] ?? ""} onChange={(value) => setValue(name, value)} />
          ))}

          <label className="field">
            <span className="field__label">Command API key {credential.trim() ? "" : "(required)"}</span>
            <input
              className="input input--mono"
              type="password"
              autoComplete="off"
              value={credential}
              placeholder="ATLAS_COMMAND_API_KEY"
              onChange={(event) => onCredentialChange(event.target.value)}
            />
          </label>

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
  onChange
}: {
  name: string;
  schema: CommandParameterSchema;
  value: string;
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
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="field__hint">{[schema.description, bounds.join(", ")].filter(Boolean).join(" · ")}</span>
    </label>
  );
}
