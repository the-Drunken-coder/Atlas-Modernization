import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { appendMarker, firePointerMove, rect, renderMapView } from "./MapView.test-harness.js";

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
