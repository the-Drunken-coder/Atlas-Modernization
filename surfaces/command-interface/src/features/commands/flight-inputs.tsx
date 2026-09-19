import { Callout } from "@blueprintjs/core";
import { useState } from "react";
import {
  entityAltitude,
  entityLaunchElevation,
  entityTelemetryUpdatedAt,
  telemetryInputFresh
} from "../../atlas/entities.js";
import { Button, TextField } from "../../ui/primitives/controls.js";
import type { CommandInputFormProps } from "./command-input-registry.js";

function Shell({
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
  children?: React.ReactNode;
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

/**
 * Takeoff height is entered relative to launch and converted to meters above
 * mean sea level with verified launch elevation before Task creation. Without
 * a verified reference the host would reject the Task, so submission stays
 * disabled until the reference exists.
 */
export function TakeoffForm({ asset, submitting, error, onCancel, onSubmit }: CommandInputFormProps) {
  const launchElevation = entityLaunchElevation(asset);
  const [height, setHeight] = useState("");
  const heightM = Number.parseFloat(height);
  const heightValid = Number.isFinite(heightM) && heightM > 0 && heightM <= 120;
  const canSubmit = heightValid && launchElevation !== undefined;
  const targetMsl = canSubmit && launchElevation !== undefined ? launchElevation + heightM : undefined;

  return (
    <Shell
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
    </Shell>
  );
}

/**
 * Map go-to review: the chosen point alone never dispatches. The operator
 * reviews coordinates and an explicit mean-sea-level altitude, then submits.
 * Fresh aircraft altitude prefills the editable field; without fresh altitude
 * the operator must enter it explicitly.
 */
export function GotoForm({ asset, mapPoint, submitting, error, onCancel, onSubmit }: CommandInputFormProps) {
  const fresh = telemetryInputFresh(asset);
  const currentAltitude = entityAltitude(asset);
  const [altitude, setAltitude] = useState(fresh && currentAltitude !== undefined ? currentAltitude.toFixed(0) : "");
  const [prefilled] = useState(fresh && currentAltitude !== undefined);
  const altitudeM = Number.parseFloat(altitude);
  const altitudeValid = Number.isFinite(altitudeM) && altitudeM > -100 && altitudeM < 10000;
  const canSubmit = mapPoint !== undefined && altitudeValid;

  return (
    <Shell
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
    </Shell>
  );
}

function ConfirmForm({
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
    <Shell
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

export function ReturnToLaunchForm(props: Omit<CommandInputFormProps, "asset" | "command" | "mapPoint">) {
  return (
    <ConfirmForm
      {...props}
      title="Return to launch"
      hint="Return, land, and disarm for recovery. This interrupts any active takeoff or go-to and cannot be cancelled once started."
      submitLabel="Submit return to launch"
    />
  );
}

export function LandForm(props: Omit<CommandInputFormProps, "asset" | "command" | "mapPoint">) {
  return (
    <ConfirmForm
      {...props}
      title="Land"
      hint="Land at the current location and disarm. This interrupts any active takeoff or go-to and cannot be cancelled once started."
      submitLabel="Submit land"
    />
  );
}
