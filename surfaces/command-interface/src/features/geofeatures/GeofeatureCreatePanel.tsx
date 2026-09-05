import { Callout } from "@blueprintjs/core";
import { geometrySummary } from "../../atlas/geometry.js";
import { Button, TextField } from "../../ui/primitives/controls.js";
import { GeometryFields } from "./GeofeatureInspector.js";
import type { DrawingShape, GeofeatureCreation } from "./use-geofeature-create.js";

const shapes: { value: DrawingShape; label: string }[] = [
  { value: "Point", label: "Point" },
  { value: "LineString", label: "Line" },
  { value: "Polygon", label: "Polygon" },
  { value: "Circle", label: "Circle" }
];

export function GeofeatureCreatePanel({ creation }: { creation: GeofeatureCreation }) {
  const { draft, saving, error } = creation;
  if (!draft) return null;
  return (
    <form
      className="geofeature-create"
      onSubmit={(event) => {
        event.preventDefault();
        void creation.save();
      }}
    >
      <fieldset disabled={saving}>
        <TextField
          label="Name"
          autoFocus
          value={draft.name}
          onChange={(event) => creation.setName(event.target.value)}
        />
        <div role="group" aria-label="Geometry type" className="geofeature-create__shapes">
          {shapes.map((shape) => (
            <Button
              key={shape.value}
              aria-pressed={draft.shape === shape.value}
              variant={draft.shape === shape.value ? "primary" : "default"}
              onClick={() => creation.redraw(shape.value)}
            >
              {shape.label}
            </Button>
          ))}
        </div>
        {draft.drawing ? (
          <>
            <p role="status">
              {draft.shape === "Circle"
                ? "Click the map to place the center, then set the radius."
                : draft.shape === "Point"
                  ? "Click the map to place the point."
                  : "Click the map to add vertices, then finish drawing."}
            </p>
            {draft.geometry ? <p className="field__hint">{geometrySummary(draft.geometry)}</p> : null}
            {draft.shape === "LineString" || draft.shape === "Polygon" ? (
              <Button disabled={!creation.canFinish} onClick={creation.finish}>
                Finish drawing
              </Button>
            ) : null}
          </>
        ) : draft.geometry ? (
          <>
            <p>{geometrySummary(draft.geometry)}</p>
            <Button onClick={() => creation.redraw(draft.shape)}>Redraw</Button>
            <GeometryFields geometry={draft.geometry} onChange={creation.changeGeometry} />
          </>
        ) : null}
        <div className="row-actions">
          <Button type="submit" variant="primary" disabled={!creation.canSave || saving}>
            {saving ? "Creating…" : "Create feature"}
          </Button>
          <Button variant="ghost" onClick={creation.cancel}>
            Cancel
          </Button>
        </div>
      </fieldset>
      {error ? (
        <Callout intent="danger" icon={null} role="alert">
          {error}
        </Callout>
      ) : null}
    </form>
  );
}
