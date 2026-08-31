import { cursorOverlayState } from "./map-cursor-overlay.js";
import { boxFromDrag, type ReticleState, reticleFromTargetBox } from "./map-reticle.js";
import { type InteractionState, useMapReticleInteractionState } from "./map-reticle-interaction-state.js";
import type { MapReticleInteractionOptions } from "./map-reticle-interaction-types.js";
import { useMapReticleEffects } from "./use-map-reticle-effects.js";
import { useMapReticlePointer } from "./use-map-reticle-pointer.js";

export function useMapReticleInteraction(options: MapReticleInteractionOptions) {
  const stateStore = useMapReticleInteractionState();
  const pointer = useMapReticlePointer({ options, stateStore });
  const zooming = stateStore.state.zoomOverlay !== null;
  const reticleVisible = stateStore.state.reticle !== null;

  useMapReticleEffects({ options, stateStore, pointer, zooming, reticleVisible });

  const visibleReticle = visibleReticleForState(stateStore.state, options.focusTarget);
  const cursorOverlay = zooming
    ? undefined
    : cursorOverlayState(
        options.mapRef.current,
        stateStore.state.pointerPoint,
        options.focusTarget ? stateStore.state.focusReticle : null
      );
  pointer.activeReticleRef.current = visibleReticle;

  return {
    visibleReticle,
    cursorOverlay,
    scrolling: stateStore.state.scrollLocked || stateStore.state.cameraMoving,
    zooming,
    customCursorVisible: Boolean(stateStore.state.zoomOverlay || (stateStore.state.pointerPoint && visibleReticle)),
    canvasHandlers: {
      onClick: pointer.onClick,
      onMouseDown: pointer.onMouseDown,
      onPointerLeave: pointer.onPointerLeave,
      onPointerMove: pointer.onPointerMove,
      onWheelCapture: pointer.onWheelCapture
    },
    mapActions: {
      cancelBoxZoom: pointer.cancelBoxZoom,
      completeBoxZoom: pointer.completeBoxZoom,
      consumeSuppressedClick: pointer.consumeSuppressedClick,
      suppressNextClick: pointer.suppressNextClick
    }
  };
}

function visibleReticleForState(
  state: InteractionState,
  focusTarget: MapReticleInteractionOptions["focusTarget"]
): ReticleState | null {
  return state.zoomOverlay
    ? reticleFromTargetBox(boxFromDrag(state.zoomOverlay))
    : focusTarget
      ? state.focusReticle
      : state.reticle;
}
