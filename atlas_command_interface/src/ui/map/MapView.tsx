import maplibregl, { Marker, type Map as MlMap, type MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { addVertexAfter, geometryVertices, moveVertex, removeVertex, type UiGeometry } from "../../atlas/geometry.js";
import { buildMapSources, emptyFeatureCollection, type MapFeature, type MapSources } from "./map-sources.js";
import { defaultDarkStyle } from "./map-style.js";

const COLORS = {
  asset: "#3fb6ff",
  track: "#f5c451",
  geofeature: "#3fd27a",
  geofeatureFill: "rgba(63,210,122,0.16)",
  selected: "#ffffff"
};

const INTERACTIVE_LAYERS = ["assets-point", "tracks-point", "geofeatures-point", "geofeatures-line", "geofeatures-fill"];

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

export function MapView({ sources, styleUrl, editing, initialCenter, onSelectEntity, onMapContextMenu, onBackgroundClick }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | undefined>(undefined);
  const readyRef = useRef(false);
  const fitOnceRef = useRef(false);
  const shouldAutoFitRef = useRef(initialCenter === undefined);
  const markersRef = useRef<Marker[]>([]);
  const handlersRef = useRef({ onSelectEntity, onMapContextMenu, onBackgroundClick });
  const [fallbackReason, setFallbackReason] = useState<string>();
  handlersRef.current = { onSelectEntity, onMapContextMenu, onBackgroundClick };

  // Create the map once.
  useEffect(() => {
    if (fallbackReason) return;
    if (!containerRef.current) return;
    if (!webglAvailable()) {
      setFallbackReason("MapLibre WebGL renderer is unavailable");
      return;
    }

    let map: MlMap;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: styleUrl ?? defaultDarkStyle(),
        center: initialCenter ?? [0, 20],
        zoom: initialCenter ? 11 : 1.6,
        attributionControl: { compact: true }
      });
    } catch (error) {
      setFallbackReason(error instanceof Error ? error.message : "MapLibre failed to initialize");
      return;
    }

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    requestAnimationFrame(() => map.resize());

    const initializeLayers = () => {
      if (readyRef.current) return;
      registerSourcesAndLayers(map);
      readyRef.current = true;
      pushSources(map, sources);
      if (shouldAutoFitRef.current) fitToSourcesOnce(map, sources, fitOnceRef);

      for (const layer of INTERACTIVE_LAYERS) {
        map.on("click", layer, (event) => {
          event.preventDefault();
          const id = event.features?.[0]?.properties?.entityId;
          if (typeof id === "string") handlersRef.current.onSelectEntity(id);
        });
        map.on("mouseenter", layer, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
        });
      }

      map.on("click", (event: MapMouseEvent) => {
        if (event.defaultPrevented) return;
        const hits = map.queryRenderedFeatures(event.point, { layers: INTERACTIVE_LAYERS });
        if (hits.length === 0) handlersRef.current.onBackgroundClick?.();
      });

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
      resizeObserver.disconnect();
      clearMarkers(markersRef.current);
      markersRef.current = [];
      map.remove();
      mapRef.current = undefined;
    };
    // The map is created once; props are synced via the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallbackReason]);

  // Sync entity sources.
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) {
      pushSources(map, sources);
      if (shouldAutoFitRef.current) fitToSourcesOnce(map, sources, fitOnceRef);
    }
  }, [sources]);

  // Sync the editing overlay (live geometry + draggable handles).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    clearMarkers(markersRef.current);
    markersRef.current = [];

    const overlay = map.getSource("editing") as maplibregl.GeoJSONSource | undefined;
    if (!editing) {
      overlay?.setData(emptyFeatureCollection() as never);
      return;
    }

    overlay?.setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: editing.geometry, properties: {} }] } as never);

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
      markersRef.current.push(marker);
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
      markersRef.current.push(marker);
    }
  }, [editing]);

  return (
    <div className="map-canvas" ref={containerRef} style={{ position: "absolute", inset: 0 }} data-testid="map-canvas">
      {fallbackReason ? (
        <FallbackMap
          sources={sources}
          reason={fallbackReason}
          onSelectEntity={onSelectEntity}
          onMapContextMenu={onMapContextMenu}
          onBackgroundClick={onBackgroundClick}
        />
      ) : null}
    </div>
  );
}

type Midpoint = { lng: number; lat: number; afterRef: ReturnType<typeof geometryVertices>[number]["ref"] };

function midpoints(geometry: UiGeometry): Midpoint[] {
  if (geometry.type === "Point") return [];
  const vertices = geometryVertices(geometry);
  const result: Midpoint[] = [];
  const wrap = geometry.type === "Polygon";
  for (let index = 0; index < vertices.length; index++) {
    const current = vertices[index];
    const nextIndex = index + 1;
    const next = vertices[nextIndex] ?? (wrap ? vertices[0] : undefined);
    if (!next) break;
    result.push({ lng: (current.lng + next.lng) / 2, lat: (current.lat + next.lat) / 2, afterRef: current.ref });
  }
  return result;
}

function pushSources(map: MlMap, sources: MapSources): void {
  (map.getSource("assets") as maplibregl.GeoJSONSource | undefined)?.setData(sources.assets as never);
  (map.getSource("tracks") as maplibregl.GeoJSONSource | undefined)?.setData(sources.tracks as never);
  (map.getSource("geofeatures") as maplibregl.GeoJSONSource | undefined)?.setData(sources.geofeatures as never);
}

function registerSourcesAndLayers(map: MlMap): void {
  for (const id of ["assets", "tracks", "geofeatures", "editing"]) {
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
  map.addLayer({ id: "tracks-point", type: "circle", source: "tracks", paint: circlePaint(COLORS.track) });
  map.addLayer({ id: "assets-point", type: "circle", source: "assets", paint: circlePaint(COLORS.asset) });

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

function fitToSourcesOnce(map: MlMap, sources: MapSources, fitOnceRef: { current: boolean }): void {
  if (fitOnceRef.current) return;
  const bounds = sourceBounds(sources);
  if (!bounds) return;
  fitOnceRef.current = true;
  map.fitBounds(bounds, { padding: 84, maxZoom: 5, duration: 0 });
}

function sourceBounds(sources: MapSources): maplibregl.LngLatBounds | undefined {
  let bounds: maplibregl.LngLatBounds | undefined;
  for (const feature of allFeatures(sources)) {
    forEachPosition(feature.geometry, (position) => {
      bounds = bounds ? bounds.extend(position) : new maplibregl.LngLatBounds(position, position);
    });
  }
  return bounds;
}

function allFeatures(sources: MapSources): MapFeature[] {
  return [...sources.assets.features, ...sources.tracks.features, ...sources.geofeatures.features];
}

function forEachPosition(geometry: UiGeometry, visitor: (position: [number, number]) => void): void {
  if (geometry.type === "Point") {
    visitor(geometry.coordinates);
    return;
  }
  if (geometry.type === "LineString") {
    for (const position of geometry.coordinates) visitor(position);
    return;
  }
  for (const ring of geometry.coordinates) {
    for (const position of ring) visitor(position);
  }
}

type FallbackMapProps = {
  sources: MapSources;
  reason: string;
  onSelectEntity: (id: string) => void;
  onMapContextMenu: (info: MapContextMenuInfo) => void;
  onBackgroundClick?: () => void;
};

const FALLBACK_WIDTH = 1000;
const FALLBACK_HEIGHT = 620;
const FALLBACK_PADDING = 44;

function FallbackMap({ sources, reason, onSelectEntity, onMapContextMenu, onBackgroundClick }: FallbackMapProps) {
  const features = allFeatures(sources);
  const viewport = fallbackViewport(features);

  const project = (position: [number, number]) => projectFallback(position, viewport);
  const unproject = (x: number, y: number): [number, number] => {
    const usableWidth = FALLBACK_WIDTH - FALLBACK_PADDING * 2;
    const usableHeight = FALLBACK_HEIGHT - FALLBACK_PADDING * 2;
    const lng = viewport.minLng + ((x - FALLBACK_PADDING) / usableWidth) * (viewport.maxLng - viewport.minLng);
    const lat = viewport.maxLat - ((y - FALLBACK_PADDING) / usableHeight) * (viewport.maxLat - viewport.minLat);
    return [clamp(lng, -180, 180), clamp(lat, -85, 85)];
  };

  function contextMenu(event: ReactMouseEvent<HTMLDivElement>): void {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * FALLBACK_WIDTH;
    const y = ((event.clientY - rect.top) / rect.height) * FALLBACK_HEIGHT;
    const [lng, lat] = unproject(x, y);
    onMapContextMenu({ lng, lat, x: event.clientX, y: event.clientY });
  }

  return (
    <div className="fallback-map" onClick={onBackgroundClick} onContextMenu={contextMenu}>
      <svg className="fallback-map__svg" viewBox={`0 0 ${FALLBACK_WIDTH} ${FALLBACK_HEIGHT}`} role="img" aria-label="Tactical fallback map">
        <FallbackGrid viewport={viewport} project={project} />
        {sources.geofeatures.features.map((feature) => (
          <FallbackGeometry key={feature.id} feature={feature} project={project} onSelectEntity={onSelectEntity} />
        ))}
        {sources.tracks.features.map((feature) => (
          <FallbackPoint key={feature.id} feature={feature} project={project} onSelectEntity={onSelectEntity} />
        ))}
        {sources.assets.features.map((feature) => (
          <FallbackPoint key={feature.id} feature={feature} project={project} onSelectEntity={onSelectEntity} />
        ))}
      </svg>
      <div className="fallback-map__badge">{reason}</div>
    </div>
  );
}

type FallbackViewport = { minLng: number; maxLng: number; minLat: number; maxLat: number };

function fallbackViewport(features: MapFeature[]): FallbackViewport {
  let minLng = -130;
  let maxLng = -60;
  let minLat = 20;
  let maxLat = 55;
  let hasPoint = false;
  for (const feature of features) {
    forEachPosition(feature.geometry, ([lng, lat]) => {
      if (!hasPoint) {
        minLng = lng;
        maxLng = lng;
        minLat = lat;
        maxLat = lat;
        hasPoint = true;
        return;
      }
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    });
  }
  const lngPad = Math.max(4, (maxLng - minLng) * 0.12);
  const latPad = Math.max(3, (maxLat - minLat) * 0.16);
  return {
    minLng: clamp(minLng - lngPad, -180, 180),
    maxLng: clamp(maxLng + lngPad, -180, 180),
    minLat: clamp(minLat - latPad, -85, 85),
    maxLat: clamp(maxLat + latPad, -85, 85)
  };
}

function projectFallback([lng, lat]: [number, number], viewport: FallbackViewport): { x: number; y: number } {
  const usableWidth = FALLBACK_WIDTH - FALLBACK_PADDING * 2;
  const usableHeight = FALLBACK_HEIGHT - FALLBACK_PADDING * 2;
  const x = FALLBACK_PADDING + ((lng - viewport.minLng) / (viewport.maxLng - viewport.minLng || 1)) * usableWidth;
  const y = FALLBACK_PADDING + ((viewport.maxLat - lat) / (viewport.maxLat - viewport.minLat || 1)) * usableHeight;
  return { x, y };
}

function FallbackGrid({
  viewport,
  project
}: {
  viewport: FallbackViewport;
  project: (position: [number, number]) => { x: number; y: number };
}) {
  const lngLines = gridValues(viewport.minLng, viewport.maxLng, 10);
  const latLines = gridValues(viewport.minLat, viewport.maxLat, 5);
  return (
    <g className="fallback-map__grid">
      {lngLines.map((lng) => {
        const top = project([lng, viewport.maxLat]);
        const bottom = project([lng, viewport.minLat]);
        return <line key={`lng-${lng}`} x1={top.x} y1={top.y} x2={bottom.x} y2={bottom.y} />;
      })}
      {latLines.map((lat) => {
        const left = project([viewport.minLng, lat]);
        const right = project([viewport.maxLng, lat]);
        return <line key={`lat-${lat}`} x1={left.x} y1={left.y} x2={right.x} y2={right.y} />;
      })}
    </g>
  );
}

function FallbackGeometry({
  feature,
  project,
  onSelectEntity
}: {
  feature: MapFeature;
  project: (position: [number, number]) => { x: number; y: number };
  onSelectEntity: (id: string) => void;
}) {
  if (feature.geometry.type === "Point") {
    return <FallbackPoint feature={feature} project={project} onSelectEntity={onSelectEntity} />;
  }
  if (feature.geometry.type === "LineString") {
    return <FallbackPath feature={feature} positions={feature.geometry.coordinates} project={project} onSelectEntity={onSelectEntity} />;
  }
  const [outer] = feature.geometry.coordinates;
  return (
    <g className={feature.properties.selected ? "fallback-feature fallback-feature--selected" : "fallback-feature"} onClick={(event) => selectFallback(event, feature, onSelectEntity)}>
      <polygon points={points(outer, project)} className="fallback-feature__fill" />
      <polyline points={points(outer, project)} className="fallback-feature__line" />
    </g>
  );
}

function FallbackPath({
  feature,
  positions,
  project,
  onSelectEntity
}: {
  feature: MapFeature;
  positions: [number, number][];
  project: (position: [number, number]) => { x: number; y: number };
  onSelectEntity: (id: string) => void;
}) {
  return (
    <polyline
      className={feature.properties.selected ? "fallback-feature fallback-feature--selected" : "fallback-feature"}
      points={points(positions, project)}
      onClick={(event) => selectFallback(event, feature, onSelectEntity)}
    />
  );
}

function FallbackPoint({
  feature,
  project,
  onSelectEntity
}: {
  feature: MapFeature;
  project: (position: [number, number]) => { x: number; y: number };
  onSelectEntity: (id: string) => void;
}) {
  if (feature.geometry.type !== "Point") return null;
  const { x, y } = project(feature.geometry.coordinates);
  return (
    <g className={`fallback-point fallback-point--${feature.properties.kind}${feature.properties.selected ? " fallback-point--selected" : ""}`} onClick={(event) => selectFallback(event, feature, onSelectEntity)}>
      <circle cx={x} cy={y} r={feature.properties.selected ? 8 : 5.5} />
      <title>{feature.properties.name}</title>
    </g>
  );
}

function points(positions: [number, number][], project: (position: [number, number]) => { x: number; y: number }): string {
  return positions.map((position) => {
    const { x, y } = project(position);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function selectFallback(event: ReactMouseEvent, feature: MapFeature, onSelectEntity: (id: string) => void): void {
  event.stopPropagation();
  onSelectEntity(feature.properties.entityId);
}

function gridValues(min: number, max: number, step: number): number[] {
  const values: number[] = [];
  const start = Math.ceil(min / step) * step;
  for (let value = start; value <= max; value += step) values.push(value);
  return values;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export { buildMapSources };
