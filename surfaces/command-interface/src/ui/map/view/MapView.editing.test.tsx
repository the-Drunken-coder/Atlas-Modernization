import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UiGeometry } from "../../../atlas/geometry.js";
import { renderMapView } from "./MapView.test-harness.js";

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
});
