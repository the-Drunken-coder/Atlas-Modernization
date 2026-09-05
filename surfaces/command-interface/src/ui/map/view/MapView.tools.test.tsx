import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { UiGeometry } from "../../../atlas/geometry.js";
import type { MapSpatialInteraction } from "./MapView.js";
import { renderMapView, style } from "./MapView.test-harness.js";

const editingGeometry: UiGeometry = {
  type: "LineString",
  coordinates: [
    [-74.2, 40.1],
    [-74.1, 40.2]
  ]
};

describe("MapView map-tool ownership", () => {
  it("pauses edit handles and restores the same draft around spatial drawing", async () => {
    const spatial = spatialInteraction({ area: null, drawing: false });
    const editing = { geometry: editingGeometry, onChange: vi.fn() };
    const { canvas, map, rerenderMap } = renderMapView({ editing, spatial });

    await waitFor(() => expect(canvas.querySelectorAll(".vertex-handle")).toHaveLength(3));

    rerenderMap({ spatial: { ...spatial, drawing: true } });
    await waitFor(() => expect(canvas.querySelectorAll(".vertex-handle")).toHaveLength(0));
    expect(editingSource(map).setData).toHaveBeenLastCalledWith({ type: "FeatureCollection", features: [] });

    rerenderMap({ spatial: { ...spatial, drawing: false } });
    await waitFor(() => expect(canvas.querySelectorAll(".vertex-handle")).toHaveLength(3));
    expect(editingSource(map).setData).toHaveBeenLastCalledWith({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: editingGeometry, properties: {} }]
    });
    expect(editing.onChange).not.toHaveBeenCalled();
  });

  it("keeps spatial drawing active while edit handles are paused", async () => {
    const spatial = spatialInteraction({ area: null, drawing: true });
    const editing = { geometry: editingGeometry, onChange: vi.fn() };
    const { canvas } = renderMapView({ editing, spatial });

    await waitFor(() => {
      expect(canvas).toHaveClass("map-canvas--region-drawing");
      expect(canvas.querySelectorAll(".vertex-handle")).toHaveLength(0);
    });

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 60, clientY: 70 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 150, clientY: 140 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 150, clientY: 140 });

    expect(spatial.onAreaChange).toHaveBeenCalledWith({ west: 50, south: 50, east: 140, north: 120 });
    expect(spatial.onDrawingComplete).toHaveBeenCalledOnce();
    expect(editing.onChange).not.toHaveBeenCalled();
  });

  it("does not restore the edit overlay when a style reload completes during drawing", async () => {
    const spatial = spatialInteraction({ area: null, drawing: true });
    const editing = { geometry: editingGeometry, onChange: vi.fn() };
    const { map, rerenderMap } = renderMapView({ editing, spatial });

    await waitFor(() =>
      expect(editingSource(map).setData).toHaveBeenLastCalledWith({ type: "FeatureCollection", features: [] })
    );

    rerenderMap({ styleId: "reloaded-style", style: style("reloaded-style") });
    await waitFor(() => expect(map.setStyle).toHaveBeenCalledOnce());
    act(() => map.fire("style.load"));

    expect(editingSource(map).setData).toHaveBeenLastCalledWith({ type: "FeatureCollection", features: [] });
  });
});

function spatialInteraction(overrides: Partial<MapSpatialInteraction>): MapSpatialInteraction {
  return {
    area: null,
    drawing: false,
    features: [],
    onAreaChange: vi.fn(),
    onDrawingComplete: vi.fn(),
    onCancelDrawing: vi.fn(),
    onViewportArea: vi.fn(),
    onSelectFeature: vi.fn(),
    onBoxZoomActiveChange: vi.fn(),
    ...overrides
  };
}

function editingSource(map: ReturnType<typeof renderMapView>["map"]) {
  const source = map.getSource("editing");
  if (!source) throw new Error("Editing source is missing");
  return source;
}
