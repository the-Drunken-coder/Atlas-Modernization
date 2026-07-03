import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityResource } from "../../../../atlas_sdk/src/index.js";
import { MapView, buildMapSources } from "./MapView.js";

type Handler = (event?: { error?: Error }) => void;

const maplibreMock = vi.hoisted(() => {
  class MockMap {
    readonly handlers = new globalThis.Map<string, Array<{ handler: Handler; once: boolean }>>();
    readonly sources = new globalThis.Map<string, { setData: ReturnType<typeof vi.fn> }>();
    readonly layers = new globalThis.Map<string, unknown>();
    loaded = false;
    style: unknown;
    setStyle = vi.fn((style: unknown) => {
      this.style = style;
      this.loaded = false;
      this.sources.clear();
      this.layers.clear();
      return this;
    });

    constructor(options: { style: string }) {
      this.style = options.style;
      maplibreMock.maps.push(this);
    }

    addControl() {
      return this;
    }

    resize() {}

    remove() {}

    isStyleLoaded() {
      return this.loaded;
    }

    on(event: string, layerOrHandler: string | Handler, maybeHandler?: Handler) {
      const handler = typeof layerOrHandler === "function" ? layerOrHandler : maybeHandler;
      if (handler) this.addHandler(event, handler, false);
      return this;
    }

    once(event: string, handler: Handler) {
      this.addHandler(event, handler, true);
      return this;
    }

    emit(event: string, payload: { error?: Error } = {}) {
      if (event === "style.load") this.loaded = true;
      const handlers = [...(this.handlers.get(event) ?? [])];
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((entry) => !entry.once)
      );
      for (const entry of handlers) entry.handler(payload);
    }

    getCanvas() {
      return { style: {} };
    }

    queryRenderedFeatures() {
      return [];
    }

    getSource(id: string) {
      return this.sources.get(id);
    }

    addSource(id: string) {
      this.sources.set(id, { setData: vi.fn() });
    }

    getLayer(id: string) {
      return this.layers.get(id);
    }

    addLayer(layer: { id: string }) {
      this.layers.set(layer.id, layer);
    }

    fitBounds() {}

    private addHandler(event: string, handler: Handler, once: boolean) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), { handler, once }]);
    }
  }

  class MockMarker {
    added = false;
    removed = false;

    constructor() {
      maplibreMock.markers.push(this);
    }

    setLngLat() {
      return this;
    }

    addTo() {
      this.added = true;
      return this;
    }

    remove() {
      this.removed = true;
    }
  }

  class MockNavigationControl {}

  return {
    maps: [] as MockMap[],
    markers: [] as MockMarker[],
    MockMap,
    MockMarker,
    MockNavigationControl
  };
});

vi.mock("maplibre-gl", () => ({
  default: {
    Map: maplibreMock.MockMap,
    Marker: maplibreMock.MockMarker,
    NavigationControl: maplibreMock.MockNavigationControl,
    LngLatBounds: class {}
  },
  Marker: maplibreMock.MockMarker,
  NavigationControl: maplibreMock.MockNavigationControl,
  LngLatBounds: class {}
}));

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

const asset: EntityResource = {
  entity_id: "asset-1",
  entity_type: "asset",
  subtype: "ground_rover",
  alias: "Rover",
  components: { telemetry: { latitude: 40, longitude: -74 } },
  metadata
};

beforeEach(() => {
  maplibreMock.maps.length = 0;
  maplibreMock.markers.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
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

describe("MapView", () => {
  it("creates symbol markers after the initial style load", async () => {
    renderMap({ styleUrl: "/maps/styles/a.json" });
    const map = currentMap();

    act(() => map.emit("style.load"));

    await waitFor(() => expect(activeMarkers()).toHaveLength(1));
    expect(map.sources.has("geofeatures")).toBe(true);
  });

  it("keeps existing symbol markers when a style prefetch fails", async () => {
    const onStyleSwitchError = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 503 })));

    const view = renderMap({ styleUrl: "/maps/styles/a.json", onStyleSwitchError });
    const map = currentMap();
    act(() => map.emit("style.load"));
    await waitFor(() => expect(activeMarkers()).toHaveLength(1));

    view.rerender(renderMapElement({ styleUrl: "/maps/styles/b.json", onStyleSwitchError }));

    await waitFor(() =>
      expect(onStyleSwitchError).toHaveBeenCalledWith({
        failedStyleUrl: "/maps/styles/b.json",
        activeStyleUrl: "/maps/styles/a.json"
      })
    );
    expect(activeMarkers()).toHaveLength(1);
    expect(map.setStyle).not.toHaveBeenCalled();
  });

  it("sets a prefetched style and re-registers overlays after style load", async () => {
    const nextStyle = { version: 8, sources: {}, layers: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(nextStyle), { status: 200, headers: { "Content-Type": "application/json" } }))
    );

    const view = renderMap({ styleUrl: "/maps/styles/a.json" });
    const map = currentMap();
    act(() => map.emit("style.load"));
    await waitFor(() => expect(activeMarkers()).toHaveLength(1));

    view.rerender(renderMapElement({ styleUrl: "/maps/styles/b.json" }));

    await waitFor(() => expect(map.setStyle).toHaveBeenCalledWith(nextStyle));
    expect(map.sources.has("geofeatures")).toBe(false);

    act(() => map.emit("style.load"));

    await waitFor(() => expect(map.sources.has("geofeatures")).toBe(true));
    expect(activeMarkers()).toHaveLength(1);
  });
});

function renderMap(props: { styleUrl: string; onStyleSwitchError?: (error: { failedStyleUrl: string; activeStyleUrl: string }) => void }) {
  return render(renderMapElement(props));
}

function renderMapElement({ styleUrl, onStyleSwitchError }: { styleUrl: string; onStyleSwitchError?: (error: { failedStyleUrl: string; activeStyleUrl: string }) => void }) {
  return (
    <MapView
      sources={buildMapSources([asset], undefined)}
      styleUrl={styleUrl}
      onSelectEntity={() => {}}
      onMapContextMenu={() => {}}
      onStyleSwitchError={onStyleSwitchError}
    />
  );
}

function currentMap() {
  const map = maplibreMock.maps[0];
  if (!map) throw new Error("Map was not created");
  return map;
}

function activeMarkers() {
  return maplibreMock.markers.filter((marker) => marker.added && !marker.removed);
}
