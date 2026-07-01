import maplibregl, { Marker, type Map as MlMap, type MapGeoJSONFeature, type MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import {
  addVertexAfter,
  displayGeometry,
  geometryVertices,
  moveVertex,
  removeVertex,
  type Position,
  type UiGeometry,
  type VertexRef
} from "../../atlas/geometry.js";
import { defaultSidcIconService } from "../symbols/sidc-symbol-service.js";
import { buildMapSources, emptyFeatureCollection, type MapFeature, type MapSources } from "./map-sources.js";
import { defaultMapStyle } from "./map-style.js";

const COLORS = {
  geofeature: "#3fd27a",
  geofeatureFill: "rgba(63,210,122,0.16)",
  selected: "#ffffff"
};

const INTERACTIVE_LAYERS = ["geofeatures-point", "geofeatures-line", "geofeatures-fill"];
const INITIAL_WORLD_BOUNDS: [[number, number], [number, number]] = [
  [-180, -80],
  [180, 85.051129]
];
const CROSSHAIR_TARGET_SIZE = 22;
const HOVER_TARGET_PADDING = 7;

export type MapContextMenuInfo = { lng: number; lat: number; x: number; y: number };

export type MapEditing = {
  geometry: UiGeometry;
  onChange: (geometry: UiGeometry) => void;
};

type MapViewProps = {
  sources: MapSources;
  styleUrl?: string;
  selectedId?: string;
  editing?: MapEditing;
  initialCenter?: [number, number];
  onSelectEntity: (id: string) => void;
  onMapContextMenu: (info: MapContextMenuInfo) => void;
  onBackgroundClick?: () => void;
};

type ScreenPoint = { x: number; y: number };
type TargetBox = { x: number; y: number; width: number; height: number };
type HoverTarget = { entityId: string; box: TargetBox };
type CrosshairState = ScreenPoint & { target: TargetBox; targetEntityId?: string };

export function MapView({ sources, styleUrl, editing, initialCenter, onSelectEntity, onMapContextMenu, onBackgroundClick }: MapViewProps) {
  const mapCanvasRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | undefined>(undefined);
  const readyRef = useRef(false);
  const fitWorldOnceRef = useRef(initialCenter !== undefined);
  const editMarkersRef = useRef<Marker[]>([]);
  const symbolMarkersRef = useRef<Marker[]>([]);
  const handlersRef = useRef({ onSelectEntity, onMapContextMenu, onBackgroundClick });
  const [mapError, setMapError] = useState<string>();
  const [mapReady, setMapReady] = useState(false);
  const [crosshair, setCrosshair] = useState<CrosshairState | null>(null);
  handlersRef.current = { onSelectEntity, onMapContextMenu, onBackgroundClick };

  // Create the map once.
  useEffect(() => {
    if (mapError) return;
    if (!containerRef.current) return;
    if (!webglAvailable()) {
      setMapError("MapLibre WebGL renderer is unavailable");
      return;
    }

    let map: MlMap;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: styleUrl ?? defaultMapStyle(),
        center: initialCenter ?? [0, 0],
        zoom: initialCenter ? 11 : 0,
        renderWorldCopies: false,
        dragRotate: false,
        pitchWithRotate: false,
        attributionControl: false
      });
    } catch (error) {
      setMapError(error instanceof Error ? error.message : "MapLibre failed to initialize");
      return;
    }

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    requestAnimationFrame(() => map.resize());

    const initializeLayers = () => {
      if (readyRef.current) return;
      registerSourcesAndLayers(map);
      readyRef.current = true;
      setMapReady(true);
      pushSources(map, sources);
      fitWorldOnce(map, fitWorldOnceRef);

      map.on("contextmenu", (event: MapMouseEvent) => {
        event.preventDefault();
        handlersRef.current.onMapContextMenu({
          lng: event.lngLat.lng,
          lat: event.lngLat.lat,
          x: event.originalEvent.clientX,
          y: event.originalEvent.clientY
        });
      });
    };

    map.on("style.load", initializeLayers);
    if (map.isStyleLoaded()) initializeLayers();
    map.on("error", (event) => {
      // Tile/style errors should not blank the operator picture. Keep overlays
      // alive and surface the details in devtools.
      console.warn("Map render warning", event.error);
    });

    return () => {
      readyRef.current = false;
      setMapReady(false);
      resizeObserver.disconnect();
      clearMarkers(editMarkersRef.current);
      clearMarkers(symbolMarkersRef.current);
      editMarkersRef.current = [];
      symbolMarkersRef.current = [];
      map.remove();
      mapRef.current = undefined;
    };
    // The map is created once; props are synced via the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapError]);

  // Sync entity sources.
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) {
      pushSources(map, sources);
    }
  }, [sources]);

  useEffect(() => {
    if (!crosshair) return;

    const clearWhenOutsideMap = (event: globalThis.MouseEvent | globalThis.PointerEvent) => {
      const mapCanvas = mapCanvasRef.current;
      if (!mapCanvas) return;
      const rect = mapCanvas.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
        setCrosshair(null);
      }
    };

    window.addEventListener("pointermove", clearWhenOutsideMap);
    window.addEventListener("mousemove", clearWhenOutsideMap);
    return () => {
      window.removeEventListener("pointermove", clearWhenOutsideMap);
      window.removeEventListener("mousemove", clearWhenOutsideMap);
    };
  }, [crosshair]);

  // Sync NATO-style asset/track DOM markers generated from the Atlas symbol catalog.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    clearMarkers(symbolMarkersRef.current);
    symbolMarkersRef.current = [];

    for (const feature of symbolMarkerFeatures(sources)) {
      const element = createSymbolMarkerElement(feature);
      element.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handlersRef.current.onSelectEntity(feature.properties.entityId);
        handlersRef.current.onMapContextMenu({
          lng: feature.geometry.coordinates[0],
          lat: feature.geometry.coordinates[1],
          x: event.clientX,
          y: event.clientY
        });
      });
      symbolMarkersRef.current.push(new Marker({ element, anchor: "center" }).setLngLat(feature.geometry.coordinates).addTo(map));
    }

    return () => {
      clearMarkers(symbolMarkersRef.current);
      symbolMarkersRef.current = [];
    };
  }, [sources, mapReady]);

  // Sync the editing overlay (live geometry + draggable handles).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    clearMarkers(editMarkersRef.current);
    editMarkersRef.current = [];

    const overlay = map.getSource("editing") as maplibregl.GeoJSONSource | undefined;
    if (!editing) {
      overlay?.setData(emptyFeatureCollection() as never);
      return;
    }

    overlay?.setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: displayGeometry(editing.geometry), properties: {} }] } as never);

    const { geometry, onChange } = editing;
    for (const vertex of geometryVertices(geometry)) {
      const element = document.createElement("div");
      element.className = "vertex-handle";
      element.title = "Drag to move - right-click to remove";
      const marker = new Marker({ element, draggable: true }).setLngLat([vertex.lng, vertex.lat]).addTo(map);
      marker.on("dragend", () => {
        const next = marker.getLngLat();
        onChange(moveVertex(geometry, vertex.ref, next.lng, next.lat));
      });
      element.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const next = removeVertex(geometry, vertex.ref);
        if (next) onChange(next);
      });
      editMarkersRef.current.push(marker);
    }

    // Midpoint "add" handles between consecutive vertices.
    for (const mid of midpoints(geometry)) {
      const element = document.createElement("div");
      element.className = "vertex-handle vertex-handle--mid";
      element.title = "Click to add a vertex";
      const marker = new Marker({ element, draggable: false }).setLngLat([mid.lng, mid.lat]).addTo(map);
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        onChange(addVertexAfter(geometry, mid.afterRef, mid.lng, mid.lat));
      });
      editMarkersRef.current.push(marker);
    }
  }, [editing, mapReady]);

  const updateCrosshair = (
    event: (PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) & { currentTarget: HTMLDivElement }
  ) => {
    if (event.target instanceof HTMLElement && event.target.closest(".maplibregl-control-container")) {
      setCrosshair(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const target = hoverSelectionTarget(event, rect, point, mapRef.current);
    setCrosshair({ ...point, target: targetSquare(point, target?.box ?? null), ...(target ? { targetEntityId: target.entityId } : {}) });
  };

  const onMapClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest(".maplibregl-control-container")) return;
    if (crosshair?.targetEntityId) {
      handlersRef.current.onSelectEntity(crosshair.targetEntityId);
      return;
    }
    handlersRef.current.onBackgroundClick?.();
  };

  const crosshairStyle = crosshair
    ? ({
        "--map-crosshair-x": `${crosshair.x}px`,
        "--map-crosshair-y": `${crosshair.y}px`,
        "--map-target-height": `${crosshair.target.height}px`,
        "--map-target-width": `${crosshair.target.width}px`,
        "--map-target-x": `${crosshair.target.x}px`,
        "--map-target-y": `${crosshair.target.y}px`
      } as CSSProperties)
    : undefined;

  return (
    <div
      className="map-canvas"
      ref={mapCanvasRef}
      style={{ position: "absolute", inset: 0 }}
      data-testid="map-canvas"
      onMouseMove={updateCrosshair}
      onMouseLeave={() => setCrosshair(null)}
      onPointerMove={updateCrosshair}
      onPointerLeave={() => setCrosshair(null)}
      onClick={onMapClick}
    >
      <div className="maplibre-host" ref={containerRef} />
      {crosshair ? (
        <div className="map-crosshair" style={crosshairStyle} aria-hidden="true">
          <div className="map-crosshair__line map-crosshair__line--left" />
          <div className="map-crosshair__line map-crosshair__line--right" />
          <div className="map-crosshair__line map-crosshair__line--top" />
          <div className="map-crosshair__line map-crosshair__line--bottom" />
          <div className="map-crosshair__target" />
        </div>
      ) : null}
      {mapError ? (
        <div className="map-unavailable" role="status" aria-live="polite">
          <span>Map unavailable</span>
          <code>{mapError}</code>
        </div>
      ) : null}
    </div>
  );
}

type Midpoint = { lng: number; lat: number; afterRef: VertexRef };

function midpoints(geometry: UiGeometry): Midpoint[] {
  if (geometry.type === "Point" || geometry.type === "Feature") return [];
  const result: Midpoint[] = [];
  if (geometry.type === "LineString") {
    for (let index = 0; index < geometry.coordinates.length - 1; index++) {
      result.push(midpoint(geometry.coordinates[index], geometry.coordinates[index + 1], { kind: "LineString", index }));
    }
    return result;
  }
  for (const [ringIndex, ring] of geometry.coordinates.entries()) {
    const open = openRing(ring);
    for (let index = 0; index < open.length; index++) {
      const next = open[(index + 1) % open.length];
      if (!next) continue;
      result.push(midpoint(open[index], next, { kind: "Polygon", ring: ringIndex, index }));
    }
  }
  return result;
}

function midpoint(current: Position, next: Position, afterRef: VertexRef): Midpoint {
  return { lng: (current[0] + next[0]) / 2, lat: (current[1] + next[1]) / 2, afterRef };
}

function openRing(ring: Position[]): Position[] {
  if (ring.length >= 2 && positionsEqual(ring[0], ring[ring.length - 1])) {
    return ring.slice(0, -1);
  }
  return [...ring];
}

function positionsEqual(a: Position | undefined, b: Position | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function hoverSelectionTarget(
  event: (PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) & { currentTarget: HTMLDivElement },
  mapRect: DOMRect,
  point: ScreenPoint,
  map: MlMap | undefined
): HoverTarget | null {
  if (event.target instanceof Element) {
    const element = event.target.closest<HTMLElement>(".map-symbol-marker");
    const entityId = element?.dataset.entityId;
    if (element && entityId && event.currentTarget.contains(element)) {
      return { entityId, box: boxFromElement(element, mapRect) };
    }
  }

  if (!map) return null;
  try {
    const features = map.queryRenderedFeatures([point.x, point.y], { layers: INTERACTIVE_LAYERS });
    for (const feature of features) {
      const box = boxFromFeature(map, feature);
      const entityId = feature.properties?.entityId;
      if (box && typeof entityId === "string") return { entityId, box };
    }
  } catch {
    return null;
  }
  return null;
}

function squareAround(point: ScreenPoint, size: number): TargetBox {
  return { x: point.x - size / 2, y: point.y - size / 2, width: size, height: size };
}

function targetSquare(point: ScreenPoint, target: TargetBox | null): TargetBox {
  if (!target) return squareAround(point, CROSSHAIR_TARGET_SIZE);
  const side =
    Math.max(
      CROSSHAIR_TARGET_SIZE,
      Math.abs(point.x - target.x) * 2 + HOVER_TARGET_PADDING * 2,
      Math.abs(point.x - (target.x + target.width)) * 2 + HOVER_TARGET_PADDING * 2,
      Math.abs(point.y - target.y) * 2 + HOVER_TARGET_PADDING * 2,
      Math.abs(point.y - (target.y + target.height)) * 2 + HOVER_TARGET_PADDING * 2
    );
  return squareAround(point, side);
}

function boxFromElement(element: HTMLElement, mapRect: DOMRect): TargetBox {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left - mapRect.left,
    y: rect.top - mapRect.top,
    width: rect.width,
    height: rect.height
  };
}

function boxFromFeature(map: MlMap, feature: MapGeoJSONFeature): TargetBox | null {
  const points = collectLngLatPositions(feature.geometry.coordinates).map((position) => {
    const projected = map.project([position[0], position[1]]);
    return { x: projected.x, y: projected.y };
  });
  if (points.length === 0) return null;

  const xValues = points.map((position) => position.x);
  const yValues = points.map((position) => position.y);
  return {
    x: Math.min(...xValues),
    y: Math.min(...yValues),
    width: Math.max(...xValues) - Math.min(...xValues),
    height: Math.max(...yValues) - Math.min(...yValues)
  };
}

function collectLngLatPositions(value: unknown): Position[] {
  if (isLngLatPosition(value)) return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap(collectLngLatPositions);
}

function isLngLatPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

function pushSources(map: MlMap, sources: MapSources): void {
  (map.getSource("geofeatures") as maplibregl.GeoJSONSource | undefined)?.setData(sources.geofeatures as never);
}

function registerSourcesAndLayers(map: MlMap): void {
  for (const id of ["geofeatures", "editing"]) {
    map.addSource(id, { type: "geojson", data: emptyFeatureCollection() as never });
  }

  map.addLayer({
    id: "geofeatures-fill",
    type: "fill",
    source: "geofeatures",
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": COLORS.geofeatureFill, "fill-outline-color": COLORS.geofeature }
  });
  map.addLayer({
    id: "geofeatures-line",
    type: "line",
    source: "geofeatures",
    filter: ["match", ["geometry-type"], ["LineString", "Polygon"], true, false],
    paint: {
      "line-color": COLORS.geofeature,
      "line-width": ["case", ["boolean", ["get", "selected"], false], 3.5, 2]
    }
  });
  map.addLayer({
    id: "geofeatures-point",
    type: "circle",
    source: "geofeatures",
    filter: ["==", ["geometry-type"], "Point"],
    paint: circlePaint(COLORS.geofeature)
  });

  // Editing overlay drawn above everything.
  map.addLayer({
    id: "editing-fill",
    type: "fill",
    source: "editing",
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": "rgba(63,182,255,0.18)" }
  });
  map.addLayer({
    id: "editing-line",
    type: "line",
    source: "editing",
    filter: ["match", ["geometry-type"], ["LineString", "Polygon"], true, false],
    paint: { "line-color": COLORS.selected, "line-width": 2, "line-dasharray": [2, 1.5] }
  });
}

function circlePaint(color: string): maplibregl.CircleLayerSpecification["paint"] {
  return {
    "circle-radius": ["case", ["boolean", ["get", "selected"], false], 7, 5],
    "circle-color": color,
    "circle-stroke-width": ["case", ["boolean", ["get", "selected"], false], 3, 1.5],
    "circle-stroke-color": ["case", ["boolean", ["get", "selected"], false], COLORS.selected, "rgba(0,0,0,0.65)"]
  };
}

function symbolMarkerFeatures(sources: MapSources): Array<MapFeature & { geometry: { type: "Point"; coordinates: [number, number] } }> {
  return [...sources.assets.features, ...sources.tracks.features].filter(isPointFeature);
}

function isPointFeature(feature: MapFeature): feature is MapFeature & { geometry: { type: "Point"; coordinates: [number, number] } } {
  const [longitude, latitude] = feature.geometry.coordinates;
  return (
    feature.geometry.type === "Point" &&
    Array.isArray(feature.geometry.coordinates) &&
    feature.geometry.coordinates.length >= 2 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90
  );
}

function createSymbolMarkerElement(feature: MapFeature & { geometry: { type: "Point"; coordinates: [number, number] } }): HTMLButtonElement {
  const { properties } = feature;
  const opacity = properties.linkState === "disconnected" ? 0.58 : properties.linkState === "degraded" ? 0.82 : 1;
  const rotation = properties.kind === "asset" ? properties.heading : undefined;
  const symbol =
    properties.kind === "track"
      ? defaultSidcIconService.getTrackSymbol({ type: properties.symbolType ?? properties.subtype ?? properties.classification ?? properties.name })
      : defaultSidcIconService.getAssetSymbol({
          entityId: properties.entityId,
          entityType: properties.entityType,
          modelId: properties.modelId,
          assetType: properties.assetType,
          symbolType: properties.symbolType,
          subtype: properties.subtype
        });
  const rendered = defaultSidcIconService.render(symbol, { selected: properties.selected, opacity, rotation });
  const element = document.createElement("button");
  element.type = "button";
  element.className = [
    "map-symbol-marker",
    `map-symbol-marker--${properties.kind}`,
    properties.selected ? "map-symbol-marker--selected" : "",
    rendered.isFallback ? "map-symbol-marker--fallback" : ""
  ]
    .filter(Boolean)
    .join(" ");
  element.title = properties.name;
  element.setAttribute("aria-label", `${properties.name} ${properties.kind}`);
  element.dataset.entityId = properties.entityId;
  element.innerHTML = rendered.html;
  return element;
}

function clearMarkers(markers: Marker[]): void {
  for (const marker of markers) marker.remove();
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl"));
  } catch {
    return false;
  }
}

function fitWorldOnce(map: MlMap, fitWorldOnceRef: { current: boolean }): void {
  if (fitWorldOnceRef.current) return;
  fitWorldOnceRef.current = true;
  map.fitBounds(INITIAL_WORLD_BOUNDS, { padding: 0, duration: 0 });
}

export { buildMapSources };
