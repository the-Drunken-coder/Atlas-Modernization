import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityResource } from "../../../../atlas_sdk/src/index.js";
import { MapView, buildMapSources, type MapReticleTarget } from "./MapView.js";
import type { MapSources } from "./map-sources.js";

type PointLike = { x: number; y: number };
type Listener = (event?: unknown) => void;

const maplibreMock = vi.hoisted(() => {
  class FakeMap {
    static instances: FakeMap[] = [];

    readonly options: Record<string, unknown>;
    readonly listeners = new Map<string, Listener[]>();
    readonly easeTo = vi.fn();
    readonly fitScreenCoordinates = vi.fn();
    readonly fitBounds = vi.fn();
    readonly resize = vi.fn();
    readonly remove = vi.fn();
    readonly addControl = vi.fn();
    readonly addSource = vi.fn();
    readonly addLayer = vi.fn();
    readonly queryRenderedFeatures = vi.fn(() => []);
    readonly getBearing = vi.fn(() => 0);
    readonly getZoom = vi.fn(() => 4);
    readonly getSource = vi.fn(() => ({ setData: vi.fn() }));
    readonly project = vi.fn((position: [number, number]) => ({ x: position[0], y: position[1] }));

    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeMap.instances.push(this);
    }

    getContainer(): HTMLElement {
      return this.options.container as HTMLElement;
    }

    isStyleLoaded(): boolean {
      return true;
    }

    on(type: string, listener: Listener): this {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      return this;
    }

    off(type: string, listener: Listener): this {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((current) => current !== listener)
      );
      return this;
    }

    fire(type: string, event?: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
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
    callback(0);
    return 1;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MapView hover target box", () => {
  it("fits a padded rectangle around hovered map markers instead of forcing a square", async () => {
    const { canvas } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 28, 40));

    fireEvent.pointerMove(marker, { clientX: 80, clientY: 100 });

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

    fireEvent.mouseMove(canvas, { clientX: 80, clientY: 100 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-width")).toBe("22px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-height")).toBe("22px");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
    });
  });

  it("keeps a hovered marker box aligned while the map camera moves", async () => {
    const { canvas, map } = renderMapView();
    let markerRect = rect(70, 90, 28, 40);
    const marker = appendMarker(canvas, "asset-1", () => markerRect);

    fireEvent.pointerMove(marker, { clientX: 80, clientY: 100 });
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

    fireEvent.pointerMove(marker, { clientX: 80, clientY: 100 });
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

      fireEvent.pointerMove(canvas, { clientX: 30, clientY: 40 });

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

      fireEvent.mouseMove(canvas, { clientX: 90, clientY: 110 });

      const movedOverlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(movedOverlay).toHaveClass("map-reticle--targeted");
      expect(movedOverlay?.style.getPropertyValue("--map-reticle-target-x")).toBe("103px");
      expect(movedOverlay?.style.getPropertyValue("--map-reticle-target-y")).toBe("33px");

      fireEvent.mouseMove(canvas, { clientX: 170, clientY: 150 });

      const releasedOverlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(releasedOverlay).not.toHaveClass("map-reticle--targeted");
      expect(releasedOverlay?.style.getPropertyValue("--map-reticle-x")).toBe("204px");
      expect(releasedOverlay?.style.getPropertyValue("--map-reticle-y")).toBe("100px");
      expect(releasedOverlay?.style.getPropertyValue("--map-reticle-target-x")).toBe("193px");
      expect(releasedOverlay?.style.getPropertyValue("--map-reticle-target-y")).toBe("89px");
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps normal boxed entity click selection outside zoom drag", async () => {
    const { canvas, onBackgroundClick, onSelectEntity } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    fireEvent.pointerMove(marker, { clientX: 80, clientY: 100 });
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

  it("focuses selected point targets with easeTo and keeps a fallback reticle", async () => {
    const { map, rerenderMap } = renderMapView();
    map.easeTo.mockClear();
    map.fitBounds.mockClear();

    rerenderMap({ focusTarget: { type: "point", id: "search-1", coordinates: [70, 80] } });

    await waitFor(() => expect(map.easeTo).toHaveBeenCalledWith({ center: [70, 80], duration: 450, zoom: 6 }));
    expect(map.fitBounds).not.toHaveBeenCalled();
    const overlay = document.querySelector<HTMLElement>(".map-reticle");
    expect(overlay).toHaveClass("map-reticle--targeted");
    expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
    expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
  });

  it("refocuses point targets when coordinates change under the same id", async () => {
    const { map, rerenderMap } = renderMapView();
    map.easeTo.mockClear();

    rerenderMap({ focusTarget: { type: "point", id: "search-1", coordinates: [70, 80] } });
    await waitFor(() => expect(map.easeTo).toHaveBeenCalledWith({ center: [70, 80], duration: 450, zoom: 6 }));

    rerenderMap({ focusTarget: { type: "point", id: "search-1", coordinates: [90, 110] } });

    await waitFor(() => expect(map.easeTo).toHaveBeenLastCalledWith({ center: [90, 110], duration: 450, zoom: 6 }));
  });

  it("retries entity focus when a selected entity becomes locatable", async () => {
    const focusTarget = { type: "entity", id: "asset-1" } as const;
    const { map, rerenderMap } = renderMapView({
      focusTarget,
      sources: buildMapSources([entity({ entity_id: "asset-1" })], undefined)
    });
    map.easeTo.mockClear();

    rerenderMap({
      focusTarget,
      sources: buildMapSources(
        [entity({ entity_id: "asset-1", components: { telemetry: { latitude: 40, longitude: -74 } } })],
        undefined
      )
    });

    await waitFor(() => expect(map.easeTo).toHaveBeenCalledWith({ center: [-74, 40], duration: 450, zoom: 6 }));
  });

  it("focuses selected geometry targets with fitBounds", async () => {
    const { map, rerenderMap } = renderMapView();
    map.easeTo.mockClear();
    map.fitBounds.mockClear();

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

    await waitFor(() => expect(map.fitBounds).toHaveBeenCalledWith([[-75, 40], [-73, 42]], { duration: 450, maxZoom: 10, padding: 48 }));
    expect(map.easeTo).not.toHaveBeenCalled();
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

    fireEvent.pointerMove(marker, { clientX: 180, clientY: 130 });

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
  previewTarget?: MapReticleTarget | null;
  sources?: MapSources;
};

function renderMapView(props: RenderMapViewProps = {}) {
  const onBackgroundClick = vi.fn();
  const onMapContextMenu = vi.fn();
  const onSelectEntity = vi.fn();
  const renderProps = { sources: buildMapSources([], undefined), ...props };
  const result = render(
    <MapView
      sources={renderProps.sources}
      styleUrl="test-style"
      focusTarget={renderProps.focusTarget}
      previewTarget={renderProps.previewTarget}
      onBackgroundClick={onBackgroundClick}
      onMapContextMenu={onMapContextMenu}
      onSelectEntity={onSelectEntity}
    />
  );

  const canvas = screen.getByTestId("map-canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect(10, 20, 400, 200));
  const rerenderMap = (nextProps: RenderMapViewProps) => {
    Object.assign(renderProps, nextProps);
    result.rerender(
      <MapView
        sources={renderProps.sources}
        styleUrl="test-style"
        focusTarget={renderProps.focusTarget}
        previewTarget={renderProps.previewTarget}
        onBackgroundClick={onBackgroundClick}
        onMapContextMenu={onMapContextMenu}
        onSelectEntity={onSelectEntity}
      />
    );
  };
  return { canvas, map: maplibreMock.FakeMap.instances[0], onBackgroundClick, onMapContextMenu, onSelectEntity, rerenderMap };
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
