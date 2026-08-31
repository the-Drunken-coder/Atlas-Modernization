import { useEffect, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { clientPointInsideRect, reticlesEqual } from "../view/map-view-utils.js";
import { pointFromClient } from "./map-reticle.js";
import type { InteractionStateStore } from "./map-reticle-interaction-state.js";
import type { MapReticleInteractionOptions } from "./map-reticle-interaction-types.js";
import { invalidateMarkerBoxCache, reticleForVisibleTarget } from "./map-targets.js";
import type { useMapReticlePointer } from "./use-map-reticle-pointer.js";

type ReticlePointer = ReturnType<typeof useMapReticlePointer>;

type EffectsOptions = {
  options: MapReticleInteractionOptions;
  stateStore: InteractionStateStore;
  pointer: ReticlePointer;
  zooming: boolean;
  reticleVisible: boolean;
};

export function useMapReticleEffects({ options, stateStore, pointer, zooming, reticleVisible }: EffectsOptions): void {
  const { mapCanvasRef, mapRef, mapReady, sources, focusTarget, selectedEntityId } = options;
  const { state, stateRef, setFocusReticle, setPointerPoint, setCameraMoving, setZoomOverlay } = stateStore;
  const {
    optionsRef,
    markerBoxCacheRef,
    cancelPendingPointer,
    clearPointer,
    restoreReticleAtCurrentZoomPoint,
    restoreReticleFromClientPoint,
    suppressNextClick,
    syncTargetReticle,
    zoomPointerInsideMapRef,
    navigateWithArrow,
    scrollLockTimeoutRef,
    suppressClickTimeoutRef,
    scrollZoomRestoreRef
  } = pointer;
  const cameraSettleFrameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const mapCanvas = mapCanvasRef.current;
    if (!mapCanvas) return;
    const preventPageScroll = (event: globalThis.WheelEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-map-interaction-control]")) return;
      event.preventDefault();
    };
    mapCanvas.addEventListener("wheel", preventPageScroll, { capture: true, passive: false });
    return () => mapCanvas.removeEventListener("wheel", preventPageScroll, { capture: true });
  }, [mapCanvasRef]);

  useEffect(() => {
    window.addEventListener("keydown", navigateWithArrow);
    return () => window.removeEventListener("keydown", navigateWithArrow);
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
  }, [mapReady, mapRef, sources, markerBoxCacheRef]);

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

  useLayoutEffect(() => {
    if (!reticleVisible && !selectedEntityId) return;
    const releaseOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || stateRef.current.zoomOverlay || isEditableTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (optionsRef.current.selectedEntityId) optionsRef.current.onBackgroundClick?.();
      else clearPointer();
    };
    window.addEventListener("keydown", releaseOnEscape);
    return () => window.removeEventListener("keydown", releaseOnEscape);
  }, [clearPointer, optionsRef, reticleVisible, selectedEntityId, stateRef]);

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
  }, [clearPointer, optionsRef, setPointerPoint, stateRef]);

  useEffect(() => {
    if (!zooming) return;
    const updateZoomDrag = (event: globalThis.MouseEvent) => {
      const mapCanvas = mapCanvasRef.current;
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
  }, [
    restoreReticleAtCurrentZoomPoint,
    restoreReticleFromClientPoint,
    setZoomOverlay,
    suppressNextClick,
    zooming,
    zoomPointerInsideMapRef,
    mapCanvasRef
  ]);

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
      return current.zoomOverlay
        ? current.focusReticle
        : reticleForVisibleTarget(mapCanvasRef.current, map, sources, focusTarget);
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
  }, [focusTarget, mapCanvasRef, mapReady, mapRef, setFocusReticle, sources, stateRef, zooming]);

  useEffect(
    () => () => {
      cancelPendingPointer();
      if (scrollLockTimeoutRef.current !== undefined) window.clearTimeout(scrollLockTimeoutRef.current);
      if (suppressClickTimeoutRef.current !== undefined) window.clearTimeout(suppressClickTimeoutRef.current);
      if (scrollZoomRestoreRef.current) window.clearTimeout(scrollZoomRestoreRef.current.timeout);
      scrollZoomRestoreRef.current = undefined;
    },
    [cancelPendingPointer, scrollLockTimeoutRef, scrollZoomRestoreRef, suppressClickTimeoutRef]
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
}
