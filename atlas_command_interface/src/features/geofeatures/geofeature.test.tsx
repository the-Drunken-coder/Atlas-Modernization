import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { EntityResource } from "../../../../atlas_sdk/src/index.js";
import type { UiGeometry } from "../../atlas/geometry.js";
import { GeofeatureInspector } from "./GeofeatureInspector.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 3 };

const polygon: UiGeometry = {
  type: "Polygon",
  coordinates: [[[-74.2, 40.1], [-74.1, 40.1], [-74.1, 40.2], [-74.2, 40.2], [-74.2, 40.1]]]
};
const circle: UiGeometry = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [-74.2, 40.1] },
  properties: { shape: "circle", radius_m: 500 }
};

function geofeature(geometry: UiGeometry): EntityResource {
  return { entity_id: "geo-1", entity_type: "geofeature", subtype: null, alias: "Zone Alpha", components: { geometry }, metadata };
}

const noop = () => {};

describe("GeofeatureInspector", () => {
  it("starts an edit session from the inspector", async () => {
    const user = userEvent.setup();
    const onStartEdit = vi.fn();
    render(
      <GeofeatureInspector
        entity={geofeature(polygon)}
        editing={false}
        saving={false}
        onStartEdit={onStartEdit}
        onChangeDraft={noop}
        onSave={noop}
        onCancel={noop}
      />
    );
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(onStartEdit).toHaveBeenCalledTimes(1);
  });

  it("lists vertices and removes one while keeping the ring closed", async () => {
    const user = userEvent.setup();
    const onChangeDraft = vi.fn();
    render(
      <GeofeatureInspector
        entity={geofeature(polygon)}
        editing
        draft={polygon}
        saving={false}
        onStartEdit={noop}
        onChangeDraft={onChangeDraft}
        onSave={noop}
        onCancel={noop}
      />
    );

    // Four editable vertices (closing coordinate excluded).
    expect(screen.getByText("Vertex 1")).toBeInTheDocument();
    expect(screen.getByText("Vertex 4")).toBeInTheDocument();
    expect(screen.queryByText("Vertex 5")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove vertex 1" }));
    const next = onChangeDraft.mock.calls[0][0] as Extract<UiGeometry, { type: "Polygon" }>;
    expect(next.coordinates[0]).toHaveLength(4); // 3 distinct + closing
    expect(next.coordinates[0][0]).toEqual(next.coordinates[0][3]);
  });

  it("saves and cancels through the provided handlers", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(
      <GeofeatureInspector
        entity={geofeature(polygon)}
        editing
        draft={polygon}
        saving={false}
        onStartEdit={noop}
        onChangeDraft={noop}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("edits circle radius while preserving the circle Feature", async () => {
    const user = userEvent.setup();
    const onChangeDraft = vi.fn();
    function StatefulInspector() {
      const [draft, setDraft] = useState(circle);
      return (
        <GeofeatureInspector
          entity={geofeature(circle)}
          editing
          draft={draft}
          saving={false}
          onStartEdit={noop}
          onChangeDraft={(next) => {
            setDraft(next);
            onChangeDraft(next);
          }}
          onSave={noop}
          onCancel={noop}
        />
      );
    }

    render(<StatefulInspector />);

    const radius = screen.getByLabelText("Radius (m)");
    await user.clear(radius);
    await user.type(radius, "750");

    expect(onChangeDraft).toHaveBeenLastCalledWith({
      type: "Feature",
      geometry: { type: "Point", coordinates: [-74.2, 40.1] },
      properties: { shape: "circle", radius_m: 750 }
    });
    expect(screen.getByText("Center")).toBeInTheDocument();
  });
});
