import maplibregl, { type Map as MlMap, type MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { UiGeometry } from "../../atlas/geometry.js";
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

type MapViewProps = {
  sources: MapSources;
  styleUrl?: string;
  selectedId?: string;
  initialCenter?: [number, number];
  onSelectEntity: (id: string) => void;
  onBackgroundClick?: () => void;
};

export function MapView({ sources, styleUrl, initialCenter, onSelectEntity, onBackgroundClick }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | undefined>(undefined);
  const readyRef = useRef(false);
  const fitOnceRef = useRef(false);
  const shouldAutoFitRef = useRef(initialCenter === undefined);
  const handlersRef = useRef({ onSelectEntity, onBackgroundClick });
  const [mapError, setMapError] = useState<string>();
  handlersRef.current = { onSelectEntity, onBackgroundClick };

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
        style: styleUrl ?? defaultDarkStyle(),
        center: initialCenter ?? [0, 20],
        zoom: initialCenter ? 11 : 1.6,
        attributionControl: { compact: true }
      });
    } catch (error) {
      setMapError(error instanceof Error ? error.message : "MapLibre failed to initialize");
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
    };

    map.on("style.load", initializeLayers);
    if (map.isStyleLoaded()) initializeLayers();
    map.on("error", (event) => {
      console.warn("Map render warning", event.error);
    });

    return () => {
      readyRef.current = false;
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = undefined;
    };
    // The map is created once; props are synced by effects and refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapError]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) {
      pushSources(map, sources);
      if (shouldAutoFitRef.current) fitToSourcesOnce(map, sources, fitOnceRef);
    }
  }, [sources]);

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

function pushSources(map: MlMap, sources: MapSources): void {
  (map.getSource("assets") as maplibregl.GeoJSONSource | undefined)?.setData(sources.assets as never);
  (map.getSource("tracks") as maplibregl.GeoJSONSource | undefined)?.setData(sources.tracks as never);
  (map.getSource("geofeatures") as maplibregl.GeoJSONSource | undefined)?.setData(sources.geofeatures as never);
}

function registerSourcesAndLayers(map: MlMap): void {
  for (const id of ["assets", "tracks", "geofeatures"]) {
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
}

function circlePaint(color: string): maplibregl.CircleLayerSpecification["paint"] {
  return {
    "circle-radius": ["case", ["boolean", ["get", "selected"], false], 7, 5],
    "circle-color": color,
    "circle-stroke-width": ["case", ["boolean", ["get", "selected"], false], 3, 1.5],
    "circle-stroke-color": ["case", ["boolean", ["get", "selected"], false], COLORS.selected, "rgba(0,0,0,0.65)"]
  };
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

export { buildMapSources };
