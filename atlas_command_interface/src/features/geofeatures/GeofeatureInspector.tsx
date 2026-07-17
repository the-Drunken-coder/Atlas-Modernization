import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { entityClassification, entityDisplayName, entityGeometry } from "../../atlas/entities.js";
import {
  canRemoveVertex,
  formatCoordinate,
  geometrySummary,
  geometryVertices,
  isCircleFeature,
  removeVertex,
  type UiGeometry,
  updateCircleRadius,
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
            {editing ? (
              <>
                {isCircleFeature(geometry) ? <CircleEditor geometry={geometry} onChange={onChangeDraft} /> : null}
                <VertexEditor geometry={geometry} onChange={onChangeDraft} validity={validity} />
              </>
            ) : null}
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
          <div className="banner banner--error" style={{ marginTop: 8 }}>
            {saveError}
          </div>
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
      {!validity?.valid && validity?.reason ? <div className="banner banner--error">{validity.reason}</div> : null}
      {vertices.map((vertex, index) => {
        const removable = canRemoveVertex(geometry, vertex.ref);
        return (
          <div key={index} className="task-row" style={{ border: "1px solid var(--border)", borderRadius: 6 }}>
            <span className="task-row__main">
              <span className="task-row__title">{isCircle ? "Center" : `Vertex ${index + 1}`}</span>
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
        );
      })}
      <p className="field__hint">
        {isCircle
          ? "Drag the center point on the map to move the circle."
          : "Drag vertices on the map to reshape. Click a mid-point handle to add one."}
      </p>
    </div>
  );
}
