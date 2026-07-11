import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { appendMarker, entity, firePointerMove, markerCoordinatesFor, rect, renderMapView } from "./MapView.test-harness.js";
import { buildMapSources } from "./map-sources.js";

describe("MapView hover target box", () => {
  it("fits a padded rectangle around hovered map markers instead of forcing a square", async () => {
    const { canvas } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 28, 40));

    firePointerMove(marker, { clientX: 80, clientY: 100 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-x")).toBe("53px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-y")).toBe("63px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-width")).toBe("42px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-height")).toBe("54px");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("74px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("90px");
    });
  });

  it("locks onto a marker within the magnet radius without touching it", async () => {
    const { canvas } = renderMapView();
    appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    // Marker box is (60,70)-(80,90) map-relative; the pointer lands 5px to its right.
    firePointerMove(canvas, { clientX: 95, clientY: 100 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
    });
  });

  it("keeps a plain cursor reticle when a marker sits beyond the magnet radius", async () => {
    const { canvas } = renderMapView();
    appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    // The pointer lands 9px to the marker's right, just outside the 8px magnet.
    firePointerMove(canvas, { clientX: 99, clientY: 100 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).not.toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("89px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
    });
  });

  it("locks onto the nearest marker when several sit within the magnet radius", async () => {
    const { canvas } = renderMapView();
    appendMarker(canvas, "asset-far", rect(70, 90, 20, 20));
    appendMarker(canvas, "asset-near", rect(98, 90, 20, 20));

    // Point (85,80) is 5px from asset-far's box and 3px from asset-near's box.
    firePointerMove(canvas, { clientX: 95, clientY: 100 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("98px");
    });
  });

  it("releases a locked reticle when Escape is pressed", async () => {
    const { canvas } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    firePointerMove(marker, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted"));

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(document.querySelector(".map-reticle")).not.toBeInTheDocument();
      expect(canvas).not.toHaveClass("map-canvas--custom-cursor");
    });
  });

  it("reuses cached marker boxes across pointer frames until the camera moves", async () => {
    const { canvas, map } = renderMapView();
    const measure = vi.fn(() => rect(70, 90, 20, 20));
    appendMarker(canvas, "asset-1", measure);

    firePointerMove(canvas, { clientX: 210, clientY: 150 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toBeInTheDocument());
    firePointerMove(canvas, { clientX: 220, clientY: 160 });
    await waitFor(() => expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe("210px"));

    expect(measure).toHaveBeenCalledTimes(1);

    act(() => map.fire("move"));
    firePointerMove(canvas, { clientX: 230, clientY: 170 });
    await waitFor(() => expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe("220px"));

    expect(measure).toHaveBeenCalledTimes(2);
  });

  it("keeps the default cursor target square when no marker is hovered", async () => {
    const { canvas } = renderMapView();

    firePointerMove(canvas, { clientX: 80, clientY: 100 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-width")).toBe("22px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-height")).toBe("22px");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
    });
  });

  it("coalesces pointer movement to the latest position in one animation frame", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const frameId = ++nextFrameId;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (frameId: number) => frames.delete(frameId));

    const { canvas, map } = renderMapView();
    act(() => {
      for (const [frameId, callback] of frames) {
        frames.delete(frameId);
        callback(0);
      }
    });
    map.queryRenderedFeatures.mockClear();

    firePointerMove(canvas, { clientX: 80, clientY: 100 });
    firePointerMove(canvas, { clientX: 90, clientY: 110 });

    expect(frames.size).toBe(1);
    expect(document.querySelector(".map-reticle")).not.toBeInTheDocument();

    act(() => {
      for (const [frameId, callback] of frames) {
        frames.delete(frameId);
        callback(16);
      }
    });

    const overlay = document.querySelector<HTMLElement>(".map-reticle");
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(1);
    expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("80px");
    expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("90px");
  });

  it("cancels a pending reticle frame when the pointer leaves", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const frameId = ++nextFrameId;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (frameId: number) => frames.delete(frameId));

    const { canvas } = renderMapView();
    act(() => {
      for (const [frameId, callback] of frames) {
        frames.delete(frameId);
        callback(0);
      }
    });

    firePointerMove(canvas, { clientX: 80, clientY: 100 });
    fireEvent.pointerLeave(canvas);

    expect(frames.size).toBe(0);
    expect(canvas).not.toHaveClass("map-canvas--custom-cursor");
    expect(document.querySelector(".map-reticle")).not.toBeInTheDocument();
  });

  it("cancels a pending reticle frame when the map unmounts", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const frameId = ++nextFrameId;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (frameId: number) => frames.delete(frameId));

    const { canvas, unmount } = renderMapView();
    act(() => {
      for (const [frameId, callback] of frames) {
        frames.delete(frameId);
        callback(0);
      }
    });
    firePointerMove(canvas, { clientX: 80, clientY: 100 });

    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
  });

  it("prevents page scrolling during map wheel zoom", () => {
    const { canvas } = renderMapView();
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 80, clientY: 100, deltaY: -120 });

    fireEvent(canvas, wheel);

    expect(wheel.defaultPrevented).toBe(true);
  });

  it("keeps a hovered marker box aligned while the map camera moves", async () => {
    const { canvas, map } = renderMapView();
    let markerRect = rect(70, 90, 28, 40);
    const marker = appendMarker(canvas, "asset-1", () => markerRect);

    firePointerMove(marker, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted"));

    markerRect = rect(120, 60, 28, 40);
    act(() => map.fire("move"));

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-x")).toBe("103px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-y")).toBe("33px");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("124px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("60px");
    });
  });

  it("keeps a hovered marker reticle aligned when a feed snapshot moves it", async () => {
    const initial = entity({
      entity_id: "track-1",
      entity_type: "track",
      components: { telemetry: { longitude: 70, latitude: 80 } }
    });
    const moved = {
      ...initial,
      components: { ...initial.components, telemetry: { ...initial.components.telemetry, longitude: 170, latitude: 60 } }
    };
    const { canvas, rerenderMap } = renderMapView({ sources: buildMapSources([initial], undefined) });
    await waitFor(() => expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(1));
    const marker = canvas.querySelector<HTMLElement>(`.map-symbol-marker[data-entity-id="${initial.entity_id}"]`);
    if (!marker) throw new Error("Expected generated track marker");
    vi.spyOn(marker, "getBoundingClientRect").mockImplementation(() => {
      const [longitude, latitude] = markerCoordinatesFor(marker) ?? [0, 0];
      return rect(longitude, latitude + 10, 20, 20);
    });
    firePointerMove(marker, { clientX: 80, clientY: 100 });
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

  it("keeps a hovered marker box attached to its marker during wheel scroll", async () => {
    const { canvas, map } = renderMapView();
    let markerRect = rect(70, 90, 28, 40);
    const marker = appendMarker(canvas, "asset-1", () => markerRect);

    firePointerMove(marker, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted"));

    vi.useFakeTimers();
    try {
      fireEvent.wheel(canvas, { clientX: 80, clientY: 100, deltaY: -120 });
      markerRect = rect(120, 60, 28, 40);
      act(() => map.fire("zoom"));

      expect(canvas).toHaveClass("map-canvas--scrolling");
      const scrollingOverlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(scrollingOverlay).toHaveClass("map-reticle--targeted");
      expect(scrollingOverlay).toHaveClass("map-reticle--scrolling");
      expect(scrollingOverlay?.style.getPropertyValue("--map-reticle-target-x")).toBe("103px");
      expect(scrollingOverlay?.style.getPropertyValue("--map-reticle-target-y")).toBe("33px");
      expect(scrollingOverlay?.style.getPropertyValue("--map-reticle-x")).toBe("124px");
      expect(scrollingOverlay?.style.getPropertyValue("--map-reticle-y")).toBe("60px");

      firePointerMove(canvas, { clientX: 30, clientY: 40 });

      const lockedOverlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(lockedOverlay).toHaveClass("map-reticle--targeted");
      expect(lockedOverlay?.style.getPropertyValue("--map-reticle-target-x")).toBe("103px");
      expect(lockedOverlay?.style.getPropertyValue("--map-reticle-target-y")).toBe("33px");

      act(() => vi.advanceTimersByTime(180));

      expect(canvas).not.toHaveClass("map-canvas--scrolling");
      const unlockedOverlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(unlockedOverlay).not.toHaveClass("map-reticle--scrolling");
      expect(unlockedOverlay?.style.getPropertyValue("--map-reticle-target-x")).toBe("103px");
      expect(unlockedOverlay?.style.getPropertyValue("--map-reticle-target-y")).toBe("33px");
      expect(unlockedOverlay?.style.getPropertyValue("--map-reticle-x")).toBe("124px");
      expect(unlockedOverlay?.style.getPropertyValue("--map-reticle-y")).toBe("60px");

      firePointerMove(canvas, { clientX: 90, clientY: 110 });
      act(() => vi.advanceTimersByTime(16));

      const movedOverlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(movedOverlay).not.toHaveClass("map-reticle--targeted");
      expect(movedOverlay?.style.getPropertyValue("--map-reticle-x")).toBe("80px");
      expect(movedOverlay?.style.getPropertyValue("--map-reticle-y")).toBe("90px");
      expect(movedOverlay?.style.getPropertyValue("--map-reticle-target-x")).toBe("69px");
      expect(movedOverlay?.style.getPropertyValue("--map-reticle-target-y")).toBe("79px");
    } finally {
      vi.useRealTimers();
    }
  });

  it("zooms around the snapped target instead of the physical wheel point", async () => {
    const { canvas, map } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 28, 40));

    firePointerMove(marker, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted"));

    vi.useFakeTimers();
    try {
      fireEvent.wheel(canvas, { clientX: 180, clientY: 150, deltaY: -120 });

      expect(map.scrollZoom.disable).toHaveBeenCalledTimes(1);
      expect(map.unproject).toHaveBeenCalledWith([74, 90]);
      expect(map.zoomTo).toHaveBeenCalledWith(4 + 120 / 450, { around: { lng: 74, lat: 90 }, duration: 0 });

      act(() => vi.advanceTimersByTime(0));
      expect(map.scrollZoom.enable).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces repeated targeted wheel events into one scroll-zoom restore", async () => {
    const { canvas, map } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 28, 40));
    firePointerMove(marker, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted"));

    vi.useFakeTimers();
    try {
      fireEvent.wheel(canvas, { clientX: 80, clientY: 100, deltaY: -120 });
      fireEvent.wheel(canvas, { clientX: 80, clientY: 100, deltaY: -120 });

      expect(map.scrollZoom.disable).toHaveBeenCalledTimes(1);
      expect(map.scrollZoom.enable).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(0));
      expect(map.scrollZoom.enable).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an already-disabled MapLibre scroll zoom handler", async () => {
    const { canvas, map } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 28, 40));
    map.scrollZoom.isEnabled.mockReturnValue(false);
    firePointerMove(marker, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted"));

    vi.useFakeTimers();
    try {
      fireEvent.wheel(canvas, { clientX: 80, clientY: 100, deltaY: -120 });
      act(() => vi.advanceTimersByTime(0));
      expect(map.scrollZoom.disable).not.toHaveBeenCalled();
      expect(map.scrollZoom.enable).not.toHaveBeenCalled();
      expect(map.zoomTo).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restore MapLibre scroll zoom after unmount", async () => {
    const { canvas, map, unmount } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 28, 40));
    firePointerMove(marker, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted"));

    vi.useFakeTimers();
    try {
      fireEvent.wheel(canvas, { clientX: 80, clientY: 100, deltaY: -120 });
      unmount();
      act(() => vi.advanceTimersByTime(0));
      expect(map.scrollZoom.disable).toHaveBeenCalledTimes(1);
      expect(map.scrollZoom.enable).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects the raw pointer target after targeted wheel zoom settles", async () => {
    const { canvas, map, onSelectEntity } = renderMapView({
      sources: buildMapSources(
        [
          entity({
            entity_id: "geo-visual",
            entity_type: "geofeature",
            components: { geometry: { type: "Point", coordinates: [120, 60] } }
          })
        ],
        undefined
      )
    });
    map.queryRenderedFeatures.mockImplementation((query: unknown) => {
      const [[minX, minY], [maxX, maxY]] = query as [[number, number], [number, number]];
      const contains = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;
      if (contains(70, 80)) return [{ geometry: { type: "Point", coordinates: [70, 80] }, properties: { entityId: "geo-visual" } }];
      if (contains(20, 100)) return [{ geometry: { type: "Point", coordinates: [20, 100] }, properties: { entityId: "geo-raw" } }];
      return [];
    });

    firePointerMove(canvas, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted"));

    vi.useFakeTimers();
    try {
      fireEvent.wheel(canvas, { clientX: 80, clientY: 100, deltaY: -120 });
      act(() => map.fire("zoom"));
      act(() => vi.advanceTimersByTime(180));
      fireEvent.click(canvas, { clientX: 30, clientY: 120 });
    } finally {
      vi.useRealTimers();
    }

    expect(map.queryRenderedFeatures).toHaveBeenLastCalledWith(
      [
        [12, 92],
        [28, 108]
      ],
      { layers: ["geofeatures-point", "geofeatures-line", "geofeatures-fill"] }
    );
    expect(onSelectEntity).toHaveBeenCalledWith("geo-raw");
    expect(onSelectEntity).not.toHaveBeenCalledWith("geo-visual");
  });

  it("keeps focused entity reticles behind live map background movement", async () => {
    const { canvas, rerenderMap } = renderMapView();
    appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    rerenderMap({ focusTarget: { type: "entity", id: "asset-1" } });
    await waitFor(() => expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe("70px"));

    firePointerMove(canvas, { clientX: 220, clientY: 120 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).not.toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("210px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("100px");
    });
  });

  it("keeps outside-map pointer listeners stable while the reticle moves", async () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const { canvas } = renderMapView();
    const pointerMoveRegistrations = () => addListener.mock.calls.filter(([type]) => String(type) === "pointermove").length;
    const initialRegistrations = pointerMoveRegistrations();

    firePointerMove(canvas, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toBeInTheDocument());
    firePointerMove(canvas, { clientX: 90, clientY: 110 });

    expect(pointerMoveRegistrations()).toBe(initialRegistrations);
  });

  it("does not subscribe targeted reticles to render frames", async () => {
    const { canvas, map } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 28, 40));

    firePointerMove(marker, { clientX: 80, clientY: 100 });

    // One marker-box-cache invalidation listener plus one targeted-reticle sync listener.
    await waitFor(() => expect(map.listeners.get("move") ?? []).toHaveLength(2));
    expect(map.listeners.get("render") ?? []).toHaveLength(0);
  });
});
