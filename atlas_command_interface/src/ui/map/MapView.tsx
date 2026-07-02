import maplibregl, { Marker, type Map as MlMap, type MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import {
  addVertexAfter,
  displayGeometry,
  geometryVertices,
  moveVertex,
  removeVertex,
  type Position,
  type UiGeometry,
  type UiRawGeometry,
  type VertexRef
} from "../../atlas/geometry.js";
import { defaultSidcIconService } from "../symbols/sidc-symbol-service.js";
import { buildMapSources, emptyFeatureCollection, type MapFeature, type MapSources } from "./map-sources.js";

const COLORS = {
  geofeature: "#3fd27a",
  geofeatureFill: "rgba(63,210,122,0.16)",
  selected: "#ffffff"
};

const INTERACTIVE_LAYERS = ["geofeatures-point", "geofeatures-line", "geofeatures-fill"];

export type MapContextMenuInfo = { lng: number; lat: number; x: number; y: number };

export type MapEditing = {
  geometry: UiGeometry;
  onChange: (geometry: UiGeometry) => void;
};

type MapViewProps = {
  sources: MapSources;
  styleUrl: string;
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
  const sourcesRef = useRef(sources);
  const currentStyleUrlRef = useRef<string | undefined>(undefined);
  const readyRef = useRef(false);
  const eventsRegisteredRef = useRef(false);
  const fitOnceRef = useRef(false);
  const shouldAutoFitRef = useRef(initialCenter === undefined);
  const editMarkersRef = useRef<Marker[]>([]);
  const symbolMarkersRef = useRef<Marker[]>([]);
  const handlersRef = useRef({ onSelectEntity, onMapContextMenu, onBackgroundClick });
  const [mapError, setMapError] = useState<string>();
  const [mapReady, setMapReady] = useState(false);
  handlersRef.current = { onSelectEntity, onMapContextMenu, onBackgroundClick };
  sourcesRef.current = sources;

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
        style: styleUrl,
        center: initialCenter ?? [0, 20],
        zoom: initialCenter ? 11 : 1.6,
        attributionControl: { compact: true }
      });
    } catch (error) {
      setMapError(error instanceof Error ? error.message : "MapLibre failed to initialize");
      return;
    }

    mapRef.current = map;
    currentStyleUrlRef.current = styleUrl;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    requestAnimationFrame(() => map.resize());

    const initializeLayers = () => {
      registerSourcesAndLayers(map);
      readyRef.current = true;
      setMapReady(true);
      pushSources(map, sourcesRef.current);
      if (shouldAutoFitRef.current) fitToSourcesOnce(map, sourcesRef.current, fitOnceRef);

      if (!eventsRegisteredRef.current) {
        eventsRegisteredRef.current = true;
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
      }
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
      eventsRegisteredRef.current = false;
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

  // Sync basemap style while keeping the map camera and re-adding Atlas overlays.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || currentStyleUrlRef.current === styleUrl) return;
    currentStyleUrlRef.current = styleUrl;
    readyRef.current = false;
    setMapReady(false);
    map.setStyle(styleUrl);
  }, [styleUrl]);

  // Sync entity sources.
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) {
      pushSources(map, sources);
      if (shouldAutoFitRef.current) fitToSourcesOnce(map, sources, fitOnceRef);
    }
  }, [sources]);

  // Sync NATO-style asset/track DOM markers generated from the Atlas symbol catalog.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    clearMarkers(symbolMarkersRef.current);
    symbolMarkersRef.current = [];

    for (const feature of symbolMarkerFeatures(sources)) {
      const element = createSymbolMarkerElement(feature);
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        handlersRef.current.onSelectEntity(feature.properties.entityId);
      });
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

  return (
    <div className="map-canvas" ref={containerRef} style={{ position: "absolute", inset: 0 }} data-testid="map-canvas">
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

function pushSources(map: MlMap, sources: MapSources): void {
  (map.getSource("geofeatures") as maplibregl.GeoJSONSource | undefined)?.setData(sources.geofeatures as never);
}

function registerSourcesAndLayers(map: MlMap): void {
  for (const id of ["geofeatures", "editing"]) {
    if (!map.getSource(id)) {
      map.addSource(id, { type: "geojson", data: emptyFeatureCollection() as never });
    }
  }

  if (!map.getLayer("geofeatures-fill")) {
    map.addLayer({
      id: "geofeatures-fill",
      type: "fill",
      source: "geofeatures",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": COLORS.geofeatureFill, "fill-outline-color": COLORS.geofeature }
    });
  }
  if (!map.getLayer("geofeatures-line")) {
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
  }
  if (!map.getLayer("geofeatures-point")) {
    map.addLayer({
      id: "geofeatures-point",
      type: "circle",
      source: "geofeatures",
      filter: ["==", ["geometry-type"], "Point"],
      paint: circlePaint(COLORS.geofeature)
    });
  }

  // Editing overlay drawn above everything.
  if (!map.getLayer("editing-fill")) {
    map.addLayer({
      id: "editing-fill",
      type: "fill",
      source: "editing",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": "rgba(63,182,255,0.18)" }
    });
  }
  if (!map.getLayer("editing-line")) {
    map.addLayer({
      id: "editing-line",
      type: "line",
      source: "editing",
      filter: ["match", ["geometry-type"], ["LineString", "Polygon"], true, false],
      paint: { "line-color": COLORS.selected, "line-width": 2, "line-dasharray": [2, 1.5] }
    });
  }
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
      const lngLat = toLngLat(position);
      bounds = bounds ? bounds.extend(lngLat) : new maplibregl.LngLatBounds(lngLat, lngLat);
    });
  }
  return bounds;
}

function allFeatures(sources: MapSources): MapFeature[] {
  return [...sources.assets.features, ...sources.tracks.features, ...sources.geofeatures.features];
}

function forEachPosition(geometry: UiRawGeometry, visitor: (position: Position) => void): void {
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

function toLngLat(position: Position): [number, number] {
  return [position[0], position[1]];
}

export { buildMapSources };
