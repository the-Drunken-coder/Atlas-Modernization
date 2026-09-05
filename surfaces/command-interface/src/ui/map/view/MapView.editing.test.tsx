import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UiGeometry } from "../../../atlas/geometry.js";
import { dragMarker, markerCoordinatesFor, renderMapView } from "./MapView.test-harness.js";

describe("MapView geometry editing", () => {
  it("draws normalized coordinates without selecting entities or opening map commands", async () => {
    const onPoint = vi.fn();
    const { map, onSelectEntity, onBackgroundClick, onMapContextMenu } = renderMapView({ drawing: { onPoint } });
    await waitFor(() => expect(map.getSource("editing")).toBeDefined());
    vi.spyOn(map, "unproject").mockReturnValue({ lng: 289, lat: 42 });
    const drawing = screen.getByTestId("geofeature-drawing");
    fireEvent.click(drawing, { clientX: 80, clientY: 90 });
    fireEvent.contextMenu(drawing);
    expect(onPoint).toHaveBeenCalledExactlyOnceWith([-71, 42]);
    expect(onSelectEntity).not.toHaveBeenCalled();
    expect(onBackgroundClick).not.toHaveBeenCalled();
    expect(onMapContextMenu).not.toHaveBeenCalled();
  });

  it("delivers zoom gestures to MapLibre while retaining the polygon draft", async () => {
    const onPoint = vi.fn();
    const geometry: UiGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [-71, 42],
          [-70, 42],
          [-70, 43],
          [-71, 42]
        ]
      ]
    };
    const { map } = renderMapView({ drawing: { onPoint }, editing: { geometry, onChange: vi.fn(), readOnly: true } });
    const drawing = await screen.findByTestId("geofeature-drawing");
    const nativeWheel = vi.fn();
    map.getCanvasContainer().addEventListener("wheel", nativeWheel);
    fireEvent.wheel(drawing, { deltaY: -120, bubbles: true });
    fireEvent.wheel(drawing, { deltaY: 120, bubbles: true });
    fireEvent.wheel(drawing, { deltaY: -20, ctrlKey: true, bubbles: true });
    expect(nativeWheel).toHaveBeenCalledTimes(3);
    expect(onPoint).not.toHaveBeenCalled();
    expect(map.getSource("editing")?.setData).toHaveBeenLastCalledWith({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry, properties: {} }]
    });
    fireEvent.click(drawing, { clientX: 80, clientY: 90 });
    expect(onPoint).toHaveBeenCalledTimes(1);
    map.getCanvasContainer().removeEventListener("wheel", nativeWheel);
  });

  it("previews the next polygon edges without placing a point and closes at the first vertex", async () => {
    const onPoint = vi.fn();
    const onClose = vi.fn();
    const { map } = renderMapView({
      drawing: {
        onPoint,
        onClose,
        polygon: true,
        points: [
          [10, 20],
          [30, 40],
          [50, 60]
        ]
      }
    });
    const drawing = await screen.findByTestId("geofeature-drawing");
    fireEvent.pointerMove(drawing, { clientX: 100, clientY: 110 });
    await waitFor(() => expect(drawing.querySelector("polyline")?.getAttribute("points")).toBe("50,60 100,110 10,20"));
    expect(onPoint).not.toHaveBeenCalled();
    vi.spyOn(map, "project").mockImplementation(() => ({ x: 70, y: 80 }));
    act(() => map.fire("move"));
    expect(drawing.querySelector("polyline")?.getAttribute("points")).toBe("70,80 100,110 70,80");
    fireEvent.click(screen.getByRole("button", { name: "Close polygon" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPoint).not.toHaveBeenCalled();
    fireEvent.pointerLeave(drawing);
    expect(drawing.querySelector("polyline")?.getAttribute("points")).toBe("");
  });

  it("shows draft geometry without edit handles while drawing or saving", async () => {
    const geometry: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-71, 42],
        [-70, 43]
      ]
    };
    const { map } = renderMapView({ editing: { geometry, onChange: vi.fn(), readOnly: true } });
    await waitFor(() => expect(map.getSource("editing")?.setData).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Add vertex" })).not.toBeInTheDocument();
    expect(document.querySelector(".vertex-handle")).toBeNull();
  });

  it("renders a point without interactive handles while drawing, undoing, or saving", async () => {
    const geometry: UiGeometry = { type: "Point", coordinates: [-71, 42] };
    const { map } = renderMapView({ editing: { geometry, onChange: vi.fn(), readOnly: true } });
    await waitFor(() => expect(map.getSource("editing")?.setData).toHaveBeenCalled());
    expect(map.getLayer("editing-point")).toMatchObject({
      type: "circle",
      source: "editing",
      filter: ["==", ["geometry-type"], "Point"]
    });
    expect(map.getSource("editing")?.setData).toHaveBeenLastCalledWith({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry, properties: {} }]
    });
    expect(document.querySelector(".vertex-handle")).toBeNull();
  });

  it("moves both polygon edges and their midpoint handles during a vertex drag", async () => {
    const onChange = vi.fn();
    const geometry: UiGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [-71, 42],
          [-70, 42],
          [-70, 43],
          [-71, 42]
        ]
      ]
    };
    const editing = { geometry, onChange };
    const { map, rerenderMap } = renderMapView({ editing });
    await screen.findAllByRole("button", { name: "Add vertex" });
    const vertex = document.querySelector<HTMLElement>(".vertex-handle:not(.vertex-handle--mid)")!;
    const midpointHandles = screen.getAllByRole("button", { name: "Add vertex" });
    for (const position of [
      [-72, 41],
      [-73, 40]
    ] as [number, number][]) {
      dragMarker(vertex, position, "drag");
      expect(map.getSource("editing")?.setData).toHaveBeenLastCalledWith({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Polygon", coordinates: [[position, [-70, 42], [-70, 43], position]] }
          }
        ]
      });
      expect(markerCoordinatesFor(midpointHandles[0])).toEqual([(position[0] - 70) / 2, (position[1] + 42) / 2]);
      expect(markerCoordinatesFor(midpointHandles[2])).toEqual([(position[0] - 70) / 2, (position[1] + 43) / 2]);
      expect(vertex.isConnected).toBe(true);
      expect(onChange).not.toHaveBeenCalled();
    }
    rerenderMap({ editing });
    expect(document.querySelector(".vertex-handle")).toBe(vertex);
    dragMarker(vertex, [-73, 40], "dragend");
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      type: "Polygon",
      coordinates: [
        [
          [-73, 40],
          [-70, 42],
          [-70, 43],
          [-73, 40]
        ]
      ]
    });
  });

  it("renders midpoint actions as keyboard-operable buttons", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const geometry: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2]
      ]
    };

    renderMapView({ editing: { geometry, onChange } });

    const addVertex = await screen.findByRole("button", { name: "Add vertex" });
    addVertex.focus();
    await user.keyboard("{Enter}");

    const next = onChange.mock.lastCall?.[0] as Extract<UiGeometry, { type: "LineString" }>;
    expect(next.coordinates).toHaveLength(3);
    expect(next.coordinates[1][0]).toBeCloseTo(-74.15);
    expect(next.coordinates[1][1]).toBeCloseTo(40.15);
  });

  it("keeps handles when only the editing wrapper changes and uses the latest callback", async () => {
    const user = userEvent.setup();
    const firstOnChange = vi.fn();
    const latestOnChange = vi.fn();
    const geometry: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2]
      ]
    };

    const rendered = renderMapView({ editing: { geometry, onChange: firstOnChange } });
    await screen.findByRole("button", { name: "Add vertex" });
    const originalHandles = [...rendered.canvas.querySelectorAll(".vertex-handle")];

    rendered.rerenderMap({ editing: { geometry, onChange: latestOnChange } });

    const currentHandles = [...rendered.canvas.querySelectorAll(".vertex-handle")];
    expect(currentHandles).toHaveLength(originalHandles.length);
    currentHandles.forEach((handle, index) => expect(handle).toBe(originalHandles[index]));

    await user.click(screen.getByRole("button", { name: "Add vertex" }));
    expect(firstOnChange).not.toHaveBeenCalled();
    expect(latestOnChange).toHaveBeenCalledOnce();
  });

  it("reconciles handles when the geometry changes and when editing ends", async () => {
    const onChange = vi.fn();
    const geometry: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2]
      ]
    };
    const nextGeometry: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.15, 40.15],
        [-74.1, 40.2]
      ]
    };

    const rendered = renderMapView({ editing: { geometry, onChange } });
    await waitFor(() => expect(rendered.canvas.querySelectorAll(".vertex-handle")).toHaveLength(3));
    const originalHandles = [...rendered.canvas.querySelectorAll(".vertex-handle")];

    rendered.rerenderMap({ editing: { geometry: nextGeometry, onChange } });

    await waitFor(() => expect(rendered.canvas.querySelectorAll(".vertex-handle")).toHaveLength(5));
    const currentHandles = [...rendered.canvas.querySelectorAll(".vertex-handle")];
    expect(currentHandles[0]).not.toBe(originalHandles[0]);

    rendered.rerenderMap({ editing: undefined });

    await waitFor(() => expect(rendered.canvas.querySelectorAll(".vertex-handle")).toHaveLength(0));
  });

  it("keeps a focused vertex through repeated keyboard moves and geometry replacement", async () => {
    const user = userEvent.setup();
    let geometry: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2],
        [-74.0, 40.3]
      ]
    };
    let rendered!: ReturnType<typeof renderMapView>;
    const onChange = vi.fn((next: UiGeometry) => {
      geometry = next;
      rendered.rerenderMap({ editing: { geometry, onChange } });
    });

    rendered = renderMapView({ editing: { geometry, onChange } });
    rendered.map.project.mockImplementation(([longitude, latitude]: [number, number]) => ({
      x: longitude * 100,
      y: latitude * 100
    }));
    rendered.map.unproject.mockImplementation((point: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      return { lng: x / 100, lat: y / 100 };
    });

    const first = await screen.findByRole("button", { name: "Move vertex 1" });
    first.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");

    const replacement = rendered.canvas.querySelector<HTMLElement>('[data-vertex-key="line-0"]');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(geometry.type).toBe("LineString");
    if (geometry.type !== "LineString") throw new Error("Expected a line geometry");
    expect(geometry.coordinates).toHaveLength(3);
    expect(geometry.coordinates[0][0]).toBeCloseTo(-74.0, 10);
    expect(geometry.coordinates[0][1]).toBeCloseTo(40.1, 10);
    expect(replacement).toBeInTheDocument();
    expect(replacement).toHaveFocus();
    expect(replacement).not.toBe(first);
  });

  it("focuses the previous same-ring vertex after deleting the last vertex", async () => {
    const user = userEvent.setup();
    let geometry: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2],
        [-74.0, 40.3]
      ]
    };
    let rendered!: ReturnType<typeof renderMapView>;
    const onChange = vi.fn((next: UiGeometry) => {
      geometry = next;
      rendered.rerenderMap({ editing: { geometry, onChange } });
    });

    rendered = renderMapView({ editing: { geometry, onChange } });
    const last = await screen.findByRole("button", { name: "Move vertex 3" });
    last.focus();
    await user.keyboard("{Delete}");

    expect(geometry).toEqual({
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2]
      ]
    });
    const previous = rendered.canvas.querySelector<HTMLElement>('[data-vertex-key="line-1"]');
    expect(previous).toBeInTheDocument();
    expect(previous).toHaveFocus();
    expect(previous).not.toBe(last);
  });

  it("does not treat a removed vertex as keyboard focus when removal is refused", async () => {
    const onChange = vi.fn();
    renderMapView({
      editing: {
        geometry: {
          type: "LineString",
          coordinates: [
            [-74.2, 40.1],
            [-74.1, 40.2]
          ]
        },
        onChange
      }
    });

    const first = await screen.findByRole("button", { name: "Move vertex 1" });
    first.focus();
    fireEvent.keyDown(first, { key: "Delete" });
    expect(onChange).not.toHaveBeenCalled();
    expect(first).toHaveFocus();
  });
});
