import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EntityResource } from "../../../../atlas_sdk/src/index.js";
import { defaultSidcIconService } from "../symbols/sidc-symbol-service.js";
import { entity, markerOperationCounts, renderMapView, resetMarkerOperationCounts } from "./MapView.test-harness.js";
import { buildMapSources } from "./map-sources.js";

const TRACK_COUNT = 256;

describe("MapView symbol marker reconciliation", () => {
  it("does only one position write per changed track across full 256-track snapshots", async () => {
    const renderSymbol = vi.spyOn(defaultSidcIconService, "render");
    const tracks = Array.from({ length: TRACK_COUNT }, (_, index) => track(index));
    const { canvas, rerenderMap } = renderMapView({ sources: buildMapSources(tracks, undefined) });

    await waitFor(() => expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(TRACK_COUNT));
    const originalElements = new Map(tracks.map((track) => [track.entity_id, markerFor(canvas, track.entity_id)]));
    resetMarkerOperationCounts();
    renderSymbol.mockClear();

    for (let index = 0; index < tracks.length; index += 1) {
      tracks[index] = moveTrack(tracks[index], 0.001);
      rerenderMap({ sources: buildMapSources(tracks, undefined) });
    }

    expect(markerOperationCounts()).toEqual({ created: 0, setLngLat: TRACK_COUNT, addTo: 0, remove: 0 });
    expect(renderSymbol).not.toHaveBeenCalled();
    for (const [entityId, element] of originalElements) expect(markerFor(canvas, entityId)).toBe(element);
  });

  it("creates and removes only the entity IDs that changed", async () => {
    const first = track(1);
    const removed = track(2);
    const added = track(3);
    const { canvas, rerenderMap } = renderMapView({ sources: buildMapSources([first, removed], undefined) });

    await waitFor(() => expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(2));
    const persistentElement = markerFor(canvas, first.entity_id);
    resetMarkerOperationCounts();

    rerenderMap({ sources: buildMapSources([first, added], undefined) });

    expect(markerOperationCounts()).toEqual({ created: 1, setLngLat: 1, addTo: 1, remove: 1 });
    expect(markerFor(canvas, first.entity_id)).toBe(persistentElement);
    expect(canvas.querySelector(`[data-entity-id="${removed.entity_id}"]`)).not.toBeInTheDocument();
    expect(markerFor(canvas, added.entity_id)).toBeInTheDocument();
  });

  it("updates SIDC selection and context-menu coordinates without replacing the marker", async () => {
    const renderSymbol = vi.spyOn(defaultSidcIconService, "render");
    const initial = track(7);
    const { canvas, onMapContextMenu, onSelectEntity, rerenderMap } = renderMapView({
      sources: buildMapSources([initial], undefined)
    });

    await waitFor(() => expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(1));
    const element = markerFor(canvas, initial.entity_id);
    expect(element).toHaveClass("maplibregl-marker", "maplibregl-marker-anchor-center", "map-symbol-marker--track");
    element.classList.add("map-symbol-marker--asset");
    element.focus();
    const moved = moveTrack(initial, 0.25);
    resetMarkerOperationCounts();
    renderSymbol.mockClear();

    rerenderMap({ sources: buildMapSources([moved], moved.entity_id) });

    expect(markerFor(canvas, initial.entity_id)).toBe(element);
    expect(element).toHaveClass("maplibregl-marker", "maplibregl-marker-anchor-center", "map-symbol-marker--track", "map-symbol-marker--selected");
    expect(element).not.toHaveClass("map-symbol-marker--asset");
    expect(element).toHaveFocus();
    expect(markerOperationCounts()).toEqual({ created: 0, setLngLat: 1, addTo: 0, remove: 0 });
    expect(renderSymbol).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(element, { clientX: 120, clientY: 85 });

    expect(onSelectEntity).toHaveBeenCalledWith(moved.entity_id);
    expect(onMapContextMenu).toHaveBeenCalledWith({
      lng: moved.components.telemetry?.longitude,
      lat: moved.components.telemetry?.latitude,
      x: 120,
      y: 85
    });
  });
});

function track(index: number): EntityResource {
  return entity({
    entity_id: `track-${index}`,
    entity_type: "track",
    alias: `Track ${index}`,
    components: { telemetry: { longitude: -100 + index / 1_000, latitude: 30 + index / 1_000 } }
  });
}

function moveTrack(track: EntityResource, longitudeDelta: number): EntityResource {
  const telemetry = track.components.telemetry;
  if (!telemetry || typeof telemetry.longitude !== "number") throw new Error("Track telemetry is required");
  return {
    ...track,
    components: { ...track.components, telemetry: { ...telemetry, longitude: telemetry.longitude + longitudeDelta } }
  };
}

function markerFor(canvas: HTMLElement, entityId: string): HTMLButtonElement {
  const marker = canvas.querySelector<HTMLButtonElement>(`.map-symbol-marker[data-entity-id="${entityId}"]`);
  if (!marker) throw new Error(`Missing marker for ${entityId}`);
  return marker;
}
