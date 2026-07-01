import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapView, buildMapSources } from "./MapView.js";

type Listener = (event?: unknown) => void;

const maplibreMock = vi.hoisted(() => {
  class FakeMap {
    static instances: FakeMap[] = [];

    readonly options: Record<string, unknown>;
    readonly listeners = new Map<string, Listener[]>();
    readonly fitBounds = vi.fn();
    readonly resize = vi.fn();
    readonly remove = vi.fn();
    readonly addControl = vi.fn();
    readonly addSource = vi.fn();
    readonly addLayer = vi.fn();
    readonly queryRenderedFeatures = vi.fn(() => []);
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
      const overlay = document.querySelector<HTMLElement>(".map-crosshair");
      expect(overlay?.style.getPropertyValue("--map-target-x")).toBe("53px");
      expect(overlay?.style.getPropertyValue("--map-target-y")).toBe("63px");
      expect(overlay?.style.getPropertyValue("--map-target-width")).toBe("42px");
      expect(overlay?.style.getPropertyValue("--map-target-height")).toBe("54px");
      expect(overlay?.style.getPropertyValue("--map-crosshair-x")).toBe("74px");
      expect(overlay?.style.getPropertyValue("--map-crosshair-y")).toBe("90px");
    });
  });

  it("keeps the default cursor target square when no marker is hovered", async () => {
    const { canvas } = renderMapView();

    fireEvent.mouseMove(canvas, { clientX: 80, clientY: 100 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-crosshair");
      expect(overlay?.style.getPropertyValue("--map-target-width")).toBe("22px");
      expect(overlay?.style.getPropertyValue("--map-target-height")).toBe("22px");
      expect(overlay?.style.getPropertyValue("--map-crosshair-x")).toBe("70px");
      expect(overlay?.style.getPropertyValue("--map-crosshair-y")).toBe("80px");
    });
  });
});

function renderMapView() {
  render(
    <MapView
      sources={buildMapSources([], undefined)}
      styleUrl="test-style"
      onBackgroundClick={vi.fn()}
      onMapContextMenu={vi.fn()}
      onSelectEntity={vi.fn()}
    />
  );

  const canvas = screen.getByTestId("map-canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect(10, 20, 400, 200));
  return { canvas };
}

function appendMarker(container: HTMLElement, entityId: string, markerRect: DOMRect): HTMLButtonElement {
  const marker = document.createElement("button");
  marker.className = "map-symbol-marker";
  marker.dataset.entityId = entityId;
  vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(markerRect);
  container.appendChild(marker);
  return marker;
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
