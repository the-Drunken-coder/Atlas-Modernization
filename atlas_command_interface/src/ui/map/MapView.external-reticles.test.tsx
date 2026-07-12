import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { appendMarker, entity, firePointerMove, markerCoordinatesFor, rect, renderMapView } from "./MapView.test-harness.js";
import { buildMapSources } from "./map-sources.js";

describe("MapView external reticle targets", () => {
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

  it("keeps the selected entity as the only reticle while the pointer moves elsewhere", async () => {
    const { canvas, rerenderMap } = renderMapView();
    appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));
    rerenderMap({ focusTarget: { type: "entity", id: "asset-1" } });
    await waitFor(() => expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe("70px"));

    firePointerMove(canvas, { clientX: 220, clientY: 140 });

    await waitFor(() => {
      const reticles = document.querySelectorAll<HTMLElement>(".map-reticle");
      expect(reticles).toHaveLength(1);
      expect(reticles[0]?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
      expect(reticles[0]?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
    });
  });

  it("shows a raw-pointer X, clipped tether, coordinates, and range while selection owns the reticle", async () => {
    const { canvas, rerenderMap } = renderMapView({ selectedId: "asset-1" });
    appendMarker(canvas, "asset-1", rect(20, 30, 20, 20));
    rerenderMap({ focusTarget: { type: "entity", id: "asset-1" } });
    firePointerMove(canvas, { clientX: 80, clientY: 100 });

    await waitFor(() => {
      const locator = document.querySelector<SVGElement>(".map-cursor-locator");
      const tether = document.querySelector<SVGLineElement>(".map-cursor-locator__tether");
      const readout = document.querySelector<HTMLElement>("[data-testid='map-cursor-readout']");
      expect(locator).toBeInTheDocument();
      expect(tether).toBeInTheDocument();
      expect(Number(tether?.getAttribute("x1"))).toBeLessThan(Number(tether?.getAttribute("x2")));
      expect(readout).toHaveTextContent("CURSOR 80.00000, 70.00000");
      expect(readout).toHaveTextContent(/RANGE\s+[\d,.]+ mi/);
      expect(readout).toHaveTextContent(/BEARING\s+\d+°/);
    });

    fireEvent.pointerLeave(canvas);
    await waitFor(() => {
      expect(document.querySelector(".map-cursor-locator")).not.toBeInTheDocument();
      expect(document.querySelector("[data-testid='map-cursor-readout']")).not.toBeInTheDocument();
    });
  });

  it("shows coordinates without a locator or range when nothing is selected", async () => {
    const { canvas } = renderMapView();
    firePointerMove(canvas, { clientX: 80, clientY: 100 });

    await waitFor(() => {
      const readout = document.querySelector<HTMLElement>("[data-testid='map-cursor-readout']");
      expect(readout).toHaveTextContent("CURSOR 80.00000, 70.00000");
      expect(readout).not.toHaveTextContent("RANGE");
    });
    expect(document.querySelector(".map-cursor-locator")).not.toBeInTheDocument();
    expect(document.querySelector("[data-testid='map-cursor-readout']")).not.toHaveTextContent("BEARING");

    fireEvent.pointerLeave(canvas);
    await waitFor(() => expect(document.querySelector("[data-testid='map-cursor-readout']")).not.toBeInTheDocument());
  });

  it("does not duplicate the selected box when the pointer targets that entity", async () => {
    const { canvas, rerenderMap } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));
    rerenderMap({ focusTarget: { type: "entity", id: "asset-1" } });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toBeInTheDocument());

    firePointerMove(marker, { clientX: 80, clientY: 100 });

    await waitFor(() => expect(document.querySelectorAll(".map-reticle")).toHaveLength(1));
    expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted");
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

  it("clears selection and its reticle when Escape is pressed", async () => {
    const { canvas, onBackgroundClick, rerenderMap } = renderMapView({ selectedId: "asset-1" });
    appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));
    rerenderMap({ focusTarget: { type: "entity", id: "asset-1" } });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onBackgroundClick).toHaveBeenCalledTimes(1);
    rerenderMap({ focusTarget: null, selectedId: undefined });
    await waitFor(() => expect(document.querySelector(".map-reticle")).not.toBeInTheDocument());
  });

  it("drops the reticle to the pointer when Escape clears selection over the map", async () => {
    const { canvas, onBackgroundClick, rerenderMap } = renderMapView({ selectedId: "asset-1" });
    appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));
    rerenderMap({ focusTarget: { type: "entity", id: "asset-1" } });
    firePointerMove(canvas, { clientX: 220, clientY: 140 });
    await waitFor(() => expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe("70px"));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onBackgroundClick).toHaveBeenCalledTimes(1);
    rerenderMap({ focusTarget: null, selectedId: undefined });

    await waitFor(() => {
      const reticle = document.querySelector<HTMLElement>(".map-reticle");
      expect(reticle?.style.getPropertyValue("--map-reticle-x")).toBe("210px");
      expect(reticle?.style.getPropertyValue("--map-reticle-y")).toBe("120px");
    });
  });

  it("temporarily replaces selection with box zoom and restores it afterward", async () => {
    const { canvas, onBackgroundClick, rerenderMap } = renderMapView({ selectedId: "asset-1" });
    appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));
    rerenderMap({ focusTarget: { type: "entity", id: "asset-1" } });
    await waitFor(() => expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe("70px"));

    fireEvent.mouseDown(canvas, { button: 0, shiftKey: true, clientX: 50, clientY: 80 });
    fireEvent.mouseMove(window, { clientX: 150, clientY: 180 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--zoom"));
    expect(document.querySelector(".map-cursor-locator")).not.toBeInTheDocument();
    expect(document.querySelector("[data-testid='map-cursor-readout']")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onBackgroundClick).not.toHaveBeenCalled();
    await waitFor(() => {
      const reticle = document.querySelector<HTMLElement>(".map-reticle");
      expect(reticle).not.toHaveClass("map-reticle--zoom");
      expect(reticle?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
      expect(reticle?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
      expect(document.querySelector(".map-cursor-locator")).toBeInTheDocument();
    });
  });

  it("keeps the selected reticle aligned while scroll zoom moves its marker", async () => {
    const { canvas, map, rerenderMap } = renderMapView();
    let markerRect = rect(70, 90, 20, 20);
    appendMarker(canvas, "asset-1", () => markerRect);
    rerenderMap({ focusTarget: { type: "entity", id: "asset-1" } });
    await waitFor(() => expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe("70px"));

    firePointerMove(canvas, { clientX: 220, clientY: 120 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted"));
    fireEvent.wheel(canvas, { clientX: 220, clientY: 120, deltaY: -120 });
    markerRect = rect(170, 120, 20, 20);
    act(() => map.fire("zoom"));

    let overlay = document.querySelector<HTMLElement>(".map-reticle");
    expect(overlay).toHaveClass("map-reticle--scrolling");
    expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("170px");
    expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("110px");

    await waitFor(() => {
      overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).not.toHaveClass("map-reticle--scrolling");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("170px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("110px");
    });
  });

  it("keeps a focused marker reticle locked to the marker throughout camera zoom", async () => {
    const { canvas, map, rerenderMap } = renderMapView();
    let markerRect = rect(70, 90, 20, 20);
    appendMarker(canvas, "asset-1", () => markerRect);
    rerenderMap({ focusTarget: { type: "entity", id: "asset-1" } });
    await waitFor(() => expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe("70px"));

    act(() => map.fire("movestart"));
    markerRect = rect(120, 70, 20, 20);
    act(() => map.fire("zoom"));

    let reticle = document.querySelector<HTMLElement>(".map-reticle");
    expect(reticle).toHaveClass("map-reticle--scrolling");
    expect(reticle?.style.getPropertyValue("--map-reticle-x")).toBe("120px");
    expect(reticle?.style.getPropertyValue("--map-reticle-y")).toBe("60px");

    markerRect = rect(170, 50, 20, 20);
    act(() => map.fire("zoom"));
    reticle = document.querySelector<HTMLElement>(".map-reticle");
    expect(reticle).toHaveClass("map-reticle--scrolling");
    expect(reticle?.style.getPropertyValue("--map-reticle-x")).toBe("170px");
    expect(reticle?.style.getPropertyValue("--map-reticle-y")).toBe("40px");

    act(() => map.fire("moveend"));
    await waitFor(() => {
      const settledReticle = document.querySelector<HTMLElement>(".map-reticle");
      expect(settledReticle).not.toHaveClass("map-reticle--scrolling");
      expect(settledReticle?.style.getPropertyValue("--map-reticle-x")).toBe("170px");
      expect(settledReticle?.style.getPropertyValue("--map-reticle-y")).toBe("40px");
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
