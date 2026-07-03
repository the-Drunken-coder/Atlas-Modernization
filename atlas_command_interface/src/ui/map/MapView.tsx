import maplibregl, { Marker, type Map as MlMap, type MapGeoJSONFeature, type MapMouseEvent, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from "react";
import {
  addVertexAfter,
  displayGeometry,
  geometryVertices,
  moveVertex,
  removeVertex,
  type Position,
  type UiRawGeometry,
  type UiGeometry,
  type VertexRef
} from "../../atlas/geometry.js";
import { defaultSidcIconService } from "../symbols/sidc-symbol-service.js";
import { MapReticle } from "./MapReticle.js";
import { buildMapSources, emptyFeatureCollection, type MapFeature, type MapSources } from "./map-sources.js";
import {
  RETICLE_TARGET_SIZE,
  boxFromDrag,
  boxFromProjectedPositions,
  boxIntersectsViewport,
  pointFromClient,
  reticleForTarget,
  reticleFromTargetBox,
  squareAround,
  type ReticleState,
  type ReticleTarget,
  type ScreenPoint,
  type TargetBox,
  type ZoomOverlayState
} from "./map-reticle.js";

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
const SCROLL_LOCK_SETTLE_MS = 180;
const SUPPRESSED_CLICK_FALLBACK_MS = 750;
const FOCUS_DURATION_MS = 450;
const FOCUS_BOUNDS_PADDING = 48;
const FOCUS_MAX_ZOOM = 10;
const FOCUS_MIN_POINT_ZOOM = 6;
const WHEEL_ZOOM_RATE = 1 / 450;
const DOM_DELTA_LINE = 1;

export type MapContextMenuInfo = { lng: number; lat: number; x: number; y: number };
export type MapReticleTarget =
  | { type: "entity"; id: string }
  | { type: "point"; id: string; coordinates: [number, number]; label?: string }
  | { type: "geometry"; id: string; geometry: UiRawGeometry; label?: string };

export type MapEditing = {
  geometry: UiGeometry;
  onChange: (geometry: UiGeometry) => void;
};

type MapViewProps = {
  sources: MapSources;
  styleId: string;
  style: StyleSpecification;
  selectedId?: string;
  editing?: MapEditing;
  initialCenter?: [number, number];
  previewTarget?: MapReticleTarget | null;
  focusTarget?: MapReticleTarget | null;
  onSelectEntity: (id: string) => void;
  onMapContextMenu: (info: MapContextMenuInfo) => void;
  onBackgroundClick?: () => void;
  onStyleSwitchError?: (error: { failedStyleId: string; activeStyleId: string }) => void;
};

type HoverTarget = ReticleTarget & { entityId: string };
type CursorHandoffState = { nativePoint: ScreenPoint; visualPoint: ScreenPoint };

export function MapView({
  sources,
  styleId,
  style,
  editing,
  initialCenter,
  previewTarget,
  focusTarget,
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
  const currentStyleIdRef = useRef<string | undefined>(undefined);
  const pendingStyleIdRef = useRef<string | undefined>(undefined);
  const readyRef = useRef(false);
  const eventsRegisteredRef = useRef(false);
  const fitWorldOnceRef = useRef(initialCenter !== undefined);
  const editMarkersRef = useRef<Marker[]>([]);
  const symbolMarkersRef = useRef<Marker[]>([]);
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
  const focusedTargetKeyRef = useRef<string | null>(null);
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

  useEffect(() => {
    reticleRef.current = reticle;
  }, [reticle]);

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
        style: cloneStyle(style),
        center: initialCenter ?? [0, 0],
        zoom: initialCenter ? 11 : 0,
        renderWorldCopies: false,
        dragRotate: false,
        pitchWithRotate: false,
        attributionControl: false,
        boxZoom: {
          boxZoomEnd: (zoomMap, start, end) => {
            suppressNextClick();
            restoreReticleAtScreenPoint(end);
            setZoomOverlayState(null);
            zoomMap.fitScreenCoordinates(start, end, zoomMap.getBearing(), { linear: true });
          }
        }
      });
    } catch (error) {
      setMapError(error instanceof Error ? error.message : "MapLibre failed to initialize");
      return;
    }

    mapRef.current = map;
    currentStyleIdRef.current = styleId;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    requestAnimationFrame(() => map.resize());

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
      restoreReticleAtCurrentZoomPoint();
      setZoomOverlayState(null);
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
      clearMarkers(symbolMarkersRef.current);
      editMarkersRef.current = [];
      symbolMarkersRef.current = [];
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
    // The map is created once; props are synced via the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      suppressNextClick();
      restoreReticleFromClientPoint(event);
      setZoomOverlayState(null);
    };

    const cancelZoomDrag = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        suppressNextClick();
        restoreReticleAtCurrentZoomPoint();
        setZoomOverlayState(null);
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
        setReticleState(null);
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

    const syncTargetBox = () => syncTargetReticle(entityId);

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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !focusTarget) {
      focusedTargetKeyRef.current = null;
      setFocusReticle(null);
      return;
    }

    const key = mapReticleTargetKey(focusTarget);
    if (focusedTargetKeyRef.current !== key) {
      if (focusMapTarget(map, sources, focusTarget)) focusedTargetKeyRef.current = key;
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

  const visibleReticle = zoomOverlay
    ? reticleFromTargetBox(boxFromDrag(zoomOverlay))
    : scrollLocked
      ? reticle
      : (reticle ?? previewReticle ?? focusReticle);

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

function cursorPointsFromEvent(
  event: { clientX: number; clientY: number },
  rect: DOMRect,
  handoff: CursorHandoffState | null
): { rawPoint: ScreenPoint; visualPoint: ScreenPoint } {
  const rawPoint = pointFromClient(event, rect);
  if (!handoff) return { rawPoint, visualPoint: rawPoint };
  return {
    rawPoint,
    visualPoint: {
      x: handoff.visualPoint.x + rawPoint.x - handoff.nativePoint.x,
      y: handoff.visualPoint.y + rawPoint.y - handoff.nativePoint.y
    }
  };
}

function clientPointInsideRect(event: { clientX: number; clientY: number }, rect: DOMRect): boolean {
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
}

function zoomDeltaFromWheel(event: Pick<WheelEvent<HTMLDivElement>, "deltaMode" | "deltaY" | "shiftKey">): number {
  let value = event.deltaMode === DOM_DELTA_LINE ? event.deltaY * 40 : event.deltaY;
  if (event.shiftKey && value) value /= 4;
  return -value * WHEEL_ZOOM_RATE;
}

function reticlesEqual(a: ReticleState | null, b: ReticleState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.targetEntityId === b.targetEntityId &&
    a.targeted === b.targeted &&
    boxesEqual(a.target, b.target)
  );
}

function boxesEqual(a: TargetBox, b: TargetBox): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
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

  const markerAtPoint = markerTargetAtPoint(event.currentTarget, mapRect, point);
  if (markerAtPoint) return markerAtPoint;

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

function markerTargetAtPoint(mapCanvas: HTMLElement, mapRect: DOMRect, point: ScreenPoint): HoverTarget | null {
  for (const element of mapCanvas.querySelectorAll<HTMLElement>(".map-symbol-marker")) {
    const entityId = element.dataset.entityId;
    if (!entityId) continue;
    const box = boxFromElement(element, mapRect);
    if (point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height) {
      return { entityId, box };
    }
  }
  return null;
}

function reticleForVisibleTarget(mapCanvas: HTMLElement | null, map: MlMap, sources: MapSources, target: MapReticleTarget): ReticleState | null {
  if (!mapCanvas) return null;
  const box = boxForMapReticleTarget(mapCanvas, map, sources, target);
  if (!box) return null;
  const viewport = mapCanvas.getBoundingClientRect();
  if (!boxIntersectsViewport(box, { width: viewport.width, height: viewport.height })) return null;
  return reticleForTarget({ id: target.id, entityId: target.type === "entity" ? target.id : undefined, box });
}

function boxForMapReticleTarget(mapCanvas: HTMLElement, map: MlMap, sources: MapSources, target: MapReticleTarget): TargetBox | null {
  if (target.type === "entity") return targetBoxForEntityId(mapCanvas, map, sources, target.id);
  if (target.type === "point") {
    const point = map.project(target.coordinates);
    return squareAround({ x: point.x, y: point.y }, 1);
  }
  return boxFromGeometry(map, target.geometry);
}

function targetBoxForEntityId(mapCanvas: HTMLElement, map: MlMap, sources: MapSources, entityId: string): TargetBox | null {
  return boxForEntityMarker(mapCanvas, entityId) ?? boxForFeature(map, featureForEntityId(sources, entityId));
}

function boxForEntityMarker(mapCanvas: HTMLElement, entityId: string): TargetBox | null {
  const mapRect = mapCanvas.getBoundingClientRect();
  for (const element of mapCanvas.querySelectorAll<HTMLElement>(".map-symbol-marker")) {
    if (element.dataset.entityId === entityId) return boxFromElement(element, mapRect);
  }
  return null;
}

function featureForEntityId(sources: MapSources, entityId: string): MapFeature | undefined {
  return [...sources.assets.features, ...sources.tracks.features, ...sources.geofeatures.features].find((feature) => feature.properties.entityId === entityId);
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
  return boxFromProjectedPositions(collectLngLatPositions(feature.geometry.coordinates), (position) => {
    const projected = map.project([position[0], position[1]]);
    return { x: projected.x, y: projected.y };
  });
}

function boxForFeature(map: MlMap, feature: MapFeature | undefined): TargetBox | null {
  return feature ? boxFromGeometry(map, feature.geometry) : null;
}

function boxFromGeometry(map: MlMap, geometry: UiRawGeometry): TargetBox | null {
  return boxFromProjectedPositions(collectLngLatPositions(geometry.coordinates), (position) => {
    const projected = map.project([position[0], position[1]]);
    return { x: projected.x, y: projected.y };
  });
}

function focusMapTarget(map: MlMap, sources: MapSources, target: MapReticleTarget): boolean {
  const geometry = geometryForFocusTarget(sources, target);
  if (!geometry) return false;
  if (geometry.type === "Point") {
    map.easeTo({
      center: [geometry.coordinates[0], geometry.coordinates[1]],
      duration: FOCUS_DURATION_MS,
      zoom: Math.max(map.getZoom(), FOCUS_MIN_POINT_ZOOM)
    });
    return true;
  }
  const bounds = boundsForGeometry(geometry);
  if (!bounds) return false;
  map.fitBounds(bounds, { duration: FOCUS_DURATION_MS, maxZoom: FOCUS_MAX_ZOOM, padding: FOCUS_BOUNDS_PADDING });
  return true;
}

function geometryForFocusTarget(sources: MapSources, target: MapReticleTarget): UiRawGeometry | undefined {
  if (target.type === "point") return { type: "Point", coordinates: target.coordinates };
  if (target.type === "geometry") return target.geometry;
  return featureForEntityId(sources, target.id)?.geometry;
}

function boundsForGeometry(geometry: UiRawGeometry): [[number, number], [number, number]] | null {
  const positions = collectLngLatPositions(geometry.coordinates);
  if (positions.length === 0) return null;
  const lngValues = positions.map((position) => position[0]);
  const latValues = positions.map((position) => position[1]);
  return [
    [Math.min(...lngValues), Math.min(...latValues)],
    [Math.max(...lngValues), Math.max(...latValues)]
  ];
}

function mapReticleTargetKey(target: MapReticleTarget): string {
  if (target.type === "point") return `point:${target.id}:${target.coordinates[0]},${target.coordinates[1]}`;
  if (target.type === "geometry") return `geometry:${target.id}:${JSON.stringify(target.geometry)}`;
  return `entity:${target.id}`;
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

function pushEditingOverlay(map: MlMap, editing: MapEditing | undefined): void {
  const overlay = map.getSource("editing") as maplibregl.GeoJSONSource | undefined;
  overlay?.setData(
    editing
      ? ({ type: "FeatureCollection", features: [{ type: "Feature", geometry: displayGeometry(editing.geometry), properties: {} }] } as never)
      : (emptyFeatureCollection() as never)
  );
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

function cloneStyle(style: StyleSpecification): StyleSpecification {
  return JSON.parse(JSON.stringify(style)) as StyleSpecification;
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
