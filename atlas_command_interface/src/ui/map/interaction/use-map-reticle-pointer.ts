import type { Map as MlMap, PointLike } from "maplibre-gl";
import { type MouseEvent, type PointerEvent, useCallback, useRef, type WheelEvent } from "react";
import {
  type CursorHandoffState,
  clientPointInsideRect,
  cursorPointsFromEvent,
  reticlesEqual,
  zoomDeltaFromWheel
} from "../view/map-view-utils.js";
import { CAMERA_EVENT_TAG, FIT_BOUNDS_PADDING, FIT_DURATION_MS } from "./map-camera.js";
import {
  chooseGeographicZoomTarget,
  fetchMapTilerGeographicTargets,
  GEOGRAPHIC_FIT_MAX_ZOOM
} from "./map-geography.js";
import {
  pointFromClient,
  RETICLE_TARGET_SIZE,
  type ReticleState,
  reticleForTarget,
  type ScreenPoint,
  squareAround
} from "./map-reticle.js";
import type { InteractionStateStore } from "./map-reticle-interaction-state.js";
import type { MapReticleInteractionOptions } from "./map-reticle-interaction-types.js";
import {
  createMarkerBoxCache,
  hoverSelectionTarget,
  hoverSelectionTargets,
  type MapNavigationDirection,
  nextVisibleEntityInDirection,
  targetBoxForEntityId
} from "./map-targets.js";

const SCROLL_LOCK_SETTLE_MS = 180;
const SUPPRESSED_CLICK_FALLBACK_MS = 750;

type PendingPointer = {
  clientX: number;
  clientY: number;
  currentTarget: HTMLDivElement;
  target: EventTarget | null;
};

type ScrollZoomRestore = { map: MlMap; timeout: number };

type PointerHookOptions = {
  options: MapReticleInteractionOptions;
  stateStore: InteractionStateStore;
};

export function useMapReticlePointer({ options, stateStore }: PointerHookOptions) {
  const { stateRef, updateState, setReticle, setPointerPoint, setScrollLocked, setZoomOverlay } = stateStore;
  const optionsRef = useRef<MapReticleInteractionOptions>(options);
  const cursorHandoffRef = useRef<CursorHandoffState | null>(null);
  const markerBoxCacheRef = useRef(createMarkerBoxCache());
  const activeReticleRef = useRef<ReticleState | null>(null);
  const pendingPointerRef = useRef<PendingPointer | null>(null);
  const pointerFrameRef = useRef<number | undefined>(undefined);
  const scrollLockTimeoutRef = useRef<number | undefined>(undefined);
  const suppressClickTimeoutRef = useRef<number | undefined>(undefined);
  const scrollZoomRestoreRef = useRef<ScrollZoomRestore | undefined>(undefined);
  const scrollLockedExternalReticleRef = useRef(false);
  const zoomPointerInsideMapRef = useRef(true);
  const suppressNextClickRef = useRef(false);
  const geographicZoomAbortRef = useRef<AbortController | undefined>(undefined);
  const geographicZoomRequestRef = useRef(0);
  optionsRef.current = options;

  const cancelGeographicZoom = useCallback(() => {
    geographicZoomRequestRef.current += 1;
    geographicZoomAbortRef.current?.abort();
    geographicZoomAbortRef.current = undefined;
  }, []);

  const cancelPendingPointer = useCallback(() => {
    pendingPointerRef.current = null;
    if (pointerFrameRef.current === undefined) return;
    cancelAnimationFrame(pointerFrameRef.current);
    pointerFrameRef.current = undefined;
  }, []);

  const clearPointer = useCallback(() => {
    cancelPendingPointer();
    cursorHandoffRef.current = null;
    updateState((current) =>
      current.reticle === null && current.pointerPoint === null
        ? current
        : { ...current, reticle: null, pointerPoint: null }
    );
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
  }, [clearPointer, restoreReticleAtScreenPoint, stateRef]);

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
        if (!current.reticle || current.reticle.targetEntityId !== entityId || reticlesEqual(current.reticle, next))
          return current;
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
    const target = hoverSelectionTarget(
      pointer,
      rect,
      visualPoint,
      optionsRef.current.mapRef.current,
      markerBoxCacheRef.current
    );
    const next = target
      ? reticleForTarget(target)
      : { ...visualPoint, target: squareAround(visualPoint, RETICLE_TARGET_SIZE) };
    if (handoff) cursorHandoffRef.current = { nativePoint: rawPoint, visualPoint: { x: next.x, y: next.y } };
    setPointerPoint(rawPoint);
    setReticle(next);
  }, [setPointerPoint, setReticle, stateRef]);

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
    [clearPointer, flushPointer, stateRef]
  );

  const onPointerLeave = useCallback(() => {
    const current = stateRef.current;
    if (current.scrollLocked || current.zoomOverlay) setPointerPoint(null);
    else clearPointer();
  }, [clearPointer, setPointerPoint, stateRef]);

  const onMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      cancelGeographicZoom();
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
    [cancelGeographicZoom, setPointerPoint, setReticle, setZoomOverlay]
  );

  const onWheelCapture = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      cancelGeographicZoom();
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
      cursorHandoffRef.current = activeReticle?.targetEntityId
        ? null
        : { nativePoint: pointFromClient(event, rect), visualPoint };
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
    [
      cancelGeographicZoom,
      setPointerPoint,
      setReticle,
      setScrollLocked,
      stateRef,
      syncTargetReticle,
      zoomAroundReticleTarget
    ]
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
      const clickTargets = hoverSelectionTargets(
        event,
        rect,
        point,
        mapRef.current,
        markerBoxCacheRef.current,
        event.detail === 0
      );
      if (clickTargets.length > 0) {
        // Re-clicking the already-selected entity cycles through overlapping targets.
        const selectedIndex = clickTargets.findIndex((target) => target.entityId === selectedEntityId);
        onSelectEntity(clickTargets[(selectedIndex + 1) % clickTargets.length].entityId);
        return;
      }
      onBackgroundClick?.();
    },
    [consumeSuppressedClick, stateRef]
  );

  const onDoubleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLElement && event.target.closest(".maplibregl-control-container")) return;
      event.preventDefault();
      event.stopPropagation();
      cancelGeographicZoom();

      const { mapRef, maptilerApiKey, notifyUserGesture } = optionsRef.current;
      const map = mapRef.current;
      if (!map) return;
      notifyUserGesture();

      const point = pointFromClient(event, event.currentTarget.getBoundingClientRect());
      const clicked = map.unproject([point.x, point.y]);
      const coordinates: [number, number] = [clicked.lng, clicked.lat];
      const requestView = cameraView(map);
      if (!maptilerApiKey) {
        zoomOneLevel(map, coordinates);
        return;
      }

      const requestId = geographicZoomRequestRef.current;
      const controller = new AbortController();
      geographicZoomAbortRef.current = controller;
      void fetchMapTilerGeographicTargets({
        apiKey: maptilerApiKey,
        coordinates,
        zoom: requestView.zoom,
        signal: controller.signal
      })
        .then((targets) => {
          if (controller.signal.aborted || geographicZoomRequestRef.current !== requestId) return;
          geographicZoomAbortRef.current = undefined;
          if (!cameraViewMatches(map, requestView)) return;
          const target = chooseGeographicZoomTarget(map, targets);
          if (!target) {
            zoomOneLevel(map, coordinates);
            return;
          }
          map.fitBounds(
            target.bounds,
            { duration: FIT_DURATION_MS, maxZoom: GEOGRAPHIC_FIT_MAX_ZOOM, padding: FIT_BOUNDS_PADDING },
            { [CAMERA_EVENT_TAG]: true }
          );
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || geographicZoomRequestRef.current !== requestId) return;
          geographicZoomAbortRef.current = undefined;
          console.warn("Map geographic lookup failed", error instanceof Error ? error.message : "unknown error");
          if (cameraViewMatches(map, requestView)) zoomOneLevel(map, coordinates);
        });
    },
    [cancelGeographicZoom]
  );

  const navigateWithArrow = useCallback(
    (event: globalThis.KeyboardEvent) => {
      const direction = directionFromKey(event.key);
      if (!direction || isEditableKeyboardTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      cancelGeographicZoom();
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
    [cancelGeographicZoom, setReticle, stateRef]
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

  return {
    optionsRef,
    markerBoxCacheRef,
    activeReticleRef,
    scrollLockTimeoutRef,
    suppressClickTimeoutRef,
    scrollZoomRestoreRef,
    cancelGeographicZoom,
    zoomPointerInsideMapRef,
    cancelPendingPointer,
    clearPointer,
    restoreReticleAtCurrentZoomPoint,
    restoreReticleFromClientPoint,
    suppressNextClick,
    syncTargetReticle,
    navigateWithArrow,
    onClick,
    onDoubleClick,
    onMouseDown,
    onPointerLeave,
    onPointerMove,
    onWheelCapture,
    cancelBoxZoom,
    completeBoxZoom
  };
}

function directionFromKey(key: string): MapNavigationDirection | null {
  return key === "ArrowUp"
    ? "up"
    : key === "ArrowDown"
      ? "down"
      : key === "ArrowLeft"
        ? "left"
        : key === "ArrowRight"
          ? "right"
          : null;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.matches("input, textarea, select, [role='separator']") || target.isContentEditable)
  );
}

type CameraView = { center: [number, number]; zoom: number };

function cameraView(map: Pick<MlMap, "getCenter" | "getZoom">): CameraView {
  const center = map.getCenter();
  return { center: [center.lng, center.lat], zoom: map.getZoom() };
}

function cameraViewMatches(map: Pick<MlMap, "getCenter" | "getZoom">, expected: CameraView): boolean {
  const current = cameraView(map);
  return (
    current.zoom === expected.zoom &&
    current.center[0] === expected.center[0] &&
    current.center[1] === expected.center[1]
  );
}

function zoomOneLevel(map: Pick<MlMap, "getMaxZoom" | "getZoom" | "zoomTo">, around: [number, number]): void {
  map.zoomTo(
    Math.min(map.getZoom() + 1, map.getMaxZoom()),
    { around, duration: FIT_DURATION_MS },
    {
      [CAMERA_EVENT_TAG]: true
    }
  );
}
