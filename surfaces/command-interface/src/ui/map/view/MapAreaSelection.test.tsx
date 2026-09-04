import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MapArea } from "@the-drunken-coder/atlas-sdk";
import type { Map as MlMap } from "maplibre-gl";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { MapAreaSelection } from "./MapAreaSelection.js";
import type { MapSpatialInteraction } from "./MapView.js";
import { rect, renderMapView } from "./MapView.test-harness.js";

const selectedArea: MapArea = { west: 40, south: 50, east: 140, north: 120 };

describe("MapAreaSelection", () => {
  it("notifies before drawing mode and pointer geometry begin", () => {
    const mapCanvas = document.createElement("div");
    document.body.append(mapCanvas);
    vi.spyOn(mapCanvas, "getBoundingClientRect").mockReturnValue(rect(0, 0, 400, 200));
    const map = areaMap();
    const onBeginRegionInteraction = vi.fn();

    render(
      <MapAreaSelection
        mapCanvas={mapCanvas}
        map={map}
        mapReady
        area={null}
        drawing
        onAreaChange={vi.fn()}
        onDrawingComplete={vi.fn()}
        onCancelDrawing={vi.fn()}
        onBeginRegionInteraction={onBeginRegionInteraction}
        onViewportArea={vi.fn()}
        suppressNextClick={vi.fn()}
      />
    );

    expect(onBeginRegionInteraction).toHaveBeenCalledOnce();
    fireEvent.pointerDown(mapCanvas, { pointerId: 1, button: 0, clientX: 40, clientY: 40 });
    expect(onBeginRegionInteraction).toHaveBeenCalledTimes(2);
  });

  it("notifies before a keyboard transform that is rejected at the date line", async () => {
    const mapCanvas = document.createElement("div");
    document.body.append(mapCanvas);
    vi.spyOn(mapCanvas, "getBoundingClientRect").mockReturnValue(rect(0, 0, 400, 200));
    const map = areaMap();
    vi.mocked(map.unproject).mockImplementation((point: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      return { lng: x < 100 ? 179.8 : -179.8, lat: y } as unknown as ReturnType<MlMap["unproject"]>;
    });
    const onBeginRegionInteraction = vi.fn();

    render(
      <MapAreaSelection
        mapCanvas={mapCanvas}
        map={map}
        mapReady
        area={selectedArea}
        drawing={false}
        onAreaChange={vi.fn()}
        onDrawingComplete={vi.fn()}
        onCancelDrawing={vi.fn()}
        onBeginRegionInteraction={onBeginRegionInteraction}
        onViewportArea={vi.fn()}
        suppressNextClick={vi.fn()}
      />
    );

    fireEvent.keyDown(await screen.findByRole("button", { name: "Move selected area" }), { key: "ArrowRight" });
    expect(onBeginRegionInteraction).toHaveBeenCalledOnce();
  });

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
    map.getBounds.mockReturnValue({
      getWest: () => 179.8,
      getSouth: () => -10,
      getEast: () => -179.8,
      getNorth: () => 10
    });
    act(() => map.fire("moveend"));
    expect(spatial.onViewportArea).toHaveBeenLastCalledWith(null);

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

  it("rejects a date-line crossing instead of publishing a near-worldwide area", async () => {
    const spatial = interaction({ area: null, drawing: true });
    const { map } = renderMapView({ spatial });
    map.unproject.mockImplementation((point: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      return { lng: x < 160 ? 179.8 : -179.8, lat: y };
    });

    const prompt = await screen.findByText("Drag an area. Press Escape to cancel.");
    const surface = prompt.parentElement;
    if (!surface) throw new Error("Drawing surface is missing");
    fireEvent.pointerDown(surface, { pointerId: 13, button: 0, clientX: 60, clientY: 70 });
    fireEvent.pointerMove(window, { pointerId: 13, clientX: 200, clientY: 140 });
    fireEvent.pointerUp(window, { pointerId: 13, clientX: 200, clientY: 140 });

    expect(spatial.onAreaChange).not.toHaveBeenCalled();
    expect(spatial.onDrawingComplete).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent(/date-line crossings are not supported/i);
    expect(screen.getByText(/date-line crossings are not supported/i)).toBeInTheDocument();

    map.unproject.mockImplementation((point: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      return { lng: x, lat: y };
    });
    fireEvent.pointerDown(surface, { pointerId: 14, button: 0, clientX: 60, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 14, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 14, clientX: 100, clientY: 60 });

    expect(spatial.onAreaChange).toHaveBeenLastCalledWith({ west: 50, south: 0, east: 90, north: 40 });
    expect(spatial.onDrawingComplete).toHaveBeenCalledOnce();
  });

  it("leaves Shift-drag box zoom responsible for Escape while drawing is armed", async () => {
    const spatial = interaction({ area: null, drawing: true });
    const { canvas } = renderMapView({ spatial });
    const primaryHost = canvas.querySelector<HTMLElement>(".maplibre-host");
    if (!primaryHost) throw new Error("Primary map host is missing");

    await waitFor(() => expect(canvas).toHaveClass("map-canvas--region-drawing"));
    fireEvent.pointerDown(primaryHost, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 80,
      clientY: 80,
      shiftKey: true
    });
    fireEvent.mouseDown(primaryHost, { button: 0, clientX: 80, clientY: 80, shiftKey: true });

    expect(canvas.querySelector(".map-reticle--zoom")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(canvas.querySelector(".map-reticle--zoom")).not.toBeInTheDocument();
    expect(spatial.onCancelDrawing).not.toHaveBeenCalled();
  });

  it("releases a captured pointer and suppresses its click when drawing is canceled externally", async () => {
    const spatial = interaction({ area: null, drawing: true });
    const { canvas, onBackgroundClick, rerenderMap } = renderMapView({ spatial });
    let captured = false;
    const setPointerCapture = vi.fn(() => {
      captured = true;
    });
    const hasPointerCapture = vi.fn(() => captured);
    const releasePointerCapture = vi.fn(() => {
      captured = false;
    });
    Object.assign(canvas, { setPointerCapture, hasPointerCapture, releasePointerCapture });

    await waitFor(() => expect(canvas).toHaveClass("map-canvas--region-drawing"));
    fireEvent.pointerDown(canvas, { pointerId: 15, button: 0, clientX: 80, clientY: 70 });
    expect(setPointerCapture).toHaveBeenCalledWith(15);

    rerenderMap({ spatial: { ...spatial, drawing: false } });

    expect(releasePointerCapture).toHaveBeenCalledWith(15);
    fireEvent.click(canvas);
    expect(onBackgroundClick).not.toHaveBeenCalled();
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

function areaMap(): MlMap {
  return {
    on: vi.fn(),
    off: vi.fn(),
    stop: vi.fn(),
    project: vi.fn(([longitude, latitude]: [number, number]) => ({ x: longitude, y: latitude })),
    unproject: vi.fn((point: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      return { lng: x, lat: y };
    }),
    getBounds: vi.fn(() => ({
      getWest: () => -20,
      getSouth: () => -10,
      getEast: () => 20,
      getNorth: () => 10
    }))
  } as unknown as MlMap;
}
