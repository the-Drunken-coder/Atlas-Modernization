import { Callout } from "@blueprintjs/core";
import { type ReactNode, useState } from "react";
import {
  entityAltitude,
  entityLaunchElevation,
  entityTelemetryUpdatedAt,
  telemetryInputFresh
} from "../../atlas/entities.js";
import { Button, TextField } from "../../ui/primitives/controls.js";
import type { CommandInputFormProps } from "./command-input-registry.js";

function CommandFormShell({
  title,
  hint,
  submitting,
  error,
  canSubmit,
  submitLabel,
  onCancel,
  onSubmit,
  children
}: {
  title: string;
  hint: string;
  submitting: boolean;
  error?: string;
  canSubmit: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: () => void;
  children?: ReactNode;
}) {
  return (
    <form
      className="command-form"
      aria-label={title}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !submitting) onSubmit();
      }}
    >
      <h3>{title}</h3>
      <p className="command-form__hint">{hint}</p>
      {children}
      {error ? (
        <Callout intent="danger" icon={null} role="alert">
          {error}
        </Callout>
      ) : null}
      <div className="command-form__actions">
        <Button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit || submitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function TakeoffForm({ asset, submitting, error, onCancel, onSubmit }: CommandInputFormProps) {
  const launchElevation = entityLaunchElevation(asset);
  const [height, setHeight] = useState("");
  const heightM = Number.parseFloat(height);
  const heightValid = Number.isFinite(heightM) && heightM > 0;
  const canSubmit = heightValid && launchElevation !== undefined;
  const targetMsl = canSubmit && launchElevation !== undefined ? launchElevation + heightM : undefined;

  return (
    <CommandFormShell
      title="Takeoff"
      hint="Climb an already-armed aircraft to the requested height and settle into a hover. Atlas never arms."
      submitting={submitting}
      error={error}
      canSubmit={canSubmit}
      submitLabel="Submit takeoff"
      onCancel={onCancel}
      onSubmit={() => {
        if (targetMsl !== undefined) onSubmit({ altitude_m: targetMsl });
      }}
    >
      <TextField
        label="Height above launch (m)"
        hint="Relative to launch; converted to mean sea level before tasking."
        inputMode="decimal"
        value={height}
        onChange={(event) => setHeight(event.target.value)}
        disabled={submitting}
      />
      <p className="command-form__reference">
        {launchElevation === undefined
          ? "Launch elevation is not verified yet; takeoff stays unavailable until telemetry stabilizes."
          : targetMsl === undefined
            ? `Launch elevation ${launchElevation.toFixed(1)} m above mean sea level.`
            : `Target ${targetMsl.toFixed(1)} m above mean sea level (launch ${launchElevation.toFixed(1)} m).`}
      </p>
    </CommandFormShell>
  );
}

export function GotoForm({ asset, mapPoint, submitting, error, onCancel, onSubmit }: CommandInputFormProps) {
  const fresh = telemetryInputFresh(asset);
  const currentAltitude = entityAltitude(asset);
  const [altitude, setAltitude] = useState(fresh && currentAltitude !== undefined ? String(currentAltitude) : "");
  const [prefilled] = useState(fresh && currentAltitude !== undefined);
  const altitudeM = Number.parseFloat(altitude);
  const altitudeValid = Number.isFinite(altitudeM);
  const canSubmit = mapPoint !== undefined && altitudeValid;

  return (
    <CommandFormShell
      title="Go to"
      hint="Fly to the destination and hold position. A new go-to replaces the active one."
      submitting={submitting}
      error={error}
      canSubmit={canSubmit}
      submitLabel="Submit go-to"
      onCancel={onCancel}
      onSubmit={() => {
        if (mapPoint !== undefined && altitudeValid) {
          onSubmit({ latitude: mapPoint.lat, longitude: mapPoint.lng, altitude_m: altitudeM });
        }
      }}
    >
      <p className="command-form__reference">
        {mapPoint === undefined
          ? "No destination point."
          : `Destination ${mapPoint.lat.toFixed(5)}, ${mapPoint.lng.toFixed(5)}.`}
      </p>
      <TextField
        label="Altitude (meters above mean sea level)"
        hint={
          prefilled
            ? `Prefilled from fresh aircraft telemetry (${entityTelemetryUpdatedAt(asset) ?? "recent"}).`
            : "No fresh aircraft altitude; enter the destination height explicitly."
        }
        inputMode="decimal"
        value={altitude}
        onChange={(event) => setAltitude(event.target.value)}
        disabled={submitting}
      />
    </CommandFormShell>
  );
}

function ConfirmCommandForm({
  title,
  hint,
  submitLabel,
  submitting,
  error,
  onCancel,
  onSubmit
}: Omit<CommandInputFormProps, "asset" | "command" | "mapPoint"> & {
  title: string;
  hint: string;
  submitLabel: string;
}) {
  return (
    <CommandFormShell
      title={title}
      hint={hint}
      submitting={submitting}
      error={error}
      canSubmit
      submitLabel={submitLabel}
      onCancel={onCancel}
      onSubmit={() => onSubmit({})}
    />
  );
}

export function ReturnToLaunchForm(props: CommandInputFormProps) {
  return (
    <ConfirmCommandForm
      submitting={props.submitting}
      error={props.error}
      onCancel={props.onCancel}
      onSubmit={props.onSubmit}
      title="Return to launch"
      hint="Return, land, and disarm for recovery. This interrupts any active takeoff or go-to and cannot be cancelled once started."
      submitLabel="Submit return to launch"
    />
  );
}

export function LandForm(props: CommandInputFormProps) {
  return (
    <ConfirmCommandForm
      submitting={props.submitting}
      error={props.error}
      onCancel={props.onCancel}
      onSubmit={props.onSubmit}
      title="Land"
      hint="Land at the current location and disarm. This interrupts any active takeoff or go-to and cannot be cancelled once started."
      submitLabel="Submit land"
    />
  );
}
