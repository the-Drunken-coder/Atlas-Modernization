import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { MapArea } from "@the-drunken-coder/atlas-sdk";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MapSpatialInteraction } from "./MapView.js";
import { renderMapView } from "./MapView.test-harness.js";

const selectedArea: MapArea = { west: 40, south: 50, east: 140, north: 120 };

describe("MapAreaSelection", () => {
  it("publishes the viewport and draws a map area with pointer input", async () => {
    const spatial = interaction({ area: null, drawing: true });
    const { canvas, map, rerenderMap } = renderMapView({ spatial });

    await waitFor(() =>
      expect(spatial.onViewportArea).toHaveBeenCalledWith({
        west: -20,
        south: -10,
        east: 20,
        north: 10
      })
    );
    vi.mocked(spatial.onViewportArea).mockClear();
    act(() => map.fire("moveend"));
    expect(spatial.onViewportArea).toHaveBeenCalledOnce();

    await waitFor(() => expect(canvas).toHaveClass("map-canvas--region-drawing"));
    fireEvent.pointerDown(canvas, {
      button: 0,
      pointerId: 7,
      clientX: 60,
      clientY: 70
    });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 150, clientY: 140 });
    expect(document.querySelector(".map-region-selection__drawing-region")).toBeInTheDocument();
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 150, clientY: 140 });

    expect(spatial.onAreaChange).toHaveBeenLastCalledWith({
      west: 50,
      south: 50,
      east: 140,
      north: 120
    });
    expect(spatial.onDrawingComplete).toHaveBeenCalledOnce();
    map.queryRenderedFeatures.mockClear();
    map.queryRenderedFeatures.mockReturnValue([
      {
        geometry: { type: "Polygon", coordinates: [] },
        properties: { featureId: "old-result" }
      }
    ]);
    fireEvent.click(canvas, { clientX: 150, clientY: 140 });
    expect(spatial.onSelectFeature).not.toHaveBeenCalled();
    expect(map.queryRenderedFeatures).not.toHaveBeenCalled();

    rerenderMap({ spatial: { ...spatial, drawing: false } });
    rerenderMap({ spatial: { ...spatial, drawing: true } });
    await waitFor(() => expect(canvas).toHaveClass("map-canvas--region-drawing"));
    fireEvent.pointerDown(canvas, {
      button: 0,
      pointerId: 8,
      clientX: 60,
      clientY: 70
    });
    fireEvent.pointerUp(canvas, { pointerId: 8, clientX: 70, clientY: 80 });
    expect(spatial.onCancelDrawing).toHaveBeenCalledOnce();

    rerenderMap({ spatial: { ...spatial, drawing: false } });
    rerenderMap({ spatial: { ...spatial, drawing: true } });
    await waitFor(() => expect(canvas).toHaveClass("map-canvas--region-drawing"));
    fireEvent.pointerDown(canvas, {
      button: 0,
      pointerId: 9,
      clientX: 80,
      clientY: 90
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(spatial.onCancelDrawing).toHaveBeenCalledTimes(2);
  });

  it("moves and resizes an existing area with pointer and keyboard input", async () => {
    const spatial = interaction({ area: selectedArea, drawing: false });
    const { canvas, map } = renderMapView({ spatial });
    act(() => map.fire("resize"));

    const move = await screen.findByRole("button", {
      name: "Move selected area"
    });
    const resizeWidth = screen.getByRole("button", {
      name: "Resize selected area width"
    });
    const resizeHeight = screen.getByRole("button", {
      name: "Resize selected area height"
    });
    const resizeBoth = screen.getByRole("button", {
      name: "Resize selected area width and height"
    });

    fireEvent.keyDown(move, { key: "ArrowRight" });
    expect(spatial.onAreaChange).toHaveBeenLastCalledWith({
      west: 50,
      south: 50,
      east: 150,
      north: 120
    });
    fireEvent.keyDown(resizeWidth, { key: "ArrowRight", shiftKey: true });
    expect(spatial.onAreaChange).toHaveBeenLastCalledWith({
      west: 40,
      south: 50,
      east: 180,
      north: 120
    });
    fireEvent.keyDown(resizeHeight, { key: "ArrowDown" });
    expect(spatial.onAreaChange).toHaveBeenLastCalledWith({
      west: 40,
      south: 50,
      east: 140,
      north: 130
    });
    fireEvent.keyDown(resizeBoth, { key: "Enter" });
    expect(spatial.onAreaChange).toHaveBeenCalledTimes(3);

    fireEvent.pointerDown(move, {
      button: 0,
      pointerId: 11,
      clientX: 50,
      clientY: 60
    });
    fireEvent.pointerMove(window, { pointerId: 11, clientX: 80, clientY: 100 });
    expect(spatial.onAreaChange).toHaveBeenLastCalledWith({
      west: 70,
      south: 90,
      east: 170,
      north: 160
    });
    fireEvent.pointerUp(canvas, { pointerId: 11, clientX: 80, clientY: 100 });

    fireEvent.pointerDown(resizeBoth, {
      button: 0,
      pointerId: 12,
      clientX: 140,
      clientY: 120
    });
    fireEvent.pointerMove(window, { pointerId: 12, clientX: 110, clientY: 90 });
    expect(spatial.onAreaChange).toHaveBeenLastCalledWith({
      west: 40,
      south: 50,
      east: 110,
      north: 90
    });
    fireEvent.pointerCancel(window, { pointerId: 12 });
    expect(spatial.onAreaChange).toHaveBeenLastCalledWith(selectedArea);
  });

  it("skips spatial hit testing while result layers are absent", () => {
    const spatial = interaction({ area: null, drawing: false });
    const { canvas, map, onBackgroundClick } = renderMapView({ spatial });
    map.layers.delete("spatial-results-fill");
    map.layers.delete("spatial-results-line");
    map.queryRenderedFeatures.mockImplementation((_point, options) => {
      const layers = (options as { layers?: string[] } | undefined)?.layers ?? [];
      if (layers.some((layer) => layer.startsWith("spatial-results"))) throw new Error("missing layer");
      return [];
    });

    fireEvent.click(canvas, { clientX: 100, clientY: 100 });

    expect(spatial.onSelectFeature).not.toHaveBeenCalled();
    expect(onBackgroundClick).toHaveBeenCalledOnce();
  });
});

function interaction(overrides: Partial<MapSpatialInteraction>): MapSpatialInteraction {
  return {
    area: selectedArea,
    drawing: false,
    features: [],
    onAreaChange: vi.fn(),
    onDrawingComplete: vi.fn(),
    onCancelDrawing: vi.fn(),
    onViewportArea: vi.fn(),
    onSelectFeature: vi.fn(),
    ...overrides
  };
}
