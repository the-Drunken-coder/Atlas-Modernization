import maplibregl, { Marker, type Map as MlMap, type MapMouseEvent, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from "react";
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
import { hoverSelectionTarget, reticleForVisibleTarget, targetBoxForEntityId, type MapReticleTarget } from "./map-targets.js";
import { useMapCamera } from "./use-map-camera.js";
import {
  RETICLE_TARGET_SIZE,
  boxFromDrag,
  pointFromClient,
  reticleForTarget,
  reticleFromTargetBox,
  squareAround,
  type ReticleState,
  type ScreenPoint,
  type ZoomOverlayState
} from "./map-reticle.js";
import {
  clientPointInsideRect,
  cloneStyle,
  cursorPointsFromEvent,
  fitWorldOnce,
  reticlesEqual,
  webglAvailable,
  zoomDeltaFromWheel,
  type CursorHandoffState
} from "./map-view-utils.js";

const SCROLL_LOCK_SETTLE_MS = 180;
const SUPPRESSED_CLICK_FALLBACK_MS = 750;

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
  const handlersRef = useRef({ onSelectEntity, onMapContextMenu, onBackgroundClick });
  const styleSwitchErrorRef = useRef(onStyleSwitchError);
  const scrollLockedRef = useRef(false);
  const scrollLockTimeoutRef = useRef<number | undefined>(undefined);
  const reticleRef = useRef<ReticleState | null>(null);
  const activeReticleRef = useRef<ReticleState | null>(null);
  const cursorHandoffRef = useRef<CursorHandoffState | null>(null);
  const scrollLockedExternalReticleRef = useRef(false);
  const zoomOverlayRef = useRef<ZoomOverlayState | null>(null);
  const zoomPointerInsideMapRef = useRef(true);
  const suppressNextClickRef = useRef(false);
  const suppressClickTimeoutRef = useRef<number | undefined>(undefined);
  const [mapError, setMapError] = useState<string>();
  const [mapReady, setMapReady] = useState(false);
  const [reticle, setReticle] = useState<ReticleState | null>(null);
  const [previewReticle, setPreviewReticle] = useState<ReticleState | null>(null);
  const [focusReticle, setFocusReticle] = useState<ReticleState | null>(null);
  const [scrollLocked, setScrollLocked] = useState(false);
  const [zoomOverlay, setZoomOverlay] = useState<ZoomOverlayState | null>(null);
  handlersRef.current = { onSelectEntity, onMapContextMenu, onBackgroundClick };
  styleSwitchErrorRef.current = onStyleSwitchError;
  sourcesRef.current = sources;
  editingRef.current = editing;
  const zoomDragging = zoomOverlay !== null;
  const { notifyUserGesture } = useMapCamera({ mapRef, mapReady, sources, command: cameraCommand });
  const mapActionsRef = useRef({
    notifyUserGesture,
    restoreReticleAtCurrentZoomPoint,
    restoreReticleAtScreenPoint,
    restoreReticleFromClientPoint,
    setReticleState,
    setZoomOverlayState,
    suppressNextClick,
    syncTargetReticle
  });
  mapActionsRef.current = {
    notifyUserGesture,
    restoreReticleAtCurrentZoomPoint,
    restoreReticleAtScreenPoint,
    restoreReticleFromClientPoint,
    setReticleState,
    setZoomOverlayState,
    suppressNextClick,
    syncTargetReticle
  };

  useEffect(() => {
    reticleRef.current = reticle;
  }, [reticle]);

  useEffect(() => {
    const mapCanvas = mapCanvasRef.current;
    if (!mapCanvas) return;
    const preventPageScroll = (event: globalThis.WheelEvent) => event.preventDefault();
    mapCanvas.addEventListener("wheel", preventPageScroll, { capture: true, passive: false });
    return () => {
      mapCanvas.removeEventListener("wheel", preventPageScroll, { capture: true });
    };
  }, []);

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
        dragRotate: false,
        pitchWithRotate: false,
        attributionControl: false,
        boxZoom: {
          boxZoomEnd: (zoomMap, start, end) => {
            mapActionsRef.current.suppressNextClick();
            mapActionsRef.current.restoreReticleAtScreenPoint(end);
            mapActionsRef.current.setZoomOverlayState(null);
            mapActionsRef.current.notifyUserGesture();
            zoomMap.fitScreenCoordinates(start, end, zoomMap.getBearing(), { linear: true });
          }
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
    map.on("boxzoomcancel", () => {
      mapActionsRef.current.restoreReticleAtCurrentZoomPoint();
      mapActionsRef.current.setZoomOverlayState(null);
    });
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
      scrollLockedRef.current = false;
      scrollLockedExternalReticleRef.current = false;
      cursorHandoffRef.current = null;
      if (scrollLockTimeoutRef.current !== undefined) {
        window.clearTimeout(scrollLockTimeoutRef.current);
      }
      if (suppressClickTimeoutRef.current !== undefined) {
        window.clearTimeout(suppressClickTimeoutRef.current);
      }
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
  useEffect(() => {
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

  useEffect(() => {
    if (!zoomDragging) return;

    const updateZoomDrag = (event: globalThis.MouseEvent) => {
      const mapCanvas = mapCanvasRef.current;
      if (!mapCanvas) return;
      const rect = mapCanvas.getBoundingClientRect();
      zoomPointerInsideMapRef.current = clientPointInsideRect(event, rect);
      setZoomOverlay((current) => {
        if (!current) {
          zoomOverlayRef.current = null;
          return null;
        }
        const next = { ...current, current: pointFromClient(event, rect, true) };
        zoomOverlayRef.current = next;
        return next;
      });
    };

    const finishZoomDrag = (event: globalThis.MouseEvent) => {
      mapActionsRef.current.suppressNextClick();
      mapActionsRef.current.restoreReticleFromClientPoint(event);
      mapActionsRef.current.setZoomOverlayState(null);
    };

    const cancelZoomDrag = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        mapActionsRef.current.suppressNextClick();
        mapActionsRef.current.restoreReticleAtCurrentZoomPoint();
        mapActionsRef.current.setZoomOverlayState(null);
      }
    };

    window.addEventListener("mousemove", updateZoomDrag);
    window.addEventListener("mouseup", finishZoomDrag);
    window.addEventListener("keydown", cancelZoomDrag);
    return () => {
      window.removeEventListener("mousemove", updateZoomDrag);
      window.removeEventListener("mouseup", finishZoomDrag);
      window.removeEventListener("keydown", cancelZoomDrag);
    };
  }, [zoomDragging]);

  useEffect(() => {
    const clearWhenOutsideMap = (event: globalThis.PointerEvent) => {
      if (!reticleRef.current) return;
      if (scrollLockedRef.current || zoomOverlayRef.current) return;
      const mapCanvas = mapCanvasRef.current;
      if (!mapCanvas) return;
      const rect = mapCanvas.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
        cursorHandoffRef.current = null;
        mapActionsRef.current.setReticleState(null);
      }
    };

    window.addEventListener("pointermove", clearWhenOutsideMap);
    return () => {
      window.removeEventListener("pointermove", clearWhenOutsideMap);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const entityId = reticle?.targetEntityId;
    if (!map || !mapReady || !entityId) return;

    const syncTargetBox = () => mapActionsRef.current.syncTargetReticle(entityId);

    syncTargetBox();
    map.on("move", syncTargetBox);
    map.on("zoom", syncTargetBox);
    map.on("moveend", syncTargetBox);
    return () => {
      map.off("move", syncTargetBox);
      map.off("zoom", syncTargetBox);
      map.off("moveend", syncTargetBox);
    };
  }, [reticle?.targetEntityId, mapReady, sources]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !previewTarget) {
      setPreviewReticle(null);
      return;
    }

    const syncPreviewReticle = () => {
      if (scrollLockedRef.current || zoomOverlayRef.current) return;
      setPreviewReticle(reticleForVisibleTarget(mapCanvasRef.current, map, sources, previewTarget));
    };

    syncPreviewReticle();
    map.on("move", syncPreviewReticle);
    map.on("zoom", syncPreviewReticle);
    return () => {
      map.off("move", syncPreviewReticle);
      map.off("zoom", syncPreviewReticle);
    };
  }, [mapReady, previewTarget, scrollLocked, sources, zoomDragging]);

  // Focus reticle sync only — camera movement is owned by useMapCamera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !focusTarget) {
      setFocusReticle(null);
      return;
    }

    const syncFocusReticle = () => {
      if (scrollLockedRef.current || zoomOverlayRef.current) return;
      setFocusReticle(reticleForVisibleTarget(mapCanvasRef.current, map, sources, focusTarget));
    };

    syncFocusReticle();
    map.on("move", syncFocusReticle);
    map.on("zoom", syncFocusReticle);
    map.on("moveend", syncFocusReticle);
    return () => {
      map.off("move", syncFocusReticle);
      map.off("zoom", syncFocusReticle);
      map.off("moveend", syncFocusReticle);
    };
  }, [focusTarget, mapReady, scrollLocked, sources, zoomDragging]);

  // Sync the editing overlay (live geometry + draggable handles).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    clearMarkers(editMarkersRef.current);
    editMarkersRef.current = createEditingMarkers(map, editing);
  }, [editing, mapReady]);

  const updateReticle = (event: PointerEvent<HTMLDivElement> & { currentTarget: HTMLDivElement }) => {
    if (scrollLockedRef.current || zoomOverlayRef.current) return;
    if (event.target instanceof HTMLElement && event.target.closest(".maplibregl-control-container")) {
      cursorHandoffRef.current = null;
      setReticleState(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const handoff = cursorHandoffRef.current;
    const { rawPoint, visualPoint } = cursorPointsFromEvent(event, rect, handoff);
    const target = hoverSelectionTarget(event, rect, visualPoint, mapRef.current);
    const next = target ? reticleForTarget(target) : { ...visualPoint, target: squareAround(visualPoint, RETICLE_TARGET_SIZE) };
    if (handoff) cursorHandoffRef.current = { nativePoint: rawPoint, visualPoint: { x: next.x, y: next.y } };
    setReticleState(next);
  };

  const syncCurrentTargetBox = () => {
    const entityId = reticleRef.current?.targetEntityId;
    if (entityId) syncTargetReticle(entityId);
  };

  const onMapWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (zoomOverlayRef.current) return;
    if (event.target instanceof HTMLElement && event.target.closest(".maplibregl-control-container")) return;
    const map = mapRef.current;
    const rect = event.currentTarget.getBoundingClientRect();
    const hoverReticle = reticleRef.current;
    const activeReticle = hoverReticle ?? activeReticleRef.current;
    scrollLockedExternalReticleRef.current = Boolean(activeReticle && !hoverReticle);
    if (map && activeReticle?.targetEntityId) zoomAroundReticleTarget(map, activeReticle, event);
    if (activeReticle) {
      const lockedReticle = hoverReticle ?? { ...activeReticle, targetEntityId: undefined };
      reticleRef.current = lockedReticle;
      setReticle(lockedReticle);
    }
    const visualPoint = activeReticle ? { x: activeReticle.x, y: activeReticle.y } : pointFromClient(event, rect);
    cursorHandoffRef.current = activeReticle?.targetEntityId ? null : { nativePoint: pointFromClient(event, rect), visualPoint };
    event.currentTarget.classList.add("map-canvas--scrolling");
    if (!scrollLockedRef.current) setScrollLocked(true);
    scrollLockedRef.current = true;
    if (scrollLockTimeoutRef.current !== undefined) {
      window.clearTimeout(scrollLockTimeoutRef.current);
    }
    scrollLockTimeoutRef.current = window.setTimeout(() => {
      scrollLockTimeoutRef.current = undefined;
      scrollLockedRef.current = false;
      mapCanvasRef.current?.classList.remove("map-canvas--scrolling");
      setScrollLocked(false);
      if (scrollLockedExternalReticleRef.current) {
        scrollLockedExternalReticleRef.current = false;
        setReticleState(null);
      } else {
        syncCurrentTargetBox();
      }
    }, SCROLL_LOCK_SETTLE_MS);
  };

  const onMapMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!event.shiftKey || event.button !== 0) return;
    if (event.target instanceof HTMLElement && event.target.closest(".maplibregl-control-container")) return;
    const point = pointFromClient(event, event.currentTarget.getBoundingClientRect(), true);
    setZoomOverlayState({ start: point, current: point });
    zoomPointerInsideMapRef.current = true;
    cursorHandoffRef.current = null;
    setReticleState(null);
    notifyUserGesture();
  };

  const onMapClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest(".maplibregl-control-container")) return;
    if (consumeSuppressedClick() || zoomOverlayRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const clickTarget = hoverSelectionTarget(event, rect, cursorPointsFromEvent(event, rect, cursorHandoffRef.current).visualPoint, mapRef.current);
    if (clickTarget) {
      handlersRef.current.onSelectEntity(clickTarget.entityId);
      return;
    }
    if (reticle?.targetEntityId) {
      handlersRef.current.onSelectEntity(reticle.targetEntityId);
      return;
    }
    handlersRef.current.onBackgroundClick?.();
  };

  const visibleReticle = zoomOverlay ? reticleFromTargetBox(boxFromDrag(zoomOverlay)) : scrollLocked ? reticle : (reticle ?? previewReticle ?? focusReticle);

  activeReticleRef.current = visibleReticle;

  function setZoomOverlayState(next: ZoomOverlayState | null): void {
    zoomOverlayRef.current = next;
    setZoomOverlay(next);
  }

  function setReticleState(next: ReticleState | null): void {
    reticleRef.current = next;
    setReticle((current) => (reticlesEqual(current, next) ? current : next));
  }

  function restoreReticleFromClientPoint(event: Pick<globalThis.MouseEvent, "clientX" | "clientY">): void {
    const mapCanvas = mapCanvasRef.current;
    if (!mapCanvas) return;
    const rect = mapCanvas.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      setReticleState(null);
      return;
    }
    restoreReticleAtScreenPoint(pointFromClient(event, rect));
  }

  function restoreReticleAtCurrentZoomPoint(): void {
    const point = zoomOverlayRef.current?.current;
    if (point && zoomPointerInsideMapRef.current) {
      restoreReticleAtScreenPoint(point);
      return;
    }
    setReticleState(null);
  }

  function restoreReticleAtScreenPoint(point: ScreenPoint): void {
    cursorHandoffRef.current = null;
    setReticleState({ x: point.x, y: point.y, target: squareAround(point, RETICLE_TARGET_SIZE) });
  }

  function zoomAroundReticleTarget(map: MlMap, target: ReticleState, event: WheelEvent<HTMLDivElement>): void {
    const delta = zoomDeltaFromWheel(event);
    if (delta === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const scrollZoomWasEnabled = map.scrollZoom.isEnabled();
    if (scrollZoomWasEnabled) {
      map.scrollZoom.disable();
      window.setTimeout(() => map.scrollZoom.enable(), 0);
    }
    map.zoomTo(map.getZoom() + delta, { around: map.unproject([target.x, target.y]), duration: 0 });
  }

  function syncTargetReticle(entityId: string): void {
    const mapCanvas = mapCanvasRef.current;
    const map = mapRef.current;
    if (!mapCanvas || !map) return;
    const box = targetBoxForEntityId(mapCanvas, map, sources, entityId);
    if (!box) return;
    const next = reticleForTarget({ entityId, box });
    setReticle((current) => {
      if (!current || current.targetEntityId !== entityId) return current;
      const value = reticlesEqual(current, next) ? current : next;
      reticleRef.current = value;
      if (cursorHandoffRef.current) cursorHandoffRef.current.visualPoint = { x: value.x, y: value.y };
      return value;
    });
  }

  function suppressNextClick(): void {
    suppressNextClickRef.current = true;
    if (suppressClickTimeoutRef.current !== undefined) {
      window.clearTimeout(suppressClickTimeoutRef.current);
    }
    suppressClickTimeoutRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = false;
      suppressClickTimeoutRef.current = undefined;
    }, SUPPRESSED_CLICK_FALLBACK_MS);
  }

  function consumeSuppressedClick(): boolean {
    if (!suppressNextClickRef.current) return false;
    suppressNextClickRef.current = false;
    if (suppressClickTimeoutRef.current !== undefined) {
      window.clearTimeout(suppressClickTimeoutRef.current);
      suppressClickTimeoutRef.current = undefined;
    }
    return true;
  }

  return (
    <div
      className={`map-canvas${scrollLocked ? " map-canvas--scrolling" : ""}`}
      ref={mapCanvasRef}
      style={{ position: "absolute", inset: 0 }}
      data-testid="map-canvas"
      onMouseDown={onMapMouseDown}
      onPointerMove={updateReticle}
      onPointerLeave={() => {
        if (!scrollLockedRef.current && !zoomOverlayRef.current) {
          cursorHandoffRef.current = null;
          setReticleState(null);
        }
      }}
      onWheelCapture={onMapWheel}
      onClick={onMapClick}
    >
      <div className="maplibre-host" ref={containerRef} />
      {visibleReticle ? <MapReticle reticle={visibleReticle} scrolling={scrollLocked} zooming={zoomOverlay !== null} /> : null}
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
