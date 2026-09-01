import {
  createContext,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from "react";
import {
  dockTargetAtPoint,
  edgeForArrow,
  initialMapWindowWorkspaceState,
  MAP_WINDOW_EDGES,
  type MapWindowDockTarget,
  type MapWindowEdge,
  type MapWindowWorkspaceAction,
  type MapWindowWorkspaceState,
  mapWindowWorkspaceReducer
} from "./map-window-workspace-state.js";

type DragPreview = { id: string; target?: MapWindowDockTarget };

type MapWindowWorkspaceContextValue = {
  state: MapWindowWorkspaceState;
  dispatch(action: MapWindowWorkspaceAction): void;
  workspaceRef: React.RefObject<HTMLDivElement | null>;
  dragPreview?: DragPreview;
  setDragPreview(preview?: DragPreview): void;
};

const MapWindowWorkspaceContext = createContext<MapWindowWorkspaceContextValue | undefined>(undefined);

/** Owns the layout and ordered edge rails for every window over one map. */
export function MapWindowWorkspace({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(mapWindowWorkspaceReducer, initialMapWindowWorkspaceState);
  const [dragPreview, setDragPreview] = useState<DragPreview>();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const value = useMemo(() => ({ state, dispatch, workspaceRef, dragPreview, setDragPreview }), [state, dragPreview]);

  return (
    <MapWindowWorkspaceContext.Provider value={value}>
      <div ref={workspaceRef} className="map-window-workspace" data-dragging={dragPreview ? true : undefined}>
        {children}
        {MAP_WINDOW_EDGES.map((edge) => (
          <MapWindowRail key={edge} edge={edge} />
        ))}
        {dragPreview?.target ? (
          <div className="map-window-dock-zone" data-edge={dragPreview.target.edge} aria-hidden="true" />
        ) : null}
      </div>
    </MapWindowWorkspaceContext.Provider>
  );
}

export function useMapWindowWorkspace(): MapWindowWorkspaceContextValue {
  const workspace = useContext(MapWindowWorkspaceContext);
  if (!workspace) throw new Error("MapWindow must be rendered inside MapWindowWorkspace.");
  return workspace;
}

function MapWindowRail({ edge }: { edge: MapWindowEdge }) {
  const { state, dragPreview } = useMapWindowWorkspace();
  const ids = state.rails[edge];
  const insertionIndex = dragPreview?.target?.edge === edge ? dragPreview.target.index : undefined;
  let candidateIndex = 0;

  return (
    <div
      className={`map-window-rail map-window-rail--${edge}`}
      data-edge={edge}
      data-map-interaction-control
      role="toolbar"
      aria-label={`${capitalize(edge)} window rail`}
      aria-orientation={edge === "top" || edge === "bottom" ? "horizontal" : "vertical"}
    >
      {ids.map((id) => {
        const dragged = id === dragPreview?.id;
        const showSlot = !dragged && insertionIndex === candidateIndex;
        if (!dragged) candidateIndex += 1;
        return (
          <Fragment key={id}>
            {showSlot ? <span className="map-window-rail__slot" aria-hidden="true" /> : null}
            <MapWindowRailTab id={id} edge={edge} />
          </Fragment>
        );
      })}
      {insertionIndex === candidateIndex ? <span className="map-window-rail__slot" aria-hidden="true" /> : null}
    </div>
  );
}

function MapWindowRailTab({ id, edge }: { id: string; edge: MapWindowEdge }) {
  const { state, dispatch, workspaceRef, dragPreview, setDragPreview } = useMapWindowWorkspace();
  const pointer = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | undefined>(undefined);
  const stopListeningRef = useRef<(() => void) | undefined>(undefined);
  const suppressClick = useRef(false);
  const layout = state.windows[id];

  useEffect(
    () => () => {
      if (!pointer.current) return;
      stopListeningRef.current?.();
      setDragPreview();
    },
    [setDragPreview]
  );

  if (!layout) return null;
  const open = state.openByEdge[edge] === id;

  const targetAt = (x: number, y: number): MapWindowDockTarget | undefined => {
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (!bounds) return undefined;
    return dockTargetAtPoint({ x, y }, bounds, railLengthsWithout(state, id));
  };

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    pointer.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    const tab = event.currentTarget;
    tab.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    const continueDrag = (moveEvent: globalThis.PointerEvent) => {
      const drag = pointer.current;
      if (!drag || drag.pointerId !== moveEvent.pointerId) return;
      if (!drag.moved && Math.hypot(moveEvent.clientX - drag.x, moveEvent.clientY - drag.y) < 4) return;
      drag.moved = true;
      setDragPreview({ id, target: targetAt(moveEvent.clientX, moveEvent.clientY) });
    };
    const finishDrag = (finishEvent: globalThis.PointerEvent) => {
      const drag = pointer.current;
      if (!drag || drag.pointerId !== finishEvent.pointerId) return;
      pointer.current = undefined;
      stopListeningRef.current?.();
      if (tab.hasPointerCapture?.(finishEvent.pointerId)) {
        tab.releasePointerCapture(finishEvent.pointerId);
      }
      if (finishEvent.type === "pointerup" && drag.moved) {
        const target = targetAt(finishEvent.clientX, finishEvent.clientY);
        if (target) dispatch({ type: "dock", id, target, open });
        else {
          dispatch({
            type: "float",
            id,
            position: floatingPositionAt(finishEvent.clientX, finishEvent.clientY, workspaceRef.current)
          });
        }
        suppressClick.current = true;
        focusMapWindow(id);
      }
      setDragPreview();
    };
    window.addEventListener("pointermove", continueDrag);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    stopListeningRef.current = () => {
      window.removeEventListener("pointermove", continueDrag);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      stopListeningRef.current = undefined;
    };
  };

  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    const requestedEdge = edgeForArrow(event.key);
    if (event.altKey && requestedEdge) {
      event.preventDefault();
      dispatch({
        type: "dock",
        id,
        target: { edge: requestedEdge, index: state.rails[requestedEdge].length },
        open
      });
      focusRailTab(id);
      return;
    }

    const horizontal = edge === "top" || edge === "bottom";
    const previousKey = horizontal ? "ArrowLeft" : "ArrowUp";
    const nextKey = horizontal ? "ArrowRight" : "ArrowDown";
    const currentIndex = state.rails[edge].indexOf(id);
    let nextIndex: number | undefined;
    if (event.key === previousKey) nextIndex = currentIndex - 1;
    else if (event.key === nextKey) nextIndex = currentIndex + 1;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = state.rails[edge].length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    dispatch({ type: "dock", id, target: { edge, index: nextIndex }, open });
    focusRailTab(id);
  };

  return (
    <button
      type="button"
      className="map-window-rail__tab"
      data-map-window-id={id}
      data-dragging={dragPreview?.id === id || undefined}
      data-open={open || undefined}
      aria-controls={`map-window-${id}`}
      aria-expanded={open}
      title={`${layout.title}. Drag to move; use arrow keys to reorder or Alt plus an arrow to change edges.`}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        dispatch({ type: "toggle-popout", id });
      }}
      onKeyDown={moveWithKeyboard}
      onPointerDown={startDrag}
      onLostPointerCapture={() => {
        if (!pointer.current) return;
        pointer.current = undefined;
        stopListeningRef.current?.();
        setDragPreview();
      }}
    >
      <span className="map-window-rail__grip" aria-hidden="true" />
      <span>{layout.title}</span>
    </button>
  );
}

function railLengthsWithout(state: MapWindowWorkspaceState, id: string): Record<MapWindowEdge, number> {
  return {
    top: state.rails.top.filter((candidate) => candidate !== id).length,
    right: state.rails.right.filter((candidate) => candidate !== id).length,
    bottom: state.rails.bottom.filter((candidate) => candidate !== id).length,
    left: state.rails.left.filter((candidate) => candidate !== id).length
  };
}

function floatingPositionAt(clientX: number, clientY: number, workspace: HTMLDivElement | null) {
  const bounds = workspace?.getBoundingClientRect();
  if (!bounds || !workspace) return { left: 10, top: 54 };
  return {
    left: clamp(clientX - bounds.left - 20, 0, Math.max(0, workspace.clientWidth - 360)),
    top: clamp(clientY - bounds.top - 16, 0, Math.max(0, workspace.clientHeight - 180))
  };
}

function focusRailTab(id: string) {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-map-window-id="${id}"]`)?.focus());
}

function focusMapWindow(id: string) {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`#map-window-${id} .map-window__move`)?.focus());
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
