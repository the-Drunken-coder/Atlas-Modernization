import { fireEvent, render, screen } from "@testing-library/react";
import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import type { StyleSpecification } from "maplibre-gl";
import { afterEach, beforeEach, vi } from "vitest";
import type { MapSourceConfig } from "../../../app/config.js";
import type { MapCameraCommand } from "../interaction/map-camera.js";
import type { MapReticleTarget } from "../interaction/map-targets.js";
import type { MapEditing } from "../rendering/map-editing.js";
import { buildMapSources, type MapSources } from "../rendering/map-sources.js";
import { type MapSpatialInteraction, MapView } from "./MapView.js";

export type PointLike = { x: number; y: number };

type Listener = (event?: unknown) => void;
type ListenerEntry = { listener: Listener; once: boolean };
type RenderedFeature = {
  geometry: { type: string; coordinates: unknown };
  properties?: { entityId?: string; featureId?: string };
};
type ResizeObserverRecord = { active: boolean; callback: ResizeObserverCallback; targets: Set<Element> };

let resizeObservers: ResizeObserverRecord[] = [];
let animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrameId = 0;

const maplibreMock = vi.hoisted(() => {
  const markerOperations = { created: 0, setLngLat: 0, addTo: 0, remove: 0 };
  const markerCoordinates = new WeakMap<HTMLElement, [number, number]>();
  let nextDetailMapStyleLoaded = true;

  class FakeMap {
    static instances: FakeMap[] = [];

    readonly options: Record<string, unknown>;
    readonly listeners = new Map<string, ListenerEntry[]>();
    readonly sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    readonly layers = new Map<string, unknown>();
    readonly easeTo = vi.fn();
    readonly flyTo = vi.fn();
    readonly stop = vi.fn();
    readonly setRenderWorldCopies = vi.fn((value: boolean) => {
      this.renderWorldCopies = value;
    });
    readonly getRenderWorldCopies = vi.fn(() => this.renderWorldCopies);
    readonly fitScreenCoordinates = vi.fn();
    readonly fitBounds = vi.fn();
    readonly zoomTo = vi.fn();
    readonly jumpTo = vi.fn();
    readonly getCenter = vi.fn(() => this.center);
    readonly resize = vi.fn((eventData?: unknown) => {
      this.fire("movestart", eventData);
      this.fire("moveend", eventData);
      return this;
    });
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
    readonly getPitch = vi.fn(() => 0);
    readonly getZoom = vi.fn(() => this.zoom);
    readonly getBounds = vi.fn(
      (): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number } => ({
        getWest: () => -20,
        getSouth: () => -10,
        getEast: () => 20,
        getNorth: () => 10
      })
    );
    readonly getLayer = vi.fn((id: string) => this.layers.get(id));
    readonly getSource = vi.fn((id: string) => this.sources.get(id));
    readonly cameraForBounds = vi.fn(
      (bounds: [[number, number], [number, number]], options?: { maxZoom?: number }) => ({
        center: { lng: (bounds[0][0] + bounds[1][0]) / 2, lat: (bounds[0][1] + bounds[1][1]) / 2 },
        zoom: options?.maxZoom ?? 16,
        bearing: 0
      })
    );
    readonly project = vi.fn((position: [number, number]) => ({ x: position[0], y: position[1] }));
    readonly unproject = vi.fn((point: [number, number] | { x: number; y: number }) =>
      Array.isArray(point) ? { lng: point[0], lat: point[1] } : { lng: point.x, lat: point.y }
    );
    readonly scrollZoom = {
      disable: vi.fn(),
      enable: vi.fn(),
      isEnabled: vi.fn(() => true)
    };
    readonly touchZoomRotate = { disableRotation: vi.fn() };
    readonly setStyle = vi.fn((style: unknown) => {
      if ((style as { metadata?: { throwOnSetStyle?: boolean } }).metadata?.throwOnSetStyle)
        throw new Error("bad style");
      this.style = style;
      this.loaded = false;
      this.sources.clear();
      this.layers.clear();
      return this;
    });
    loaded = true;
    renderWorldCopies: boolean;
    style: unknown;
    center = { lng: 0, lat: 0 };
    zoom = 4;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.style = options.style;
      this.renderWorldCopies = Boolean(options.renderWorldCopies);
      this.loaded =
        options.interactive === false
          ? nextDetailMapStyleLoaded
          : !(this.style as { metadata?: { initialStyleLoading?: boolean } }).metadata?.initialStyleLoading;
      if (options.interactive === false) nextDetailMapStyleLoaded = true;
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
    coordinates: [number, number] = [0, 0];

    constructor(options?: { element?: HTMLElement; anchor?: string }) {
      this.element = options?.element;
      this.element?.classList.add("maplibregl-marker", `maplibregl-marker-anchor-${options?.anchor ?? "center"}`);
      markerOperations.created += 1;
    }

    setLngLat(coordinates: [number, number]): this {
      this.coordinates = [...coordinates];
      if (this.element) markerCoordinates.set(this.element, this.coordinates);
      markerOperations.setLngLat += 1;
      return this;
    }

    addTo(map: FakeMap): this {
      markerOperations.addTo += 1;
      if (this.element) map.getContainer().appendChild(this.element);
      return this;
    }

    remove(): void {
      markerOperations.remove += 1;
      this.element?.remove();
    }

    on(): this {
      return this;
    }

    getLngLat(): { lng: number; lat: number } {
      return { lng: this.coordinates[0], lat: this.coordinates[1] };
    }
  }

  class FakeControl {}

  return {
    FakeControl,
    FakeMap,
    FakeMarker,
    markerCoordinates,
    markerOperations,
    setNextDetailMapStyleLoaded: (loaded: boolean) => {
      nextDetailMapStyleLoaded = loaded;
    }
  };
});

vi.mock("maplibre-gl", () => ({
  default: {
    Map: maplibreMock.FakeMap,
    Marker: maplibreMock.FakeMarker,
    NavigationControl: maplibreMock.FakeControl
  },
  Map: maplibreMock.FakeMap,
  Marker: maplibreMock.FakeMarker,
  NavigationControl: maplibreMock.FakeControl
}));

vi.mock("../runtime/maplibre-runtime.js", () => ({
  getMapLibreRuntime: () => ({
    Map: maplibreMock.FakeMap,
    Marker: maplibreMock.FakeMarker,
    NavigationControl: maplibreMock.FakeControl
  }),
  loadMapLibre: vi.fn()
}));

vi.mock("../../symbols/sidc-runtime.js", () => ({
  getSidcRuntime: () => ({}),
  loadSidcRuntime: vi.fn(),
  renderSymbol: (sidc: string) => ({
    anchor: { x: 0, y: 0 },
    sidc,
    size: { height: 1, width: 1 },
    svg: "<svg />"
  })
}));

beforeEach(() => {
  maplibreMock.FakeMap.instances.length = 0;
  maplibreMock.setNextDetailMapStyleLoaded(true);
  resetMarkerOperationCounts();
  resizeObservers = [];
  animationFrames = new Map();
  nextAnimationFrameId = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({}) as CanvasRenderingContext2D);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly record: ResizeObserverRecord;

      constructor(callback: ResizeObserverCallback) {
        this.record = { active: true, callback, targets: new Set() };
        resizeObservers.push(this.record);
      }

      observe(target: Element) {
        this.record.targets.add(target);
      }

      unobserve(target: Element) {
        this.record.targets.delete(target);
      }

      disconnect() {
        this.record.active = false;
        this.record.targets.clear();
      }
    }
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const frameId = ++nextAnimationFrameId;
    animationFrames.set(frameId, callback);
    queueMicrotask(() => {
      const pending = animationFrames.get(frameId);
      if (!pending) return;
      animationFrames.delete(frameId);
      pending(0);
    });
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (frameId: number) => animationFrames.delete(frameId));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type RenderMapViewProps = {
  cameraCommand?: MapCameraCommand | null;
  editing?: MapEditing;
  focusTarget?: MapReticleTarget | null;
  mapSourceOptions?: MapSourceConfig[];
  placeDetailTarget?: MapReticleTarget | null;
  onStyleSwitchError?: (error: { failedStyleId: string; activeStyleId: string }) => void;
  selectedId?: string;
  sources?: MapSources;
  spatial?: MapSpatialInteraction;
  styleId?: string;
  style?: StyleSpecification;
};

export function renderMapView(props: RenderMapViewProps = {}) {
  const onBackgroundClick = vi.fn();
  const onMapContextMenu = vi.fn();
  const onSelectEntity = vi.fn();
  const renderProps = {
    sources: buildMapSources([], undefined),
    styleId: "test-style",
    style: style("test-style"),
    mapSourceOptions: [] as MapSourceConfig[],
    ...props
  };
  const view = () => (
    <div className="map-stage" data-testid="map-stage">
      <MapView
        sources={renderProps.sources}
        styleId={renderProps.styleId}
        style={renderProps.style}
        mapSourceOptions={renderProps.mapSourceOptions}
        selectedId={renderProps.selectedId}
        editing={renderProps.editing}
        focusTarget={renderProps.focusTarget}
        placeDetailTarget={renderProps.placeDetailTarget}
        cameraCommand={renderProps.cameraCommand}
        spatial={renderProps.spatial}
        onBackgroundClick={onBackgroundClick}
        onMapContextMenu={onMapContextMenu}
        onSelectEntity={onSelectEntity}
        onStyleSwitchError={renderProps.onStyleSwitchError}
      />
    </div>
  );
  const result = render(view());

  const canvas = screen.getByTestId("map-canvas");
  const stage = screen.getByTestId("map-stage");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect(10, 20, 400, 200));
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(rect(10, 20, 400, 200));
  const rerenderMap = (nextProps: RenderMapViewProps) => {
    Object.assign(renderProps, nextProps);
    result.rerender(view());
  };
  return {
    canvas,
    stage,
    map: maplibreMock.FakeMap.instances.find((instance) => instance.options.interactive !== false)!,
    maps: () => [...maplibreMock.FakeMap.instances],
    onBackgroundClick,
    onMapContextMenu,
    onSelectEntity,
    rerenderMap,
    unmount: result.unmount
  };
}

export function mapInstances(): FakeMapInstance[] {
  return maplibreMock.FakeMap.instances;
}

export type FakeMapInstance = InstanceType<typeof maplibreMock.FakeMap>;

export function setNextDetailMapStyleLoaded(loaded: boolean): void {
  maplibreMock.setNextDetailMapStyleLoaded(loaded);
}

export function style(id: string, metadata: Record<string, unknown> = {}): StyleSpecification {
  return { version: 8, sources: {}, layers: [], metadata: { id, ...metadata } };
}

export function appendMarker(
  container: HTMLElement,
  entityId: string,
  markerRect: DOMRect | (() => DOMRect)
): HTMLButtonElement {
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

export function firePointerMove(target: Element, init: MouseEventInit): void {
  fireEvent(target, new MouseEvent("pointermove", { bubbles: true, cancelable: true, ...init }));
}

export function markerSources(): MapSources {
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

export function entity(overrides: Partial<EntityResource>): EntityResource {
  return {
    entity_id: "entity",
    entity_type: "asset",
    subtype: null,
    alias: null,
    components: {},
    metadata,
    ...overrides
  };
}

export function rect(left: number, top: number, width: number, height: number): DOMRect {
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

export function notifyResizeObservers(target?: Element): void {
  for (const observer of resizeObservers) {
    if (!observer.active || (target && !observer.targets.has(target))) continue;
    observer.callback([], {} as ResizeObserver);
  }
}

export function markerOperationCounts() {
  return { ...maplibreMock.markerOperations };
}

export function markerCoordinatesFor(element: HTMLElement): [number, number] | undefined {
  return maplibreMock.markerCoordinates.get(element);
}

export function resetMarkerOperationCounts(): void {
  maplibreMock.markerOperations.created = 0;
  maplibreMock.markerOperations.setLngLat = 0;
  maplibreMock.markerOperations.addTo = 0;
  maplibreMock.markerOperations.remove = 0;
}
