import { useCallback, useRef, useState } from "react";
import type { ReticleState, ScreenPoint, ZoomOverlayState } from "./map-reticle.js";
import { reticlesEqual } from "./map-view-utils.js";

export type InteractionState = {
  reticle: ReticleState | null;
  focusReticle: ReticleState | null;
  pointerPoint: ScreenPoint | null;
  cameraMoving: boolean;
  scrollLocked: boolean;
  zoomOverlay: ZoomOverlayState | null;
};

export type ZoomOverlayUpdate =
  | ZoomOverlayState
  | null
  | ((current: ZoomOverlayState | null) => ZoomOverlayState | null);

export type InteractionStateStore = {
  state: InteractionState;
  stateRef: { current: InteractionState };
  updateState: (update: (current: InteractionState) => InteractionState) => void;
  setReticle: (next: ReticleState | null) => void;
  setFocusReticle: (next: ReticleState | null) => void;
  setPointerPoint: (next: ScreenPoint | null) => void;
  setCameraMoving: (next: boolean) => void;
  setScrollLocked: (next: boolean) => void;
  setZoomOverlay: (next: ZoomOverlayUpdate) => void;
};

const initialState: InteractionState = {
  reticle: null,
  focusReticle: null,
  pointerPoint: null,
  cameraMoving: false,
  scrollLocked: false,
  zoomOverlay: null
};

export function useMapReticleInteractionState() {
  const stateRef = useRef(initialState);
  const [state, setRenderedState] = useState(initialState);

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
      updateState((current) =>
        reticlesEqual(current.focusReticle, next) ? current : { ...current, focusReticle: next }
      );
    },
    [updateState]
  );

  const setPointerPoint = useCallback(
    (next: ScreenPoint | null) => {
      updateState((current) =>
        current.pointerPoint?.x === next?.x && current.pointerPoint?.y === next?.y
          ? current
          : { ...current, pointerPoint: next }
      );
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
    (next: ZoomOverlayUpdate) => {
      updateState((current) => {
        const value = typeof next === "function" ? next(current.zoomOverlay) : next;
        return current.zoomOverlay === value ? current : { ...current, zoomOverlay: value };
      });
    },
    [updateState]
  );

  return {
    state,
    stateRef,
    updateState,
    setReticle,
    setFocusReticle,
    setPointerPoint,
    setCameraMoving,
    setScrollLocked,
    setZoomOverlay
  };
}
