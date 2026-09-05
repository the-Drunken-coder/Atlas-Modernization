import { Callout } from "@blueprintjs/core";
import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { useEffect, useState } from "react";
import { entityClassification, entityDisplayName, entityGeometry } from "../../atlas/entities.js";
import {
  addVertexAfter,
  canRemoveVertex,
  formatCoordinate,
  geometrySummary,
  geometryVertices,
  isCircleFeature,
  midpointPosition,
  moveVertex,
  type Position,
  removeVertex,
  type UiGeometry,
  updateCircleRadius,
  type VertexRef,
  validateGeometry
} from "../../atlas/geometry.js";
import { Button, IconButton, TextField } from "../../ui/primitives/controls.js";
import { TrashIcon } from "../../ui/primitives/icons.js";
import { JsonDrawer } from "../../ui/primitives/JsonDrawer.js";
import { ClassificationPill } from "../../ui/primitives/StatusPill.js";
import { FieldGrid, InspectorHeading, Section } from "../shared/panels.js";

export type GeofeatureInspectorProps = {
  entity: EntityResource;
  editing: boolean;
  draft?: UiGeometry;
  saving: boolean;
  saveError?: string;
  onStartEdit: () => void;
  onChangeDraft: (geometry: UiGeometry) => void;
  onSave: () => void;
  onCancel: () => void;
};

export function GeofeatureInspector(props: GeofeatureInspectorProps) {
  const { entity, editing, draft, saving, saveError, onStartEdit, onChangeDraft, onSave, onCancel } = props;
  const classification = entityClassification(entity);
  const geometry = editing ? draft : entityGeometry(entity);
  const validity = geometry ? validateGeometry(geometry) : undefined;

  return (
    <div className="inspector">
      <InspectorHeading name={entityDisplayName(entity)} id={entity.entity_id} />

      <Section
        title="Geometry"
        actions={
          editing ? null : (
            <Button variant="ghost" onClick={onStartEdit} disabled={!geometry}>
              Edit
            </Button>
          )
        }
      >
        {geometry ? (
          <>
            <FieldGrid
              rows={[
                ["Type", geometry.type],
                ["Summary", geometrySummary(geometry)]
              ]}
            />
            {editing ? <GeometryFields geometry={geometry} onChange={onChangeDraft} /> : null}
          </>
        ) : (
          <div style={{ color: "var(--text-3)" }}>No editable geometry</div>
        )}

        {editing ? (
          <div className="row-actions" style={{ marginTop: 12 }}>
            <Button variant="primary" onClick={onSave} disabled={saving || !validity?.valid}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        ) : null}
        {saveError ? (
          <Callout className="banner banner--error" intent="danger" icon={null} compact style={{ marginTop: 8 }}>
            {saveError}
          </Callout>
        ) : null}
      </Section>

      <Section title="Classification">
        {classification ? (
          <ClassificationPill value={classification} />
        ) : (
          <span style={{ color: "var(--text-3)" }}>Unclassified</span>
        )}
      </Section>

      <JsonDrawer title="Raw entity JSON" value={entity} />
    </div>
  );
}

export function GeometryFields({
  geometry,
  onChange
}: {
  geometry: UiGeometry;
  onChange: (geometry: UiGeometry) => void;
}) {
  return (
    <>
      {isCircleFeature(geometry) ? <CircleEditor geometry={geometry} onChange={onChange} /> : null}
      <VertexEditor geometry={geometry} onChange={onChange} validity={validateGeometry(geometry)} />
    </>
  );
}

function CircleEditor({
  geometry,
  onChange
}: {
  geometry: Extract<UiGeometry, { type: "Feature" }>;
  onChange: (geometry: UiGeometry) => void;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <TextField
        label="Radius (m)"
        type="number"
        min={1}
        step={1}
        value={String(geometry.properties.radius_m)}
        onChange={(event) => onChange(updateCircleRadius(geometry, Number(event.target.value)))}
      />
    </div>
  );
}

function VertexEditor({
  geometry,
  onChange,
  validity
}: {
  geometry: UiGeometry;
  onChange: (geometry: UiGeometry) => void;
  validity?: { valid: boolean; reason?: string };
}) {
  const vertices = geometryVertices(geometry);
  const isCircle = isCircleFeature(geometry);
  return (
    <div className="stack" style={{ marginTop: 8 }}>
      {!validity?.valid && validity?.reason ? (
        <Callout className="banner banner--error" intent="danger" icon={null} compact>
          {validity.reason}
        </Callout>
      ) : null}
      {vertices.map((vertex, index) => {
        const removable = canRemoveVertex(geometry, vertex.ref);
        const title = isCircle ? "Center" : `Vertex ${index + 1}`;
        const segment = segmentAfter(geometry, vertex.ref);
        return (
          <div key={vertexKey(vertex.ref)} className="geometry-vertex">
            <div className="task-row">
              <span className="task-row__main">
                <span className="task-row__title">{title}</span>
                <span className="task-row__sub">{formatCoordinate([vertex.lng, vertex.lat])}</span>
              </span>
              <IconButton
                label={`Remove vertex ${index + 1}`}
                disabled={!removable}
                onClick={() => {
                  const next = removeVertex(geometry, vertex.ref);
                  if (next) onChange(next);
                }}
              >
                <TrashIcon size={15} />
              </IconButton>
            </div>
            <div className="geometry-coordinate-fields">
              <CoordinateField
                label={`${title} longitude`}
                value={vertex.lng}
                min={-180}
                max={180}
                onCommit={(lng) => onChange(moveVertex(geometry, vertex.ref, lng, vertex.lat))}
              />
              <CoordinateField
                label={`${title} latitude`}
                value={vertex.lat}
                min={-90}
                max={90}
                onCommit={(lat) => onChange(moveVertex(geometry, vertex.ref, vertex.lng, lat))}
              />
            </div>
            {segment ? (
              <Button
                variant="ghost"
                onClick={() => onChange(addVertexAfter(geometry, vertex.ref, midpointPosition(...segment)))}
              >
                Add vertex after {index + 1}
              </Button>
            ) : null}
          </div>
        );
      })}
      <p className="field__hint">
        {isCircle
          ? "Enter center coordinates here or drag the center point on the map."
          : "Enter coordinates and add vertices here, or use the map handles."}
      </p>
    </div>
  );
}

function CoordinateField({
  label,
  value,
  min,
  max,
  onCommit
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string>();
  useEffect(() => {
    setDraft(String(value));
    setError(undefined);
  }, [value]);

  const commit = () => {
    const next = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(next) || next < min || next > max) {
      setError(`Enter a number from ${min} to ${max}.`);
      return;
    }
    setError(undefined);
    if (next !== value) onCommit(next);
  };

  return (
    <TextField
      label={label}
      type="number"
      min={min}
      max={max}
      step="any"
      value={draft}
      hint={error}
      aria-invalid={error ? true : undefined}
      onChange={(event) => {
        setDraft(event.target.value);
        setError(undefined);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setDraft(String(value));
          setError(undefined);
        }
      }}
    />
  );
}

function segmentAfter(geometry: UiGeometry, ref: VertexRef): [Position, Position] | undefined {
  if (geometry.type === "LineString" && ref.kind === "LineString") {
    const current = geometry.coordinates[ref.index];
    const next = geometry.coordinates[ref.index + 1];
    return current && next ? [current, next] : undefined;
  }
  if (geometry.type === "Polygon" && ref.kind === "Polygon") {
    const ring = geometry.coordinates[ref.ring];
    if (!ring || ring.length < 2) return undefined;
    const openLength = positionsEqual(ring[0], ring[ring.length - 1]) ? ring.length - 1 : ring.length;
    const current = ring[ref.index];
    const next = ring[(ref.index + 1) % openLength];
    return current && next ? [current, next] : undefined;
  }
  return undefined;
}

function positionsEqual(a: Position | undefined, b: Position | undefined): boolean {
  return !!a && !!b && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function vertexKey(ref: VertexRef): string {
  if (ref.kind === "Polygon") return `${ref.kind}-${ref.ring}-${ref.index}`;
  if (ref.kind === "LineString") return `${ref.kind}-${ref.index}`;
  return ref.kind;
}
