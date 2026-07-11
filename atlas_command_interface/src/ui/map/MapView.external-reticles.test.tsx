import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { appendMarker, entity, firePointerMove, markerCoordinatesFor, rect, renderMapView } from "./MapView.test-harness.js";
import { buildMapSources } from "./map-sources.js";

describe("MapView external reticle targets", () => {
  it("previews visible entity targets without moving the camera", async () => {
    const { canvas, map, rerenderMap } = renderMapView();
    appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));
    map.easeTo.mockClear();
    map.fitBounds.mockClear();

    rerenderMap({ previewTarget: { type: "entity", id: "asset-1" } });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
    });
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(map.flyTo).not.toHaveBeenCalled();
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it("ignores offscreen preview targets", async () => {
    const { map, rerenderMap } = renderMapView();
    map.easeTo.mockClear();
    map.fitBounds.mockClear();

    rerenderMap({ previewTarget: { type: "point", id: "search-1", coordinates: [500, 500] } });

    await waitFor(() => expect(document.querySelector(".map-reticle")).not.toBeInTheDocument());
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(map.flyTo).not.toHaveBeenCalled();
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it("shows the focus reticle without moving the camera", async () => {
    const { map, rerenderMap } = renderMapView();
    map.easeTo.mockClear();
    map.fitBounds.mockClear();

    rerenderMap({ focusTarget: { type: "point", id: "search-1", coordinates: [70, 80] } });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
    });
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(map.flyTo).not.toHaveBeenCalled();
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it("keeps the native cursor for external reticles until the pointer drives the reticle", async () => {
    const { canvas, rerenderMap } = renderMapView();
    rerenderMap({ focusTarget: { type: "point", id: "search-1", coordinates: [70, 80] } });

    await waitFor(() => expect(document.querySelector(".map-reticle")).toBeInTheDocument());
    expect(canvas).not.toHaveClass("map-canvas--custom-cursor");

    firePointerMove(canvas, { clientX: 180, clientY: 140 });
    await waitFor(() => expect(canvas).toHaveClass("map-canvas--custom-cursor"));

    fireEvent.pointerLeave(canvas);
    await waitFor(() => expect(canvas).not.toHaveClass("map-canvas--custom-cursor"));
    expect(document.querySelector(".map-reticle")).toBeInTheDocument();
  });

  it("keeps a focused marker reticle aligned when a feed snapshot moves it", async () => {
    const initial = entity({
      entity_id: "track-1",
      entity_type: "track",
      components: { telemetry: { longitude: 70, latitude: 80 } }
    });
    const moved = {
      ...initial,
      components: { ...initial.components, telemetry: { ...initial.components.telemetry, longitude: 170, latitude: 60 } }
    };
    const focusTarget = { type: "entity" as const, id: initial.entity_id };
    const { canvas, rerenderMap } = renderMapView({ sources: buildMapSources([initial], undefined) });
    await waitFor(() => expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(1));
    const marker = canvas.querySelector<HTMLElement>(`.map-symbol-marker[data-entity-id="${initial.entity_id}"]`);
    if (!marker) throw new Error("Expected generated track marker");
    vi.spyOn(marker, "getBoundingClientRect").mockImplementation(() => {
      const [longitude, latitude] = markerCoordinatesFor(marker) ?? [0, 0];
      return rect(longitude, latitude + 10, 20, 20);
    });

    rerenderMap({ focusTarget });
    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
    });

    rerenderMap({ sources: buildMapSources([moved], undefined) });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("170px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("60px");
    });
  });

  it("previews generic point targets for future search results", async () => {
    const { rerenderMap } = renderMapView();

    rerenderMap({ previewTarget: { type: "point", id: "search-1", coordinates: [70, 80], label: "Dunkin" } });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-width")).toBe("22px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-height")).toBe("22px");
    });
  });

  it("shows live map hover reticles ahead of external previews", async () => {
    const { canvas, onSelectEntity, rerenderMap } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(170, 120, 20, 20));
    rerenderMap({ previewTarget: { type: "point", id: "search-1", coordinates: [70, 80] } });
    await waitFor(() => expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe("70px"));

    firePointerMove(marker, { clientX: 180, clientY: 130 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("170px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("110px");
    });
    fireEvent.click(canvas);
    expect(onSelectEntity).toHaveBeenCalledWith("asset-1");
  });

  it("shows refreshed focus reticles after scroll lock settles", async () => {
    const { canvas, map, rerenderMap } = renderMapView();
    let markerRect = rect(70, 90, 20, 20);
    appendMarker(canvas, "asset-1", () => markerRect);
    rerenderMap({ focusTarget: { type: "entity", id: "asset-1" } });
    await waitFor(() => expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe("70px"));

    fireEvent.wheel(canvas, { clientX: 80, clientY: 100, deltaY: -120 });
    markerRect = rect(170, 120, 20, 20);
    act(() => map.fire("zoom"));

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).not.toHaveClass("map-reticle--scrolling");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("170px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("110px");
    });
  });

  it("keeps scroll-locked reticle state ahead of external previews", async () => {
    const { canvas, rerenderMap } = renderMapView();
    rerenderMap({ previewTarget: { type: "point", id: "search-1", coordinates: [70, 80] } });
    await waitFor(() => expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe("70px"));

    fireEvent.wheel(canvas, { clientX: 80, clientY: 100, deltaY: -120 });
    rerenderMap({ previewTarget: { type: "point", id: "search-2", coordinates: [160, 100] } });

    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--scrolling"));
    const overlay = document.querySelector<HTMLElement>(".map-reticle");
    expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
    expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");

    await waitFor(() => {
      const settledOverlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(settledOverlay).not.toHaveClass("map-reticle--scrolling");
      expect(settledOverlay?.style.getPropertyValue("--map-reticle-x")).toBe("160px");
      expect(settledOverlay?.style.getPropertyValue("--map-reticle-y")).toBe("100px");
    });
  });

  it("does not convert focused external reticles into clickable hover targets during scroll", async () => {
    const { canvas, onBackgroundClick, onSelectEntity, rerenderMap } = renderMapView();
    appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));
    rerenderMap({ focusTarget: { type: "entity", id: "asset-1" } });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted"));

    vi.useFakeTimers();
    try {
      fireEvent.wheel(canvas, { clientX: 80, clientY: 100, deltaY: -120 });
      act(() => vi.advanceTimersByTime(180));
    } finally {
      vi.useRealTimers();
    }
    fireEvent.click(canvas);

    expect(onSelectEntity).not.toHaveBeenCalled();
    expect(onBackgroundClick).toHaveBeenCalledTimes(1);
  });
});
