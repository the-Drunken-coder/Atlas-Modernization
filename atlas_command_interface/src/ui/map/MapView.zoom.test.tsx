import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { appendMarker, firePointerMove, type PointLike, rect, renderMapView } from "./MapView.test-harness.js";

describe("MapView zoom overlay", () => {
  it("delegates completed MapLibre box zooms to fitScreenCoordinates", () => {
    const { map } = renderMapView();
    const boxZoom = map.options.boxZoom as {
      boxZoomEnd: (zoomMap: typeof map, start: PointLike, end: PointLike | [number, number], event: MouseEvent) => void;
    };
    const start = { x: 12, y: 18 };
    const end = { x: 220, y: 140 };

    boxZoom.boxZoomEnd(map, start, end, new MouseEvent("mouseup"));

    expect(map.fitScreenCoordinates).toHaveBeenCalledWith(start, end, 0, { linear: true });
  });

  it("preserves the box-zoom handoff when MapLibre reports an array endpoint", async () => {
    const { map } = renderMapView();
    const boxZoom = map.options.boxZoom as {
      boxZoomEnd: (zoomMap: typeof map, start: PointLike, end: PointLike | [number, number], event: MouseEvent) => void;
    };
    const start = { x: 12, y: 18 };
    const end: [number, number] = [220, 140];

    boxZoom.boxZoomEnd(map, start, end, new MouseEvent("mouseup"));

    expect(map.fitScreenCoordinates).toHaveBeenCalledWith(start, end, 0, { linear: true });
    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).toBeInTheDocument();
      expect(overlay).not.toHaveClass("map-reticle--zoom");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("220px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("140px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-x")).toBe("209px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-y")).toBe("129px");
    });
  });

  it("renders Shift-drag as the Atlas reticle target box", async () => {
    const { canvas } = renderMapView();

    fireEvent.mouseDown(canvas, { button: 0, shiftKey: true, clientX: 50, clientY: 80 });
    await waitFor(() => expect(document.querySelector(".map-reticle--zoom")).toBeInTheDocument());
    fireEvent.mouseMove(window, { clientX: 150, clientY: 180 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle--zoom");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-x")).toBe("40px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-y")).toBe("60px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-width")).toBe("100px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-height")).toBe("100px");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("90px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("110px");
    });
  });

  it("restores the normal reticle when Shift-drag ends without another pointer move", async () => {
    const { canvas } = renderMapView();

    fireEvent.mouseDown(canvas, { button: 0, shiftKey: true, clientX: 50, clientY: 80 });
    await waitFor(() => expect(document.querySelector(".map-reticle--zoom")).toBeInTheDocument());
    fireEvent.mouseMove(window, { clientX: 150, clientY: 180 });
    fireEvent.mouseUp(window, { button: 0, clientX: 150, clientY: 180 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).not.toHaveClass("map-reticle--zoom");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-x")).toBe("129px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-y")).toBe("149px");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("140px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("160px");
    });
  });

  it("clears the reticle when Shift-drag is canceled outside the map", async () => {
    const { canvas } = renderMapView();

    fireEvent.mouseDown(canvas, { button: 0, shiftKey: true, clientX: 50, clientY: 80 });
    await waitFor(() => expect(document.querySelector(".map-reticle--zoom")).toBeInTheDocument());
    fireEvent.mouseMove(window, { clientX: 500, clientY: 250 });
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(document.querySelector(".map-reticle")).not.toBeInTheDocument());
  });

  it("keeps normal boxed entity click selection outside zoom drag", async () => {
    const { canvas, onBackgroundClick, onSelectEntity } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    firePointerMove(marker, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toBeInTheDocument());
    fireEvent.click(marker);

    expect(onSelectEntity).toHaveBeenCalledWith("asset-1");
    expect(onBackgroundClick).not.toHaveBeenCalled();
  });

  it("ignores non-left or control-surface Shift presses", () => {
    const { canvas } = renderMapView();
    const control = document.createElement("div");
    control.className = "maplibregl-control-container";
    canvas.appendChild(control);

    fireEvent.mouseDown(canvas, { button: 1, shiftKey: true, clientX: 50, clientY: 80 });
    fireEvent.mouseDown(canvas, { button: 0, shiftKey: false, clientX: 50, clientY: 80 });
    fireEvent.mouseDown(control, { button: 0, shiftKey: true, clientX: 50, clientY: 80 });

    expect(document.querySelector(".map-reticle--zoom")).not.toBeInTheDocument();
  });

  it("keeps the reticle visible while pointer leave only clears the wheel-lock point", async () => {
    const { canvas } = renderMapView();
    firePointerMove(canvas, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toBeInTheDocument());

    fireEvent.wheel(canvas, { clientX: 80, clientY: 100, deltaY: -120 });
    fireEvent.pointerLeave(canvas);

    expect(document.querySelector(".map-reticle")).toBeInTheDocument();
  });

  it("selects map markers from direct click activation without a hover reticle", () => {
    const { canvas, onBackgroundClick, onSelectEntity } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    fireEvent.click(marker);

    expect(onSelectEntity).toHaveBeenCalledWith("asset-1");
    expect(onBackgroundClick).not.toHaveBeenCalled();
  });

  it("selects the clicked marker when marker target boxes overlap", () => {
    const { canvas, onSelectEntity } = renderMapView();
    appendMarker(canvas, "asset-lower", rect(70, 90, 20, 20));
    const topMarker = appendMarker(canvas, "asset-top", rect(70, 90, 20, 20));

    fireEvent.click(topMarker, { clientX: 80, clientY: 100 });

    expect(onSelectEntity).toHaveBeenCalledWith("asset-top");
  });

  it("cycles to the next overlapping entity when the selected one is clicked again", () => {
    const { canvas, onSelectEntity } = renderMapView({ selectedId: "asset-top" });
    appendMarker(canvas, "asset-top", rect(70, 90, 20, 20));
    appendMarker(canvas, "asset-lower", rect(70, 90, 20, 20));

    fireEvent.click(canvas, { clientX: 80, clientY: 100 });

    expect(onSelectEntity).toHaveBeenCalledWith("asset-lower");
  });

  it("wraps overlap cycling back to the first entity under the cursor", () => {
    const { canvas, onSelectEntity } = renderMapView({ selectedId: "asset-lower" });
    appendMarker(canvas, "asset-top", rect(70, 90, 20, 20));
    appendMarker(canvas, "asset-lower", rect(70, 90, 20, 20));

    fireEvent.click(canvas, { clientX: 80, clientY: 100 });

    expect(onSelectEntity).toHaveBeenCalledWith("asset-top");
  });

  it("selects canvas features from direct clicks without a hover reticle", () => {
    const { canvas, map, onBackgroundClick, onSelectEntity } = renderMapView();
    map.queryRenderedFeatures.mockReturnValue([
      { geometry: { type: "Point", coordinates: [70, 80] }, properties: { entityId: "geo-1" } }
    ]);

    fireEvent.click(canvas, { clientX: 80, clientY: 100 });

    expect(map.queryRenderedFeatures).toHaveBeenCalledWith(
      [
        [62, 72],
        [78, 88]
      ],
      { layers: ["geofeatures-point", "geofeatures-line", "geofeatures-fill"] }
    );
    expect(onSelectEntity).toHaveBeenCalledWith("geo-1");
    expect(onBackgroundClick).not.toHaveBeenCalled();
  });

  it("does not select or clear entities when a Shift-drag release produces a click", async () => {
    const { canvas, onBackgroundClick, onSelectEntity } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    fireEvent.mouseDown(marker, { button: 0, shiftKey: true, clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle--zoom")).toBeInTheDocument());
    vi.useFakeTimers();
    try {
      fireEvent.mouseMove(window, { clientX: 180, clientY: 150 });
      fireEvent.mouseUp(window, { button: 0, clientX: 180, clientY: 150 });
      act(() => vi.advanceTimersByTime(0));
      fireEvent.click(marker);
    } finally {
      vi.useRealTimers();
    }

    expect(onSelectEntity).not.toHaveBeenCalled();
    expect(onBackgroundClick).not.toHaveBeenCalled();
  });

  it("does not select or clear entities when a Shift-drag cancel produces a click", async () => {
    const { canvas, onBackgroundClick, onSelectEntity } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    fireEvent.mouseDown(marker, { button: 0, shiftKey: true, clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle--zoom")).toBeInTheDocument());
    vi.useFakeTimers();
    try {
      fireEvent.mouseMove(window, { clientX: 180, clientY: 150 });
      fireEvent.keyDown(window, { key: "Escape" });
      act(() => vi.advanceTimersByTime(0));
      fireEvent.click(marker);
    } finally {
      vi.useRealTimers();
    }

    expect(onSelectEntity).not.toHaveBeenCalled();
    expect(onBackgroundClick).not.toHaveBeenCalled();
  });

  it("releases click suppression when its fallback timer expires", async () => {
    const { canvas, onBackgroundClick } = renderMapView();
    fireEvent.mouseDown(canvas, { button: 0, shiftKey: true, clientX: 50, clientY: 80 });
    await waitFor(() => expect(document.querySelector(".map-reticle--zoom")).toBeInTheDocument());

    vi.useFakeTimers();
    try {
      fireEvent.mouseUp(window, { button: 0, clientX: 150, clientY: 180 });
      fireEvent.click(canvas);
      expect(onBackgroundClick).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(750));
      fireEvent.click(canvas);
      expect(onBackgroundClick).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
