import { Callout } from "@blueprintjs/core";
import { type MapMouseEvent, type Map as MlMap, type StyleSpecification } from "maplibre-gl";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MapSourceConfig } from "../../../app/config.js";
import { sanitizeConnectionError } from "../../../atlas/connection-error.js";
import { Button } from "../../primitives/controls.js";
import { getSidcRuntime, loadSidcRuntime } from "../../symbols/sidc-runtime.js";
import { CAMERA_EVENT_TAG, type MapCameraCommand, RETICLE_FLASH_MS } from "../interaction/map-camera.js";
import type { MapReticleTarget } from "../interaction/map-targets.js";
import { useMapCamera } from "../interaction/use-map-camera.js";
import { useMapReticleInteraction } from "../interaction/use-map-reticle-interaction.js";
import { createEditingMarkers, type MapEditing } from "../rendering/map-editing.js";
import { pushEditingOverlay, pushSources, registerSourcesAndLayers } from "../rendering/map-layers.js";
import { type MapSources } from "../rendering/map-sources.js";
import {
  clearMarkers,
  createSymbolMarkerElement,
  type SymbolMarkerFeature,
  symbolMarkerFeatures,
  symbolMarkerPositionsEqual,
  symbolMarkerPresentationsEqual,
  updateSymbolMarkerElement
} from "../rendering/map-symbol-markers.js";
import { getMapLibreRuntime, loadMapLibre, type MapLibreRuntime } from "../runtime/maplibre-runtime.js";
import { MapCursorOverlay } from "./MapCursorOverlay.js";
import { MapRegionComparison } from "./MapRegionComparison.js";
import { MapReticle } from "./MapReticle.js";
import { cloneStyle, fitWorldOnce, webglAvailable } from "./map-view-utils.js";

export type MapContextMenuInfo = { lng: number; lat: number; x: number; y: number };
export type { MapReticleTarget } from "../interaction/map-targets.js";
export type { MapEditing } from "../rendering/map-editing.js";
export { buildMapSources } from "../rendering/map-sources.js";

type MapViewProps = {
  sources: MapSources;
  styleId: string;
  style: StyleSpecification;
  mapSourceOptions: MapSourceConfig[];
  selectedId?: string;
  editing?: MapEditing;
  initialCenter?: [number, number];
  focusTarget?: MapReticleTarget | null;
  cameraCommand?: MapCameraCommand | null;
  onSelectEntity: (id: string) => void;
  onMapContextMenu: (info: MapContextMenuInfo) => void;
  onBackgroundClick?: () => void;
  onStyleSwitchError?: (error: { failedStyleId: string; activeStyleId: string }) => void;
};

type SymbolMarkerEntry = {
  marker: InstanceType<MapLibreRuntime["Marker"]>;
  element: HTMLButtonElement;
  feature: SymbolMarkerFeature;
};

export function MapView({
  sources,
  styleId,
  style,
  mapSourceOptions,
  selectedId,
  editing,
  initialCenter,
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
  const mapLibreRef = useRef<MapLibreRuntime | undefined>(undefined);
  const sourcesRef = useRef(sources);
  const editingRef = useRef(editing);
  const initialMapRef = useRef({ initialCenter, style, styleId });
  const currentStyleIdRef = useRef<string | undefined>(undefined);
  const pendingStyleIdRef = useRef<string | undefined>(undefined);
  const readyRef = useRef(false);
  const eventsRegisteredRef = useRef(false);
  const fitWorldOnceRef = useRef(initialCenter !== undefined);
  const editMarkersRef = useRef<InstanceType<MapLibreRuntime["Marker"]>[]>([]);
  const symbolMarkersRef = useRef<Map<string, SymbolMarkerEntry>>(new Map());
  const handlersRef = useRef({ onSelectEntity, onMapContextMenu });
  const styleSwitchErrorRef = useRef(onStyleSwitchError);
  const [mapError, setMapError] = useState<string>();
  const [mapReady, setMapReady] = useState(false);
  const [appliedCameraCommand, setAppliedCameraCommand] = useState<MapCameraCommand | null | undefined>(() =>
    cameraCommand?.intent === "commit" ? null : cameraCommand
  );
  const [reticleFlashing, setReticleFlashing] = useState(false);
  handlersRef.current = { onSelectEntity, onMapContextMenu };
  styleSwitchErrorRef.current = onStyleSwitchError;
  sourcesRef.current = sources;
  editingRef.current = editing;
  initialMapRef.current = { initialCenter, style, styleId };
  const { notifyUserGesture } = useMapCamera({ mapRef, mapReady, sources, command: appliedCameraCommand });
  const reticleInteraction = useMapReticleInteraction({
    mapCanvasRef,
    mapRef,
    mapReady,
    sources,
    selectedEntityId: selectedId,
    focusTarget,
    notifyUserGesture,
    onSelectEntity,
    onBackgroundClick
  });
  const mapActionsRef = useRef(reticleInteraction.mapActions);
  mapActionsRef.current = reticleInteraction.mapActions;

  useEffect(() => {
    if (cameraCommand?.intent !== "commit") {
      setReticleFlashing(false);
      setAppliedCameraCommand(cameraCommand);
      return;
    }
    // A preview return may still be moving. Freeze it during the flash so the
    // committed zoom starts from the camera position the operator clicked.
    mapRef.current?.stop();
    setReticleFlashing(true);
    const timeout = window.setTimeout(() => {
      setReticleFlashing(false);
      setAppliedCameraCommand(cameraCommand);
    }, RETICLE_FLASH_MS);
    return () => window.clearTimeout(timeout);
  }, [cameraCommand]);

  // Create the map once.
  useEffect(() => {
    if (mapError) return;
    if (!containerRef.current) return;
    if (!webglAvailable()) {
      setMapError("MapLibre WebGL renderer is unavailable");
      return;
    }

    let map: MlMap | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let cancelled = false;
    const initializeMap = (maplibre: MapLibreRuntime) => {
      if (cancelled || !containerRef.current) return;

      const initialMap = initialMapRef.current;
      mapLibreRef.current = maplibre;
      try {
        map = new maplibre.Map({
          container: containerRef.current,
          style: cloneStyle(initialMap.style),
          center: initialMap.initialCenter ?? [0, 0],
          zoom: initialMap.initialCenter ? 11 : 0,
          renderWorldCopies: false,
          keyboard: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          attributionControl: false,
          boxZoom: {
            boxZoomEnd: (zoomMap, start, end) => mapActionsRef.current.completeBoxZoom(zoomMap, start, end)
          }
        });
      } catch (error) {
        setMapError(sanitizeConnectionError(error));
        return;
      }

      const mapInstance = map;
      mapRef.current = mapInstance;
      currentStyleIdRef.current = initialMap.styleId;
      mapInstance.touchZoomRotate.disableRotation();
      mapInstance.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
      mapInstance.addControl(new maplibre.AttributionControl({ compact: true }), "bottom-left");

      resizeObserver = new ResizeObserver(() => mapInstance.resize({ [CAMERA_EVENT_TAG]: true }));
      resizeObserver.observe(containerRef.current);
      requestAnimationFrame(() => mapInstance.resize({ [CAMERA_EVENT_TAG]: true }));

      const initializeLayers = () => {
        registerSourcesAndLayers(mapInstance);
        readyRef.current = true;
        setMapReady(true);
        pushSources(mapInstance, sourcesRef.current);
        pushEditingOverlay(mapInstance, editingRef.current);
        fitWorldOnce(mapInstance, fitWorldOnceRef);

        if (!eventsRegisteredRef.current) {
          eventsRegisteredRef.current = true;
          mapInstance.on("contextmenu", (event: MapMouseEvent) => {
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

      mapInstance.on("style.load", initializeLayers);
      if (mapInstance.isStyleLoaded()) initializeLayers();
      mapInstance.on("boxzoomcancel", () => mapActionsRef.current.cancelBoxZoom());
      mapInstance.on("error", (event) => {
        // Tile/style errors should not blank the operator picture. Keep overlays
        // alive and surface the details in devtools.
        console.warn("Map render warning", sanitizeConnectionError(event.error));
        const failedStyleId = pendingStyleIdRef.current;
        if (failedStyleId) {
          pendingStyleIdRef.current = undefined;
          if (readyRef.current && mapInstance.isStyleLoaded()) {
            registerSourcesAndLayers(mapInstance);
            pushSources(mapInstance, sourcesRef.current);
            pushEditingOverlay(mapInstance, editingRef.current);
          }
          styleSwitchErrorRef.current?.({ failedStyleId, activeStyleId: currentStyleIdRef.current ?? failedStyleId });
        }
      });
    };

    const maplibre = getMapLibreRuntime();
    const sidcRuntime = getSidcRuntime();
    if (maplibre && sidcRuntime) {
      initializeMap(maplibre);
    } else {
      void Promise.all([
        maplibre ? Promise.resolve(maplibre) : loadMapLibre(),
        sidcRuntime ? Promise.resolve(sidcRuntime) : loadSidcRuntime()
      ])
        .then(([loadedMaplibre]) => initializeMap(loadedMaplibre))
        .catch((error: unknown) => {
          if (!cancelled) setMapError(sanitizeConnectionError(error));
        });
    }

    return () => {
      cancelled = true;
      readyRef.current = false;
      eventsRegisteredRef.current = false;
      setMapReady(false);
      resizeObserver?.disconnect();
      clearMarkers(editMarkersRef.current);
      clearSymbolMarkers(symbolMarkersRef.current);
      editMarkersRef.current = [];
      map?.remove();
      mapRef.current = undefined;
      mapLibreRef.current = undefined;
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
      console.warn("Map style switch failed", sanitizeConnectionError(error));
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
    const maplibre = mapLibreRef.current;
    if (!map || !mapReady || !maplibre) return;

    const markers = symbolMarkersRef.current;
    const visibleIds = new Set<string>();

    for (const feature of symbolMarkerFeatures(sources)) {
      const entityId = feature.properties.entityId;
      visibleIds.add(entityId);
      const current = markers.get(entityId);
      if (current) {
        if (!symbolMarkerPositionsEqual(current.feature, feature))
          current.marker.setLngLat(feature.geometry.coordinates);
        if (!symbolMarkerPresentationsEqual(current.feature, feature))
          updateSymbolMarkerElement(current.element, feature);
        current.feature = feature;
        continue;
      }

      const element = createSymbolMarkerElement(feature);
      const marker = new maplibre.Marker({ element, anchor: "center" })
        .setLngLat(feature.geometry.coordinates)
        .addTo(map);
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
    const maplibre = mapLibreRef.current;
    if (!map || !mapReady || !maplibre) return;

    clearMarkers(editMarkersRef.current);
    editMarkersRef.current = createEditingMarkers(map, editing, maplibre.Marker);
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
      <MapRegionComparison
        mapCanvas={mapCanvasRef.current}
        map={mapRef.current}
        maplibre={mapLibreRef.current}
        mapReady={mapReady}
        boxZoomActive={reticleInteraction.zooming}
        baseSourceId={styleId}
        sourceOptions={mapSourceOptions}
        sources={sources}
        editing={editing}
        notifyUserGesture={notifyUserGesture}
        suppressNextClick={reticleInteraction.mapActions.suppressNextClick}
      />
      {reticleInteraction.cursorOverlay ? <MapCursorOverlay {...reticleInteraction.cursorOverlay} /> : null}
      {reticleInteraction.visibleReticle ? (
        <MapReticle
          reticle={reticleInteraction.visibleReticle}
          flashing={reticleFlashing}
          scrolling={reticleInteraction.scrolling}
          zooming={reticleInteraction.zooming}
        />
      ) : null}
      {mapError ? (
        <Callout className="map-unavailable" icon={null} intent="danger" role="status" aria-live="polite">
          <span>Map unavailable</span>
          <code>{mapError}</code>
          <Button variant="primary" onClick={() => setMapError(undefined)}>
            Retry
          </Button>
        </Callout>
      ) : null}
    </div>
  );
}

function clearSymbolMarkers(markers: Map<string, SymbolMarkerEntry>): void {
  for (const entry of markers.values()) entry.marker.remove();
  markers.clear();
}
