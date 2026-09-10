import { act, fireEvent } from "@testing-library/react";
import type { MovementSample } from "@the-drunken-coder/atlas-sdk";
import { expect, it, vi } from "vitest";
import { type MovementMapOverlay, movementConnector, movementFeatures } from "../rendering/map-movement-history.js";
import { appendMarker, firePointerMove, markerSources, rect, renderMapView, style } from "./MapView.test-harness.js";

const sample: MovementSample = {
  sample_id: "report",
  time: "2026-09-09T12:00:00Z",
  received_at: "2026-09-09T12:00:00Z",
  time_is_arrival: true,
  latitude: 0,
  longitude: 0
};
function overlay(): MovementMapOverlay {
  return {
    trail: {
      entity_created_at: sample.time,
      from: sample.time,
      to: sample.time,
      retained_from: sample.time,
      points: [{ sample, gap_before: false }],
      position_count: 1,
      simplified: false
    },
    selected: sample,
    interactive: true,
    onPin: vi.fn(),
    onPreview: vi.fn(),
    onDismiss: vi.fn().mockReturnValue(true)
  };
}
it("splits dateline connectors and keeps raw gap labels independent of spacing", () => {
  expect(movementConnector([179, 10], [-179, 12])).toEqual([
    [
      [179, 10],
      [180, 11]
    ],
    [
      [-180, 11],
      [-179, 12]
    ]
  ]);
  expect(movementConnector([-179, 12], [179, 10])).toEqual([
    [
      [-179, 12],
      [-180, 11]
    ],
    [
      [180, 11],
      [179, 10]
    ]
  ]);
  const value = overlay();
  value.trail?.points.push({ sample: { ...sample, sample_id: "gap", latitude: 1 }, gap_before: true });
  expect(
    movementFeatures(value)
      .features.filter((f) => f.properties?.kind === "line")
      .map((f) => f.properties?.gap)
  ).toEqual([true]);
  expect(movementFeatures(undefined).features).toEqual([]);
});
it("previews and pins history without clearing selection; current markers win overlaps", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  const flush = () =>
    act(() => {
      while (frames.length) frames.shift()?.(0);
    });
  const movement = overlay();
  const { canvas, map, onBackgroundClick, onSelectEntity } = renderMapView({
    movement,
    selectedId: "asset-1",
    sources: markerSources()
  });
  map.queryRenderedFeatures.mockReturnValue([
    { geometry: { type: "Point", coordinates: [0, 0] }, properties: { sampleId: sample.sample_id } }
  ]);
  firePointerMove(canvas, { clientX: 200, clientY: 100 });
  flush();
  expect(movement.onPreview).toHaveBeenLastCalledWith(sample);
  fireEvent.click(canvas, { clientX: 200, clientY: 100 });
  expect(movement.onPin).toHaveBeenCalledWith(sample);
  expect(onBackgroundClick).not.toHaveBeenCalled();
  vi.mocked(movement.onPin).mockClear();
  const marker = appendMarker(canvas, "asset-1", rect(190, 90, 20, 20));
  firePointerMove(marker, { clientX: 200, clientY: 100 });
  flush();
  expect(movement.onPreview).toHaveBeenLastCalledWith(undefined);
  fireEvent.click(marker, { clientX: 200, clientY: 100 });
  expect(onSelectEntity).toHaveBeenCalledWith("asset-1");
  expect(movement.onPin).not.toHaveBeenCalled();
});
it("dismisses history before selection, respects dialogs, and restores layers after a style change", () => {
  const movement = overlay();
  const { canvas, map, onBackgroundClick, rerenderMap } = renderMapView({ movement, selectedId: "asset-1" });
  fireEvent.keyDown(canvas, { key: "Escape" });
  expect(movement.onDismiss).toHaveBeenCalledTimes(1);
  expect(onBackgroundClick).not.toHaveBeenCalled();
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  canvas.appendChild(dialog);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(movement.onDismiss).toHaveBeenCalledTimes(1);
  rerenderMap({ styleId: "new", style: style("new") });
  act(() => {
    map.loaded = true;
    map.fire("style.load");
  });
  expect(map.getLayer("movement-history-points")).toBeDefined();
  expect(map.getSource("movement-history")?.setData).toHaveBeenCalledWith(movementFeatures(movement));
  rerenderMap({ movement: undefined });
  expect(map.getSource("movement-history")?.setData).toHaveBeenLastCalledWith({
    type: "FeatureCollection",
    features: []
  });
});

it("republishes unchanged history after a synchronous style-switch failure", () => {
  const movement = overlay();
  const { map, rerenderMap } = renderMapView({ movement, styleId: "a", style: style("a") });
  const sink = map.getSource("movement-history")!.setData;
  sink.mockClear();
  rerenderMap({ styleId: "b", style: style("b", { throwOnSetStyle: true }) });
  expect(sink).toHaveBeenCalledExactlyOnceWith(movementFeatures(movement));
});

it("republishes history when asynchronous style recovery completes without a style-load event", () => {
  const movement = overlay();
  const { map, rerenderMap } = renderMapView({ movement, styleId: "a", style: style("a") });
  map.setStyle.mockImplementation(() => {
    map.sources.clear();
    map.layers.clear();
    map.loaded = true;
    return map;
  });
  rerenderMap({ styleId: "b", style: style("b") });
  act(() => map.fire("error", { error: new Error("style failed") }));
  expect(map.getSource("movement-history")?.setData).toHaveBeenLastCalledWith(movementFeatures(movement));
});

it.each([180, -180])("connects equivalent dateline endpoints at %i without invalid coordinates", (longitude) => {
  expect(movementConnector([longitude, 10], [-longitude, 12])).toEqual([
    [
      [longitude, 10],
      [longitude, 12]
    ]
  ]);
});
