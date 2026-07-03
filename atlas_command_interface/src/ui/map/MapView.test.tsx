import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityResource } from "../../../../atlas_sdk/src/index.js";
import type { StyleSpecification } from "maplibre-gl";
import { MapView, buildMapSources, type MapReticleTarget } from "./MapView.js";
import type { MapSources } from "./map-sources.js";

type PointLike = { x: number; y: number };
type Listener = (event?: unknown) => void;
type ListenerEntry = { listener: Listener; once: boolean };
type RenderedFeature = { geometry: { type: string; coordinates: unknown }; properties?: { entityId?: string } };

const maplibreMock = vi.hoisted(() => {
  class FakeMap {
    static instances: FakeMap[] = [];

    readonly options: Record<string, unknown>;
    readonly listeners = new Map<string, ListenerEntry[]>();
    readonly sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    readonly layers = new Map<string, unknown>();
    readonly easeTo = vi.fn();
    readonly fitScreenCoordinates = vi.fn();
    readonly fitBounds = vi.fn();
    readonly jumpTo = vi.fn((options: { center?: [number, number] | { lng: number; lat: number }; zoom?: number }) => {
      if (options.center) this.center = Array.isArray(options.center) ? { lng: options.center[0], lat: options.center[1] } : options.center;
      if (options.zoom !== undefined) this.zoom = options.zoom;
      return this;
    });
    readonly stop = vi.fn();
    readonly zoomTo = vi.fn();
    readonly resize = vi.fn();
    readonly remove = vi.fn();
    readonly addControl = vi.fn();
    readonly addSource = vi.fn((id: string) => {
      this.sources.set(id, { setData: vi.fn() });
    });
    readonly addLayer = vi.fn((layer: { id: string }) => {
      this.layers.set(layer.id, layer);
    });
    readonly queryRenderedFeatures = vi.fn((_point?: unknown, _options?: unknown): RenderedFeature[] => []);
    readonly getBearing = vi.fn(() => 0);
    readonly getZoom = vi.fn(() => this.zoom);
    readonly getCenter = vi.fn(() => this.center);
    readonly getLayer = vi.fn((id: string) => this.layers.get(id));
    readonly getSource = vi.fn((id: string) => this.sources.get(id));
    readonly cameraForBounds = vi.fn((bounds: [[number, number], [number, number]], options?: { maxZoom?: number }) => ({
      center: { lng: (bounds[0][0] + bounds[1][0]) / 2, lat: (bounds[0][1] + bounds[1][1]) / 2 },
      zoom: options?.maxZoom ?? 16,
      bearing: 0
    }));
    readonly project = vi.fn((position: [number, number]) => ({ x: position[0], y: position[1] }));
    readonly unproject = vi.fn((point: [number, number] | { x: number; y: number }) =>
      Array.isArray(point) ? { lng: point[0], lat: point[1] } : { lng: point.x, lat: point.y }
    );
    readonly scrollZoom = {
      disable: vi.fn(),
      enable: vi.fn(),
      isEnabled: vi.fn(() => true)
    };
    readonly setStyle = vi.fn((style: unknown) => {
      if ((style as { metadata?: { throwOnSetStyle?: boolean } }).metadata?.throwOnSetStyle) throw new Error("bad style");
      this.style = style;
      this.loaded = false;
      this.sources.clear();
      this.layers.clear();
      return this;
    });
    loaded = true;
    style: unknown;
    center = { lng: 0, lat: 0 };
    zoom = 4;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.style = options.style;
      FakeMap.instances.push(this);
    }

    getContainer(): HTMLElement {
      return this.options.container as HTMLElement;
    }

    isStyleLoaded(): boolean {
      return this.loaded;
    }

    on(type: string, listener: Listener): this {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), { listener, once: false }]);
      return this;
    }

    once(type: string, listener: Listener): this {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), { listener, once: true }]);
      return this;
    }

    off(type: string, listener: Listener): this {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((entry) => entry.listener !== listener)
      );
      return this;
    }

    fire(type: string, event?: unknown): void {
      if (type === "style.load") this.loaded = true;
      const entries = [...(this.listeners.get(type) ?? [])];
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((entry) => !entry.once)
      );
      for (const entry of entries) entry.listener(event);
    }
  }

  class FakeMarker {
    readonly element?: HTMLElement;

    constructor(options?: { element?: HTMLElement }) {
      this.element = options?.element;
    }

    setLngLat(): this {
      return this;
    }

    addTo(map: FakeMap): this {
      if (this.element) map.getContainer().appendChild(this.element);
      return this;
    }

    remove(): void {
      this.element?.remove();
    }

    on(): this {
      return this;
    }

    getLngLat(): { lng: number; lat: number } {
      return { lng: 0, lat: 0 };
    }
  }

  class FakeControl {}

  return { FakeControl, FakeMap, FakeMarker };
});

vi.mock("maplibre-gl", () => ({
  default: {
    AttributionControl: maplibreMock.FakeControl,
    Map: maplibreMock.FakeMap,
    Marker: maplibreMock.FakeMarker,
    NavigationControl: maplibreMock.FakeControl
  },
  AttributionControl: maplibreMock.FakeControl,
  Map: maplibreMock.FakeMap,
  Marker: maplibreMock.FakeMarker,
  NavigationControl: maplibreMock.FakeControl
}));

beforeEach(() => {
  maplibreMock.FakeMap.instances.length = 0;
  let animationTime = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({}) as CanvasRenderingContext2D);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    animationTime += 100;
    callback(animationTime);
    return animationTime;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function lastJumpTo(map: (typeof maplibreMock.FakeMap)["instances"][number]): { center?: unknown; zoom?: number } | undefined {
  return map.jumpTo.mock.calls[map.jumpTo.mock.calls.length - 1]?.[0];
}

function cameraCallMatches(options: { center?: unknown; zoom?: number }, expectedCenter: [number, number], expectedZoom: number): boolean {
  const center = centerFromCameraCall(options.center);
  return Boolean(center && Math.abs(center[0] - expectedCenter[0]) < 0.001 && Math.abs(center[1] - expectedCenter[1]) < 0.001 && Math.abs((options.zoom ?? Number.NaN) - expectedZoom) < 0.001);
}

function firstCameraCallIndex(map: (typeof maplibreMock.FakeMap)["instances"][number], expectedCenter: [number, number], expectedZoom: number): number {
  return map.jumpTo.mock.calls.findIndex(([options]) => cameraCallMatches(options, expectedCenter, expectedZoom));
}

function centerFromCameraCall(center: unknown): [number, number] | null {
  if (Array.isArray(center) && typeof center[0] === "number" && typeof center[1] === "number") return [center[0], center[1]];
  if (center && typeof center === "object" && "lng" in center && "lat" in center) {
    const { lng, lat } = center as { lng: unknown; lat: unknown };
    if (typeof lng === "number" && typeof lat === "number") return [lng, lat];
  }
  return null;
}

describe("MapView style switching", () => {
  it("creates symbol markers after the initial style load", async () => {
    const { canvas, map } = renderMapView({ sources: markerSources() });

    await waitFor(() => expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(1));
    expect(map.sources.has("geofeatures")).toBe(true);
  });

  it("keeps existing symbol markers when a style switch fails", async () => {
    const onStyleSwitchError = vi.fn();
    const { canvas, map, rerenderMap } = renderMapView({
      sources: markerSources(),
      styleId: "a",
      style: style("a"),
      onStyleSwitchError
    });
    await waitFor(() => expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(1));

    rerenderMap({ styleId: "b", style: style("b", { throwOnSetStyle: true }) });

    await waitFor(() =>
      expect(onStyleSwitchError).toHaveBeenCalledWith({
        failedStyleId: "b",
        activeStyleId: "a"
      })
    );
    expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(1);
    expect(map.setStyle).toHaveBeenCalledTimes(1);
  });

  it("sets a prefetched style and re-registers overlays after style load", async () => {
    const nextStyle = style("b");
    const { canvas, map, rerenderMap } = renderMapView({ sources: markerSources(), styleId: "a", style: style("a") });
    await waitFor(() => expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(1));

    rerenderMap({ styleId: "b", style: nextStyle });

    await waitFor(() => expect(map.setStyle).toHaveBeenCalledWith(nextStyle));
    expect(map.sources.has("geofeatures")).toBe(false);

    act(() => map.fire("style.load"));

    await waitFor(() => expect(map.sources.has("geofeatures")).toBe(true));
    expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(1);
  });
});

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
    map.queryRenderedFeatures.mockImplementation((point: unknown) => {
      const [x, y] = point as [number, number];
      if (x === 70 && y === 80) return [{ geometry: { type: "Point", coordinates: [70, 80] }, properties: { entityId: "geo-visual" } }];
      if (x === 20 && y === 100) return [{ geometry: { type: "Point", coordinates: [20, 100] }, properties: { entityId: "geo-raw" } }];
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

    expect(map.queryRenderedFeatures).toHaveBeenLastCalledWith([20, 100], {
      layers: ["geofeatures-point", "geofeatures-line", "geofeatures-fill"]
    });
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

    await waitFor(() => expect(map.listeners.get("move") ?? []).toHaveLength(1));
    expect(map.listeners.get("render") ?? []).toHaveLength(0);
  });
});

describe("MapView zoom overlay", () => {
  it("delegates completed MapLibre box zooms to fitScreenCoordinates", () => {
    const { map } = renderMapView();
    const boxZoom = map.options.boxZoom as { boxZoomEnd: (zoomMap: typeof map, start: PointLike, end: PointLike, event: MouseEvent) => void };
    const start = { x: 12, y: 18 };
    const end = { x: 220, y: 140 };

    boxZoom.boxZoomEnd(map, start, end, new MouseEvent("mouseup"));

    expect(map.fitScreenCoordinates).toHaveBeenCalledWith(start, end, 0, { linear: true });
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

  it("selects canvas features from direct clicks without a hover reticle", () => {
    const { canvas, map, onBackgroundClick, onSelectEntity } = renderMapView();
    map.queryRenderedFeatures.mockReturnValue([
      { geometry: { type: "Point", coordinates: [70, 80] }, properties: { entityId: "geo-1" } }
    ]);

    fireEvent.click(canvas, { clientX: 80, clientY: 100 });

    expect(map.queryRenderedFeatures).toHaveBeenCalledWith([70, 80], {
      layers: ["geofeatures-point", "geofeatures-line", "geofeatures-fill"]
    });
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
});

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
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it("ignores offscreen preview targets", async () => {
    const { map, rerenderMap } = renderMapView();
    map.easeTo.mockClear();
    map.fitBounds.mockClear();

    rerenderMap({ previewTarget: { type: "point", id: "search-1", coordinates: [500, 500] } });

    await waitFor(() => expect(document.querySelector(".map-reticle")).not.toBeInTheDocument());
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it("focuses selected point targets with explicit camera frames and keeps a fallback reticle", async () => {
    const { map, rerenderMap } = renderMapView();
    map.easeTo.mockClear();
    map.fitBounds.mockClear();
    map.jumpTo.mockClear();

    rerenderMap({ focusTarget: { type: "point", id: "search-1", coordinates: [70, 80] } });

    await waitFor(() => expect(map.jumpTo).toHaveBeenCalled());
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(map.fitBounds).not.toHaveBeenCalled();
    expect(map.jumpTo.mock.calls.some(([options]) => cameraCallMatches(options, [70, 80], 4))).toBe(true);
    expect(firstCameraCallIndex(map, [70, 80], 4)).toBeLessThanOrEqual(6);
    expect(lastJumpTo(map)).toEqual(expect.objectContaining({ center: [70, 80], zoom: 16 }));
    const overlay = document.querySelector<HTMLElement>(".map-reticle");
    expect(overlay).toHaveClass("map-reticle--targeted");
    expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
    expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
  });

  it("refocuses point targets when coordinates change under the same id", async () => {
    const { map, rerenderMap } = renderMapView();
    map.jumpTo.mockClear();

    rerenderMap({ focusTarget: { type: "point", id: "search-1", coordinates: [70, 80] } });
    await waitFor(() => expect(lastJumpTo(map)).toEqual(expect.objectContaining({ center: [70, 80], zoom: 16 })));

    map.jumpTo.mockClear();
    rerenderMap({ focusTarget: { type: "point", id: "search-1", coordinates: [90, 110] } });

    await waitFor(() => expect(lastJumpTo(map)).toEqual(expect.objectContaining({ center: [90, 110], zoom: 16 })));
  });

  it("zooms out before moving to a selected target from a tight view elsewhere", async () => {
    const { map, rerenderMap } = renderMapView();
    map.zoom = 16;
    map.center = { lng: -120, lat: 35 };
    map.jumpTo.mockClear();

    rerenderMap({ focusTarget: { type: "point", id: "search-1", coordinates: [-74, 40] } });

    await waitFor(() => expect(lastJumpTo(map)).toEqual(expect.objectContaining({ center: [-74, 40], zoom: 16 })));
    expect(map.jumpTo.mock.calls.some(([options]) => cameraCallMatches(options, [-120, 35], 7))).toBe(true);
    expect(map.jumpTo.mock.calls.some(([options]) => {
      const center = (options as { center?: [number, number] }).center;
      return Array.isArray(center) && center[0] > -120 && center[0] < -74 && center[1] > 35 && center[1] < 40;
    })).toBe(true);
    expect(map.jumpTo.mock.calls.some(([options]) => cameraCallMatches(options, [-74, 40], 7))).toBe(true);
  });

  it("retries entity focus when a selected entity becomes locatable", async () => {
    const focusTarget = { type: "entity", id: "asset-1" } as const;
    const { map, rerenderMap } = renderMapView({
      focusTarget,
      sources: buildMapSources([entity({ entity_id: "asset-1" })], undefined)
    });
    map.jumpTo.mockClear();

    rerenderMap({
      focusTarget,
      sources: buildMapSources(
        [entity({ entity_id: "asset-1", components: { telemetry: { latitude: 40, longitude: -74 } } })],
        undefined
      )
    });

    await waitFor(() => expect(lastJumpTo(map)).toEqual(expect.objectContaining({ center: [-74, 40], zoom: 16 })));
  });

  it("focuses selected geometry targets with fitBounds", async () => {
    const { map, rerenderMap } = renderMapView();
    map.easeTo.mockClear();
    map.fitBounds.mockClear();
    map.jumpTo.mockClear();

    rerenderMap({
      focusTarget: {
        type: "geometry",
        id: "area-1",
        geometry: {
          type: "LineString",
          coordinates: [
            [-75, 40],
            [-73, 42]
          ]
        }
      }
    });

    await waitFor(() => expect(lastJumpTo(map)).toEqual(expect.objectContaining({ center: [-74, 41], zoom: 16 })));
    expect(map.cameraForBounds).toHaveBeenCalledWith([[-75, 40], [-73, 42]], { maxZoom: 16, padding: 48 });
    expect(map.easeTo).not.toHaveBeenCalled();
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

type RenderMapViewProps = {
  focusTarget?: MapReticleTarget | null;
  onStyleSwitchError?: (error: { failedStyleId: string; activeStyleId: string }) => void;
  previewTarget?: MapReticleTarget | null;
  sources?: MapSources;
  styleId?: string;
  style?: StyleSpecification;
};

function renderMapView(props: RenderMapViewProps = {}) {
  const onBackgroundClick = vi.fn();
  const onMapContextMenu = vi.fn();
  const onSelectEntity = vi.fn();
  const renderProps = { sources: buildMapSources([], undefined), styleId: "test-style", style: style("test-style"), ...props };
  const result = render(
    <MapView
      sources={renderProps.sources}
      styleId={renderProps.styleId}
      style={renderProps.style}
      focusTarget={renderProps.focusTarget}
      previewTarget={renderProps.previewTarget}
      onBackgroundClick={onBackgroundClick}
      onMapContextMenu={onMapContextMenu}
      onSelectEntity={onSelectEntity}
      onStyleSwitchError={renderProps.onStyleSwitchError}
    />
  );

  const canvas = screen.getByTestId("map-canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect(10, 20, 400, 200));
  const rerenderMap = (nextProps: RenderMapViewProps) => {
    Object.assign(renderProps, nextProps);
    result.rerender(
      <MapView
        sources={renderProps.sources}
        styleId={renderProps.styleId}
        style={renderProps.style}
        focusTarget={renderProps.focusTarget}
        previewTarget={renderProps.previewTarget}
        onBackgroundClick={onBackgroundClick}
        onMapContextMenu={onMapContextMenu}
        onSelectEntity={onSelectEntity}
        onStyleSwitchError={renderProps.onStyleSwitchError}
      />
    );
  };
  return { canvas, map: maplibreMock.FakeMap.instances[0], onBackgroundClick, onMapContextMenu, onSelectEntity, rerenderMap };
}

function style(id: string, metadata: Record<string, unknown> = {}): StyleSpecification {
  return { version: 8, sources: {}, layers: [], metadata: { id, ...metadata } };
}

function appendMarker(container: HTMLElement, entityId: string, markerRect: DOMRect | (() => DOMRect)): HTMLButtonElement {
  const marker = document.createElement("button");
  marker.className = "map-symbol-marker";
  marker.dataset.entityId = entityId;
  const rectMock = vi.spyOn(marker, "getBoundingClientRect");
  if (typeof markerRect === "function") {
    rectMock.mockImplementation(markerRect);
  } else {
    rectMock.mockReturnValue(markerRect);
  }
  container.appendChild(marker);
  return marker;
}

function firePointerMove(target: Element, init: MouseEventInit): void {
  fireEvent(target, new MouseEvent("pointermove", { bubbles: true, cancelable: true, ...init }));
}

function markerSources(): MapSources {
  return buildMapSources(
    [
      entity({
        entity_id: "asset-1",
        alias: "Rover",
        components: { telemetry: { latitude: 40, longitude: -74 } }
      })
    ],
    undefined
  );
}

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

function entity(overrides: Partial<EntityResource>): EntityResource {
  return { entity_id: "entity", entity_type: "asset", subtype: null, alias: null, components: {}, metadata, ...overrides };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect;
}
