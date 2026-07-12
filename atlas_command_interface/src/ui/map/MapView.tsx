import maplibregl, { Marker, type Map as MlMap, type MapMouseEvent, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MapReticle } from "./MapReticle.js";
import { CAMERA_EVENT_TAG, type MapCameraCommand } from "./map-camera.js";
import { createEditingMarkers, type MapEditing } from "./map-editing.js";
import { pushEditingOverlay, pushSources, registerSourcesAndLayers } from "./map-layers.js";
import { type MapSources } from "./map-sources.js";
import {
  clearMarkers,
  createSymbolMarkerElement,
  symbolMarkerFeatures,
  symbolMarkerPositionsEqual,
  symbolMarkerPresentationsEqual,
  updateSymbolMarkerElement,
  type SymbolMarkerFeature
} from "./map-symbol-markers.js";
import type { MapReticleTarget } from "./map-targets.js";
import { useMapCamera } from "./use-map-camera.js";
import { useMapReticleInteraction } from "./use-map-reticle-interaction.js";
import { cloneStyle, fitWorldOnce, webglAvailable } from "./map-view-utils.js";

export type MapContextMenuInfo = { lng: number; lat: number; x: number; y: number };
export type { MapEditing } from "./map-editing.js";
export type { MapReticleTarget } from "./map-targets.js";
export { buildMapSources } from "./map-sources.js";

type MapViewProps = {
  sources: MapSources;
  styleId: string;
  style: StyleSpecification;
  selectedId?: string;
  editing?: MapEditing;
  initialCenter?: [number, number];
  previewTarget?: MapReticleTarget | null;
  focusTarget?: MapReticleTarget | null;
  cameraCommand?: MapCameraCommand | null;
  onSelectEntity: (id: string) => void;
  onMapContextMenu: (info: MapContextMenuInfo) => void;
  onBackgroundClick?: () => void;
  onStyleSwitchError?: (error: { failedStyleId: string; activeStyleId: string }) => void;
};

type SymbolMarkerEntry = {
  marker: Marker;
  element: HTMLButtonElement;
  feature: SymbolMarkerFeature;
};

export function MapView({
  sources,
  styleId,
  style,
  selectedId,
  editing,
  initialCenter,
  previewTarget,
  focusTarget,
  cameraCommand,
  onSelectEntity,
  onMapContextMenu,
  onBackgroundClick,
  onStyleSwitchError
}: MapViewProps) {
  const mapCanvasRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | undefined>(undefined);
  const sourcesRef = useRef(sources);
  const editingRef = useRef(editing);
  const initialMapRef = useRef({ initialCenter, style, styleId });
  const currentStyleIdRef = useRef<string | undefined>(undefined);
  const pendingStyleIdRef = useRef<string | undefined>(undefined);
  const readyRef = useRef(false);
  const eventsRegisteredRef = useRef(false);
  const fitWorldOnceRef = useRef(initialCenter !== undefined);
  const editMarkersRef = useRef<Marker[]>([]);
  const symbolMarkersRef = useRef<Map<string, SymbolMarkerEntry>>(new Map());
  const handlersRef = useRef({ onSelectEntity, onMapContextMenu });
  const styleSwitchErrorRef = useRef(onStyleSwitchError);
  const [mapError, setMapError] = useState<string>();
  const [mapReady, setMapReady] = useState(false);
  handlersRef.current = { onSelectEntity, onMapContextMenu };
  styleSwitchErrorRef.current = onStyleSwitchError;
  sourcesRef.current = sources;
  editingRef.current = editing;
  const { notifyUserGesture } = useMapCamera({ mapRef, mapReady, sources, command: cameraCommand });
  const reticleInteraction = useMapReticleInteraction({
    mapCanvasRef,
    mapRef,
    mapReady,
    sources,
    selectedEntityId: selectedId,
    previewTarget,
    focusTarget,
    notifyUserGesture,
    onSelectEntity,
    onBackgroundClick
  });
  const mapActionsRef = useRef(reticleInteraction.mapActions);
  mapActionsRef.current = reticleInteraction.mapActions;

  // Create the map once.
  useEffect(() => {
    if (mapError) return;
    if (!containerRef.current) return;
    if (!webglAvailable()) {
      setMapError("MapLibre WebGL renderer is unavailable");
      return;
    }

    let map: MlMap;
    const initialMap = initialMapRef.current;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: cloneStyle(initialMap.style),
        center: initialMap.initialCenter ?? [0, 0],
        zoom: initialMap.initialCenter ? 11 : 0,
        renderWorldCopies: false,
        keyboard: false,
        dragRotate: false,
        pitchWithRotate: false,
        attributionControl: false,
        boxZoom: {
          boxZoomEnd: (zoomMap, start, end) => mapActionsRef.current.completeBoxZoom(zoomMap, start, end)
        }
      });
    } catch (error) {
      setMapError(error instanceof Error ? error.message : "MapLibre failed to initialize");
      return;
    }

    mapRef.current = map;
    currentStyleIdRef.current = initialMap.styleId;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

    const resizeObserver = new ResizeObserver(() => map.resize({ [CAMERA_EVENT_TAG]: true }));
    resizeObserver.observe(containerRef.current);
    requestAnimationFrame(() => map.resize({ [CAMERA_EVENT_TAG]: true }));

    const initializeLayers = () => {
      registerSourcesAndLayers(map);
      readyRef.current = true;
      setMapReady(true);
      pushSources(map, sourcesRef.current);
      pushEditingOverlay(map, editingRef.current);
      fitWorldOnce(map, fitWorldOnceRef);

      if (!eventsRegisteredRef.current) {
        eventsRegisteredRef.current = true;
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
    map.on("boxzoomcancel", () => mapActionsRef.current.cancelBoxZoom());
    map.on("error", (event) => {
      // Tile/style errors should not blank the operator picture. Keep overlays
      // alive and surface the details in devtools.
      console.warn("Map render warning", event.error);
      const failedStyleId = pendingStyleIdRef.current;
      if (failedStyleId) {
        pendingStyleIdRef.current = undefined;
        if (readyRef.current && map.isStyleLoaded()) {
          registerSourcesAndLayers(map);
          pushSources(map, sourcesRef.current);
          pushEditingOverlay(map, editingRef.current);
        }
        styleSwitchErrorRef.current?.({ failedStyleId, activeStyleId: currentStyleIdRef.current ?? failedStyleId });
      }
    });

    return () => {
      readyRef.current = false;
      eventsRegisteredRef.current = false;
      setMapReady(false);
      resizeObserver.disconnect();
      clearMarkers(editMarkersRef.current);
      clearSymbolMarkers(symbolMarkersRef.current);
      editMarkersRef.current = [];
      map.remove();
      mapRef.current = undefined;
    };
    // Changing props are synchronized through refs and the effects below.
  }, [mapError]);

  // Sync basemap style while keeping the map camera and re-adding Atlas overlays.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || currentStyleIdRef.current === styleId) return;

    let cancelled = false;
    pendingStyleIdRef.current = styleId;

    const handleFailure = (error: unknown) => {
      if (cancelled || pendingStyleIdRef.current !== styleId) return;
      pendingStyleIdRef.current = undefined;
      console.warn("Map style switch failed", error);
      if (readyRef.current && map.isStyleLoaded()) {
        registerSourcesAndLayers(map);
        pushSources(map, sourcesRef.current);
        pushEditingOverlay(map, editingRef.current);
      }
      styleSwitchErrorRef.current?.({ failedStyleId: styleId, activeStyleId: currentStyleIdRef.current ?? styleId });
    };

    try {
      map.once("style.load", () => {
        if (pendingStyleIdRef.current !== styleId) return;
        currentStyleIdRef.current = styleId;
        pendingStyleIdRef.current = undefined;
      });
      map.setStyle(cloneStyle(style));
    } catch (error) {
      handleFailure(error);
    }

    return () => {
      cancelled = true;
    };
  }, [styleId, style]);

  // Sync entity sources.
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) {
      pushSources(map, sources);
    }
  }, [sources]);

  // Reconcile asset/track DOM markers before reticles read their boxes for this snapshot.
  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const markers = symbolMarkersRef.current;
    const visibleIds = new Set<string>();

    for (const feature of symbolMarkerFeatures(sources)) {
      const entityId = feature.properties.entityId;
      visibleIds.add(entityId);
      const current = markers.get(entityId);
      if (current) {
        if (!symbolMarkerPositionsEqual(current.feature, feature)) current.marker.setLngLat(feature.geometry.coordinates);
        if (!symbolMarkerPresentationsEqual(current.feature, feature)) updateSymbolMarkerElement(current.element, feature);
        current.feature = feature;
        continue;
      }

      const element = createSymbolMarkerElement(feature);
      const marker = new Marker({ element, anchor: "center" }).setLngLat(feature.geometry.coordinates).addTo(map);
      const entry: SymbolMarkerEntry = { marker, element, feature };
      element.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const current = entry.feature;
        handlersRef.current.onSelectEntity(current.properties.entityId);
        handlersRef.current.onMapContextMenu({
          lng: current.geometry.coordinates[0],
          lat: current.geometry.coordinates[1],
          x: event.clientX,
          y: event.clientY
        });
      });
      markers.set(entityId, entry);
    }

    for (const [entityId, entry] of markers) {
      if (visibleIds.has(entityId)) continue;
      entry.marker.remove();
      markers.delete(entityId);
    }
  }, [sources, mapReady]);

  // Sync the editing overlay (live geometry + draggable handles).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    clearMarkers(editMarkersRef.current);
    editMarkersRef.current = createEditingMarkers(map, editing);
  }, [editing, mapReady]);

  return (
    <div
      className={`map-canvas${reticleInteraction.customCursorVisible ? " map-canvas--custom-cursor" : ""}${reticleInteraction.scrolling ? " map-canvas--scrolling" : ""}`}
      ref={mapCanvasRef}
      style={{ position: "absolute", inset: 0 }}
      data-testid="map-canvas"
      {...reticleInteraction.canvasHandlers}
    >
      <div className="maplibre-host" ref={containerRef} />
      {reticleInteraction.visibleReticle ? (
        <MapReticle reticle={reticleInteraction.visibleReticle} scrolling={reticleInteraction.scrolling} zooming={reticleInteraction.zooming} />
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

function clearSymbolMarkers(markers: Map<string, SymbolMarkerEntry>): void {
  for (const entry of markers.values()) entry.marker.remove();
  markers.clear();
}
