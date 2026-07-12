import type { Map as MlMap, PointLike } from "maplibre-gl";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject, type WheelEvent } from "react";
import { flushSync } from "react-dom";
import type { MapSources } from "./map-sources.js";
import {
  createMarkerBoxCache,
  hoverSelectionTarget,
  hoverSelectionTargets,
  invalidateMarkerBoxCache,
  nextVisibleEntityInDirection,
  reticleForVisibleTarget,
  targetBoxForEntityId,
  type MapNavigationDirection,
  type MapReticleTarget
} from "./map-targets.js";
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
import { geographicBearingDegrees, geographicDistanceMeters, type CursorOverlayState } from "./map-cursor-overlay.js";
import { clientPointInsideRect, cursorPointsFromEvent, reticlesEqual, zoomDeltaFromWheel, type CursorHandoffState } from "./map-view-utils.js";

const SCROLL_LOCK_SETTLE_MS = 180;
const SUPPRESSED_CLICK_FALLBACK_MS = 750;

type InteractionState = {
  reticle: ReticleState | null;
  focusReticle: ReticleState | null;
  pointerPoint: ScreenPoint | null;
  cameraMoving: boolean;
  scrollLocked: boolean;
  zoomOverlay: ZoomOverlayState | null;
};

type PendingPointer = {
  clientX: number;
  clientY: number;
  currentTarget: HTMLDivElement;
  target: EventTarget | null;
};

type ScrollZoomRestore = { map: MlMap; timeout: number };

type UseMapReticleInteractionOptions = {
  mapCanvasRef: RefObject<HTMLDivElement | null>;
  mapRef: RefObject<MlMap | undefined>;
  mapReady: boolean;
  sources: MapSources;
  selectedEntityId?: string;
  focusTarget?: MapReticleTarget | null;
  notifyUserGesture: () => void;
  onSelectEntity: (id: string) => void;
  onBackgroundClick?: () => void;
};

const initialState: InteractionState = {
  reticle: null,
  focusReticle: null,
  pointerPoint: null,
  cameraMoving: false,
  scrollLocked: false,
  zoomOverlay: null
};

export function useMapReticleInteraction(options: UseMapReticleInteractionOptions) {
  const { mapCanvasRef, mapRef, mapReady, sources, focusTarget, selectedEntityId } = options;
  const optionsRef = useRef(options);
  const stateRef = useRef(initialState);
  const [state, setRenderedState] = useState(initialState);
  const cursorHandoffRef = useRef<CursorHandoffState | null>(null);
  const markerBoxCacheRef = useRef(createMarkerBoxCache());
  const activeReticleRef = useRef<ReticleState | null>(null);
  const pendingPointerRef = useRef<PendingPointer | null>(null);
  const pointerFrameRef = useRef<number | undefined>(undefined);
  const cameraSettleFrameRef = useRef<number | undefined>(undefined);
  const scrollLockTimeoutRef = useRef<number | undefined>(undefined);
  const suppressClickTimeoutRef = useRef<number | undefined>(undefined);
  const scrollZoomRestoreRef = useRef<ScrollZoomRestore | undefined>(undefined);
  const scrollLockedExternalReticleRef = useRef(false);
  const zoomPointerInsideMapRef = useRef(true);
  const suppressNextClickRef = useRef(false);
  optionsRef.current = options;

  const updateState = useCallback((update: (current: InteractionState) => InteractionState) => {
    const next = update(stateRef.current);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setRenderedState(next);
  }, []);

  const setReticle = useCallback(
    (next: ReticleState | null) => {
      updateState((current) => (reticlesEqual(current.reticle, next) ? current : { ...current, reticle: next }));
    },
    [updateState]
  );

  const setFocusReticle = useCallback(
    (next: ReticleState | null) => {
      updateState((current) => (reticlesEqual(current.focusReticle, next) ? current : { ...current, focusReticle: next }));
    },
    [updateState]
  );

  const setPointerPoint = useCallback(
    (next: ScreenPoint | null) => {
      updateState((current) => (current.pointerPoint?.x === next?.x && current.pointerPoint?.y === next?.y ? current : { ...current, pointerPoint: next }));
    },
    [updateState]
  );

  const setCameraMoving = useCallback(
    (next: boolean) => {
      updateState((current) => (current.cameraMoving === next ? current : { ...current, cameraMoving: next }));
    },
    [updateState]
  );

  const setScrollLocked = useCallback(
    (next: boolean) => {
      updateState((current) => (current.scrollLocked === next ? current : { ...current, scrollLocked: next }));
    },
    [updateState]
  );

  const setZoomOverlay = useCallback(
    (next: ZoomOverlayState | null | ((current: ZoomOverlayState | null) => ZoomOverlayState | null)) => {
      updateState((current) => {
        const value = typeof next === "function" ? next(current.zoomOverlay) : next;
        return current.zoomOverlay === value ? current : { ...current, zoomOverlay: value };
      });
    },
    [updateState]
  );

  const cancelPendingPointer = useCallback(() => {
    pendingPointerRef.current = null;
    if (pointerFrameRef.current === undefined) return;
    cancelAnimationFrame(pointerFrameRef.current);
    pointerFrameRef.current = undefined;
  }, []);

  const clearPointer = useCallback(() => {
    cancelPendingPointer();
    cursorHandoffRef.current = null;
    updateState((current) => (current.reticle === null && current.pointerPoint === null ? current : { ...current, reticle: null, pointerPoint: null }));
  }, [cancelPendingPointer, updateState]);

  const restoreReticleAtScreenPoint = useCallback(
    (point: ScreenPoint) => {
      cursorHandoffRef.current = null;
      setPointerPoint(point);
      setReticle({ x: point.x, y: point.y, target: squareAround(point, RETICLE_TARGET_SIZE) });
    },
    [setPointerPoint, setReticle]
  );

  const restoreReticleFromClientPoint = useCallback(
    (event: Pick<globalThis.MouseEvent, "clientX" | "clientY">) => {
      const mapCanvas = optionsRef.current.mapCanvasRef.current;
      if (!mapCanvas) return;
      const rect = mapCanvas.getBoundingClientRect();
      if (!clientPointInsideRect(event, rect)) {
        clearPointer();
        return;
      }
      restoreReticleAtScreenPoint(pointFromClient(event, rect));
    },
    [clearPointer, restoreReticleAtScreenPoint]
  );

  const restoreReticleAtCurrentZoomPoint = useCallback(() => {
    const point = stateRef.current.zoomOverlay?.current;
    if (point && zoomPointerInsideMapRef.current) {
      restoreReticleAtScreenPoint(point);
      return;
    }
    clearPointer();
  }, [clearPointer, restoreReticleAtScreenPoint]);

  const suppressNextClick = useCallback(() => {
    suppressNextClickRef.current = true;
    if (suppressClickTimeoutRef.current !== undefined) window.clearTimeout(suppressClickTimeoutRef.current);
    suppressClickTimeoutRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = false;
      suppressClickTimeoutRef.current = undefined;
    }, SUPPRESSED_CLICK_FALLBACK_MS);
  }, []);

  const consumeSuppressedClick = useCallback(() => {
    if (!suppressNextClickRef.current) return false;
    suppressNextClickRef.current = false;
    if (suppressClickTimeoutRef.current !== undefined) window.clearTimeout(suppressClickTimeoutRef.current);
    suppressClickTimeoutRef.current = undefined;
    return true;
  }, []);

  const syncTargetReticle = useCallback(
    (entityId: string) => {
      const { mapCanvasRef, mapRef, sources } = optionsRef.current;
      const mapCanvas = mapCanvasRef.current;
      const map = mapRef.current;
      if (!mapCanvas || !map) return;
      const box = targetBoxForEntityId(mapCanvas, map, sources, entityId);
      if (!box) return;
      const next = reticleForTarget({ entityId, box });
      updateState((current) => {
        if (!current.reticle || current.reticle.targetEntityId !== entityId || reticlesEqual(current.reticle, next)) return current;
        if (cursorHandoffRef.current) cursorHandoffRef.current.visualPoint = { x: next.x, y: next.y };
        return { ...current, reticle: next };
      });
    },
    [updateState]
  );

  const resumeScrollZoomLater = useCallback((map: MlMap) => {
    let restore = scrollZoomRestoreRef.current;
    if (restore?.map !== map) {
      if (!map.scrollZoom.isEnabled()) return;
      if (restore) window.clearTimeout(restore.timeout);
      map.scrollZoom.disable();
      restore = { map, timeout: 0 };
      scrollZoomRestoreRef.current = restore;
    }
    window.clearTimeout(restore.timeout);
    restore.timeout = window.setTimeout(() => {
      if (scrollZoomRestoreRef.current !== restore) return;
      scrollZoomRestoreRef.current = undefined;
      if (optionsRef.current.mapRef.current === map) map.scrollZoom.enable();
    }, 0);
  }, []);

  const zoomAroundReticleTarget = useCallback(
    (map: MlMap, target: ReticleState, event: WheelEvent<HTMLDivElement>) => {
      const delta = zoomDeltaFromWheel(event);
      if (delta === 0) return;
      event.preventDefault();
      event.stopPropagation();
      resumeScrollZoomLater(map);
      map.zoomTo(map.getZoom() + delta, { around: map.unproject([target.x, target.y]), duration: 0 });
    },
    [resumeScrollZoomLater]
  );

  const flushPointer = useCallback(() => {
    pointerFrameRef.current = undefined;
    const pointer = pendingPointerRef.current;
    pendingPointerRef.current = null;
    const current = stateRef.current;
    if (!pointer || current.scrollLocked || current.zoomOverlay) return;
    const rect = pointer.currentTarget.getBoundingClientRect();
    const handoff = cursorHandoffRef.current;
    const { rawPoint, visualPoint } = cursorPointsFromEvent(pointer, rect, handoff);
    const target = hoverSelectionTarget(pointer, rect, visualPoint, optionsRef.current.mapRef.current, markerBoxCacheRef.current);
    const next = target ? reticleForTarget(target) : { ...visualPoint, target: squareAround(visualPoint, RETICLE_TARGET_SIZE) };
    if (handoff) cursorHandoffRef.current = { nativePoint: rawPoint, visualPoint: { x: next.x, y: next.y } };
    setPointerPoint(rawPoint);
    setReticle(next);
  }, [setPointerPoint, setReticle]);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const current = stateRef.current;
      if (current.scrollLocked || current.zoomOverlay) return;
      if (event.target instanceof HTMLElement && event.target.closest(".maplibregl-control-container")) {
        clearPointer();
        return;
      }
      pendingPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        currentTarget: event.currentTarget,
        target: event.target
      };
      if (pointerFrameRef.current === undefined) pointerFrameRef.current = requestAnimationFrame(flushPointer);
    },
    [clearPointer, flushPointer]
  );

  const onPointerLeave = useCallback(() => {
    const current = stateRef.current;
    if (current.scrollLocked || current.zoomOverlay) setPointerPoint(null);
    else clearPointer();
  }, [clearPointer, setPointerPoint]);

  const onMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!event.shiftKey || event.button !== 0) return;
      if (event.target instanceof HTMLElement && event.target.closest(".maplibregl-control-container")) return;
      const point = pointFromClient(event, event.currentTarget.getBoundingClientRect(), true);
      setPointerPoint(point);
      setZoomOverlay({ start: point, current: point });
      zoomPointerInsideMapRef.current = true;
      cursorHandoffRef.current = null;
      setReticle(null);
      optionsRef.current.notifyUserGesture();
    },
    [setPointerPoint, setReticle, setZoomOverlay]
  );

  const onWheelCapture = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      const current = stateRef.current;
      if (current.zoomOverlay) return;
      if (event.target instanceof HTMLElement && event.target.closest(".maplibregl-control-container")) return;
      const map = optionsRef.current.mapRef.current;
      const rect = event.currentTarget.getBoundingClientRect();
      setPointerPoint(pointFromClient(event, rect));
      const hoverReticle = current.reticle;
      const activeReticle = hoverReticle ?? activeReticleRef.current;
      scrollLockedExternalReticleRef.current = Boolean(activeReticle && !hoverReticle);
      if (map && activeReticle?.targetEntityId) zoomAroundReticleTarget(map, activeReticle, event);
      if (activeReticle) setReticle(hoverReticle ?? { ...activeReticle, targetEntityId: undefined });
      const visualPoint = activeReticle ? { x: activeReticle.x, y: activeReticle.y } : pointFromClient(event, rect);
      cursorHandoffRef.current = activeReticle?.targetEntityId ? null : { nativePoint: pointFromClient(event, rect), visualPoint };
      event.currentTarget.classList.add("map-canvas--scrolling");
      setScrollLocked(true);
      if (scrollLockTimeoutRef.current !== undefined) window.clearTimeout(scrollLockTimeoutRef.current);
      scrollLockTimeoutRef.current = window.setTimeout(() => {
        scrollLockTimeoutRef.current = undefined;
        optionsRef.current.mapCanvasRef.current?.classList.remove("map-canvas--scrolling");
        setScrollLocked(false);
        if (scrollLockedExternalReticleRef.current) {
          scrollLockedExternalReticleRef.current = false;
          setReticle(null);
        } else {
          const entityId = stateRef.current.reticle?.targetEntityId;
          if (entityId) syncTargetReticle(entityId);
        }
      }, SCROLL_LOCK_SETTLE_MS);
    },
    [setPointerPoint, setReticle, setScrollLocked, syncTargetReticle, zoomAroundReticleTarget]
  );

  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLElement && event.target.closest(".maplibregl-control-container")) return;
      if (consumeSuppressedClick() || stateRef.current.zoomOverlay) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const { mapRef, onSelectEntity, onBackgroundClick, selectedEntityId } = optionsRef.current;
      const rect = event.currentTarget.getBoundingClientRect();
      const point = cursorPointsFromEvent(event, rect, cursorHandoffRef.current).visualPoint;
      const clickTargets = hoverSelectionTargets(event, rect, point, mapRef.current, markerBoxCacheRef.current, event.detail === 0);
      if (clickTargets.length > 0) {
        // Re-clicking the already-selected entity cycles through overlapping targets.
        const selectedIndex = clickTargets.findIndex((target) => target.entityId === selectedEntityId);
        onSelectEntity(clickTargets[(selectedIndex + 1) % clickTargets.length].entityId);
        return;
      }
      const entityId = stateRef.current.reticle?.targetEntityId;
      if (entityId) {
        onSelectEntity(entityId);
        return;
      }
      onBackgroundClick?.();
    },
    [consumeSuppressedClick]
  );

  const navigateWithArrow = useCallback(
    (event: globalThis.KeyboardEvent) => {
      const direction = directionFromKey(event.key);
      if (!direction || isEditableKeyboardTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (stateRef.current.zoomOverlay) return;
      const { mapCanvasRef, mapRef, sources, selectedEntityId, onSelectEntity } = optionsRef.current;
      const mapCanvas = mapCanvasRef.current;
      const map = mapRef.current;
      if (!mapCanvas || !map) return;
      const nextEntityId = nextVisibleEntityInDirection(mapCanvas, map, sources, selectedEntityId, direction);
      if (!nextEntityId) return;
      setReticle(null);
      onSelectEntity(nextEntityId);
    },
    [setReticle]
  );

  const completeBoxZoom = useCallback(
    (map: MlMap, start: PointLike, end: PointLike) => {
      suppressNextClick();
      restoreReticleAtScreenPoint(Array.isArray(end) ? { x: end[0], y: end[1] } : { x: end.x, y: end.y });
      setZoomOverlay(null);
      optionsRef.current.notifyUserGesture();
      map.fitScreenCoordinates(start, end, map.getBearing(), { linear: true });
    },
    [restoreReticleAtScreenPoint, setZoomOverlay, suppressNextClick]
  );

  const cancelBoxZoom = useCallback(() => {
    restoreReticleAtCurrentZoomPoint();
    setZoomOverlay(null);
  }, [restoreReticleAtCurrentZoomPoint, setZoomOverlay]);

  const zooming = state.zoomOverlay !== null;

  useEffect(() => {
    const mapCanvas = mapCanvasRef.current;
    if (!mapCanvas) return;
    const preventPageScroll = (event: globalThis.WheelEvent) => event.preventDefault();
    mapCanvas.addEventListener("wheel", preventPageScroll, { capture: true, passive: false });
    return () => mapCanvas.removeEventListener("wheel", preventPageScroll, { capture: true });
  }, [mapCanvasRef]);

  useEffect(() => {
    window.addEventListener("keydown", navigateWithArrow, true);
    return () => window.removeEventListener("keydown", navigateWithArrow, true);
  }, [navigateWithArrow]);

  // Marker screen boxes only change with the camera or an entity snapshot, so
  // hover hit-testing reuses them between invalidations instead of measuring
  // every marker on each pointer frame.
  useEffect(() => {
    invalidateMarkerBoxCache(markerBoxCacheRef.current);
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const invalidate = () => invalidateMarkerBoxCache(markerBoxCacheRef.current);
    map.on("move", invalidate);
    map.on("zoom", invalidate);
    map.on("resize", invalidate);
    map.on("moveend", invalidate);
    return () => {
      map.off("move", invalidate);
      map.off("zoom", invalidate);
      map.off("resize", invalidate);
      map.off("moveend", invalidate);
    };
  }, [mapReady, mapRef, sources]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) {
      setCameraMoving(false);
      return;
    }
    const start = () => {
      if (cameraSettleFrameRef.current !== undefined) cancelAnimationFrame(cameraSettleFrameRef.current);
      cameraSettleFrameRef.current = undefined;
      setCameraMoving(true);
    };
    const end = () => {
      if (cameraSettleFrameRef.current !== undefined) cancelAnimationFrame(cameraSettleFrameRef.current);
      cameraSettleFrameRef.current = requestAnimationFrame(() => {
        cameraSettleFrameRef.current = undefined;
        setCameraMoving(false);
      });
    };
    map.on("movestart", start);
    map.on("moveend", end);
    return () => {
      map.off("movestart", start);
      map.off("moveend", end);
      if (cameraSettleFrameRef.current !== undefined) cancelAnimationFrame(cameraSettleFrameRef.current);
      cameraSettleFrameRef.current = undefined;
    };
  }, [mapReady, mapRef, setCameraMoving]);

  const reticleVisible = state.reticle !== null;

  useEffect(() => {
    if (!reticleVisible && !selectedEntityId) return;
    const releaseOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || stateRef.current.zoomOverlay) return;
      event.preventDefault();
      event.stopPropagation();
      if (optionsRef.current.selectedEntityId) optionsRef.current.onBackgroundClick?.();
      else clearPointer();
    };
    window.addEventListener("keydown", releaseOnEscape, true);
    return () => window.removeEventListener("keydown", releaseOnEscape, true);
  }, [clearPointer, reticleVisible, selectedEntityId]);

  useEffect(() => {
    const clearWhenOutsideMap = (event: globalThis.PointerEvent) => {
      if (!stateRef.current.pointerPoint || stateRef.current.zoomOverlay) return;
      const mapCanvas = optionsRef.current.mapCanvasRef.current;
      if (!mapCanvas || clientPointInsideRect(event, mapCanvas.getBoundingClientRect())) return;
      if (stateRef.current.scrollLocked) setPointerPoint(null);
      else clearPointer();
    };
    window.addEventListener("pointermove", clearWhenOutsideMap);
    return () => window.removeEventListener("pointermove", clearWhenOutsideMap);
  }, [clearPointer, setPointerPoint]);

  useEffect(() => {
    if (!zooming) return;
    const updateZoomDrag = (event: globalThis.MouseEvent) => {
      const mapCanvas = optionsRef.current.mapCanvasRef.current;
      if (!mapCanvas) return;
      const rect = mapCanvas.getBoundingClientRect();
      zoomPointerInsideMapRef.current = clientPointInsideRect(event, rect);
      setZoomOverlay((current) => (current ? { ...current, current: pointFromClient(event, rect, true) } : null));
    };
    const finishZoomDrag = (event: globalThis.MouseEvent) => {
      suppressNextClick();
      restoreReticleFromClientPoint(event);
      setZoomOverlay(null);
    };
    const cancelZoomDrag = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      suppressNextClick();
      restoreReticleAtCurrentZoomPoint();
      setZoomOverlay(null);
    };
    window.addEventListener("mousemove", updateZoomDrag);
    window.addEventListener("mouseup", finishZoomDrag);
    window.addEventListener("keydown", cancelZoomDrag);
    return () => {
      window.removeEventListener("mousemove", updateZoomDrag);
      window.removeEventListener("mouseup", finishZoomDrag);
      window.removeEventListener("keydown", cancelZoomDrag);
    };
  }, [restoreReticleAtCurrentZoomPoint, restoreReticleFromClientPoint, setZoomOverlay, suppressNextClick, zooming]);

  useEffect(() => {
    const map = mapRef.current;
    const entityId = state.reticle?.targetEntityId;
    if (!map || !mapReady || !entityId) return;
    const sync = () => syncTargetReticle(entityId);
    sync();
    map.on("move", sync);
    map.on("zoom", sync);
    map.on("moveend", sync);
    return () => {
      map.off("move", sync);
      map.off("zoom", sync);
      map.off("moveend", sync);
    };
  }, [mapReady, mapRef, sources, state.reticle?.targetEntityId, syncTargetReticle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !focusTarget) {
      setFocusReticle(null);
      return;
    }
    const nextFocusReticle = () => {
      const current = stateRef.current;
      return current.zoomOverlay ? current.focusReticle : reticleForVisibleTarget(mapCanvasRef.current, map, sources, focusTarget);
    };
    const sync = () => setFocusReticle(nextFocusReticle());
    sync();
    const syncCameraFrame = () => {
      const next = nextFocusReticle();
      if (reticlesEqual(stateRef.current.focusReticle, next)) return;
      flushSync(() => setFocusReticle(next));
    };
    map.on("move", syncCameraFrame);
    map.on("zoom", syncCameraFrame);
    map.on("moveend", syncCameraFrame);
    return () => {
      map.off("move", syncCameraFrame);
      map.off("zoom", syncCameraFrame);
      map.off("moveend", syncCameraFrame);
    };
  }, [focusTarget, mapCanvasRef, mapReady, mapRef, setFocusReticle, sources, zooming]);

  useEffect(
    () => () => {
      cancelPendingPointer();
      if (scrollLockTimeoutRef.current !== undefined) window.clearTimeout(scrollLockTimeoutRef.current);
      if (suppressClickTimeoutRef.current !== undefined) window.clearTimeout(suppressClickTimeoutRef.current);
      if (scrollZoomRestoreRef.current) window.clearTimeout(scrollZoomRestoreRef.current.timeout);
      scrollZoomRestoreRef.current = undefined;
    },
    [cancelPendingPointer]
  );

  const visibleReticle = state.zoomOverlay ? reticleFromTargetBox(boxFromDrag(state.zoomOverlay)) : focusTarget ? state.focusReticle : state.reticle;
  const cursorOverlay = zooming ? undefined : cursorOverlayState(mapRef.current, state.pointerPoint, focusTarget ? state.focusReticle : null);
  activeReticleRef.current = visibleReticle;

  return {
    visibleReticle,
    cursorOverlay,
    scrolling: state.scrollLocked || state.cameraMoving,
    zooming,
    customCursorVisible: Boolean(state.zoomOverlay || (state.pointerPoint && visibleReticle)),
    canvasHandlers: { onClick, onMouseDown, onPointerLeave, onPointerMove, onWheelCapture },
    mapActions: { cancelBoxZoom, completeBoxZoom }
  };
}

function directionFromKey(key: string): MapNavigationDirection | null {
  return key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right" : null;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.matches("input, textarea, select, [role='separator']") || target.isContentEditable);
}

function cursorOverlayState(map: MlMap | undefined, point: ScreenPoint | null, selection: ReticleState | null): CursorOverlayState | undefined {
  if (!map || !point) return undefined;
  const pointerCoordinates = map.unproject([point.x, point.y]);
  if (!selection) return { point, coordinates: { lng: pointerCoordinates.lng, lat: pointerCoordinates.lat } };
  const selectionCoordinates = map.unproject([selection.x, selection.y]);
  const selectionPosition = { lng: selectionCoordinates.lng, lat: selectionCoordinates.lat };
  const pointerPosition = { lng: pointerCoordinates.lng, lat: pointerCoordinates.lat };
  return {
    point,
    coordinates: pointerPosition,
    selection,
    distanceMeters: geographicDistanceMeters(selectionPosition, pointerPosition),
    bearingDegrees: geographicBearingDegrees(selectionPosition, pointerPosition)
  };
}
