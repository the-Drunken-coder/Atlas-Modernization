import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef
} from "react";
import { IconButton } from "../../primitives/controls.js";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  CollapseIcon,
  DragHandleVerticalIcon
} from "../../primitives/icons.js";
import { useMapWindowWorkspace } from "./MapWindowWorkspace.js";
import {
  dockTargetAtPoint,
  edgeForArrow,
  type MapWindowDockTarget,
  type MapWindowEdge,
  type MapWindowLayout,
  type MapWindowPosition,
  type MapWindowWorkspaceState
} from "./map-window-workspace-state.js";

type DragState = MapWindowPosition & {
  pointerId: number;
  clientX: number;
  clientY: number;
  moved: boolean;
  wasDocked: boolean;
};

type MapWindowStyle = CSSProperties & { "--map-window-offset"?: string };

/** A workspace-owned window with one interface for movement, docking, collapse, and dismissal. */
export function MapWindow({
  id,
  title,
  meta,
  footer,
  children,
  onClose
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  onClose(): void;
}) {
  const { state, dispatch, workspaceRef, setDragPreview } = useMapWindowWorkspace();
  const windowRef = useRef<HTMLElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const stopListeningRef = useRef<(() => void) | undefined>(undefined);
  const layout: MapWindowLayout = state.windows[id] ?? {
    id,
    title,
    placement: "floating",
    collapsed: false,
    cascade: Object.keys(state.windows).length % 6,
    zIndex: 32
  };
  const docked = layout.placement === "docked" && Boolean(layout.edge);
  const visible = !docked || state.openByEdge[layout.edge as MapWindowEdge] === id;

  useEffect(() => dispatch({ type: "register", id, title }), [dispatch, id, title]);
  useEffect(() => () => dispatch({ type: "unregister", id }), [dispatch, id]);
  useEffect(
    () => () => {
      if (!dragRef.current) return;
      stopListeningRef.current?.();
      setDragPreview();
    },
    [setDragPreview]
  );

  useEffect(() => {
    const element = windowRef.current;
    const parent = workspaceRef.current;
    if (!element || !parent || docked || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      const current = state.windows[id]?.position;
      if (!current) return;
      const next = clampPosition(current.left, current.top, parent, element);
      if (next.left !== current.left || next.top !== current.top) dispatch({ type: "position", id, position: next });
    });
    observer.observe(parent);
    observer.observe(element);
    return () => observer.disconnect();
  }, [dispatch, docked, id, state.windows, workspaceRef]);

  const moveTo = useCallback(
    (left: number, top: number) => {
      const element = windowRef.current;
      const parent = workspaceRef.current;
      if (!element || !parent) return;
      dispatch({ type: "position", id, position: clampPosition(left, top, parent, element) });
    },
    [dispatch, id, workspaceRef]
  );

  const currentPosition = useCallback((): MapWindowPosition | undefined => {
    const element = windowRef.current;
    const parent = workspaceRef.current;
    if (!element || !parent) return undefined;
    const elementRect = element.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    return { left: elementRect.left - parentRect.left, top: elementRect.top - parentRect.top };
  }, [workspaceRef]);

  const targetAt = (clientX: number, clientY: number): MapWindowDockTarget | undefined => {
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (!bounds) return undefined;
    return dockTargetAtPoint({ x: clientX, y: clientY }, bounds, railLengthsWithout(state, id));
  };

  const startMove = (event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button:not([data-map-window-move])")) return;
    const current = currentPosition();
    if (!current) return;
    dragRef.current = {
      ...current,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
      wasDocked: docked
    };
    const moveHandle = event.currentTarget;
    moveHandle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== moveEvent.pointerId) return;
      if (!drag.moved && Math.hypot(moveEvent.clientX - drag.clientX, moveEvent.clientY - drag.clientY) < 4) return;
      if (!drag.moved && drag.wasDocked) {
        dispatch({ type: "float", id, position: { left: drag.left, top: drag.top } });
      }
      drag.moved = true;
      moveTo(drag.left + moveEvent.clientX - drag.clientX, drag.top + moveEvent.clientY - drag.clientY);
      setDragPreview({ id, target: targetAt(moveEvent.clientX, moveEvent.clientY) });
    };
    const finish = (finishEvent: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== finishEvent.pointerId) return;
      dragRef.current = undefined;
      stopListeningRef.current?.();
      if (moveHandle.hasPointerCapture?.(finishEvent.pointerId)) {
        moveHandle.releasePointerCapture(finishEvent.pointerId);
      }
      if (finishEvent.type === "pointerup" && drag.moved) {
        const dockTarget = targetAt(finishEvent.clientX, finishEvent.clientY);
        if (dockTarget) dispatch({ type: "dock", id, target: dockTarget });
      }
      setDragPreview();
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    stopListeningRef.current = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      stopListeningRef.current = undefined;
    };
  };

  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    const requestedEdge = edgeForArrow(event.key);
    if (event.altKey && requestedEdge) {
      event.preventDefault();
      dispatch({ type: "dock", id, target: { edge: requestedEdge, index: state.rails[requestedEdge].length } });
      return;
    }
    if (docked && layout.edge) {
      const horizontal = layout.edge === "top" || layout.edge === "bottom";
      const previousKey = horizontal ? "ArrowLeft" : "ArrowUp";
      const nextKey = horizontal ? "ArrowRight" : "ArrowDown";
      const currentIndex = state.rails[layout.edge].indexOf(id);
      let nextIndex: number | undefined;
      if (event.key === previousKey) nextIndex = currentIndex - 1;
      else if (event.key === nextKey) nextIndex = currentIndex + 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      dispatch({ type: "dock", id, target: { edge: layout.edge, index: nextIndex } });
      return;
    }
    const current = currentPosition();
    if (!current) return;
    const distance = event.shiftKey ? 24 : 8;
    let next: MapWindowPosition;
    if (event.key === "ArrowLeft") next = { ...current, left: current.left - distance };
    else if (event.key === "ArrowRight") next = { ...current, left: current.left + distance };
    else if (event.key === "ArrowUp") next = { ...current, top: current.top - distance };
    else if (event.key === "ArrowDown") next = { ...current, top: current.top + distance };
    else return;
    event.preventDefault();
    moveTo(next.left, next.top);
  };

  const returnToRail = () => {
    if (!layout.edge) return;
    dispatch({ type: "close-popout", edge: layout.edge });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-map-window-id="${id}"]`)?.focus());
  };

  if (!visible) return null;

  const style: MapWindowStyle =
    layout.placement === "docked"
      ? { zIndex: layout.zIndex }
      : layout.position
        ? {
            right: "auto",
            bottom: "auto",
            left: layout.position.left,
            top: layout.position.top,
            zIndex: layout.zIndex
          }
        : { "--map-window-offset": `${layout.cascade * 22}px`, zIndex: layout.zIndex };

  return (
    <aside
      id={`map-window-${id}`}
      ref={windowRef}
      className="map-window"
      aria-label={title}
      data-collapsed={layout.collapsed || undefined}
      data-placement={layout.placement}
      data-edge={layout.edge}
      data-map-window
      data-map-interaction-control
      style={style}
      onPointerDown={() => dispatch({ type: "activate", id })}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !docked) return;
        event.preventDefault();
        event.stopPropagation();
        returnToRail();
      }}
    >
      <header
        className="map-window__bar"
        onPointerDown={startMove}
        onLostPointerCapture={() => {
          if (!dragRef.current) return;
          dragRef.current = undefined;
          stopListeningRef.current?.();
          setDragPreview();
        }}
      >
        <IconButton
          className="map-window__move"
          label={`Move ${title} window. Use arrow keys; use Alt plus an arrow to dock.`}
          data-map-window-move
          onKeyDown={moveWithKeyboard}
        >
          <DragHandleVerticalIcon size={14} />
        </IconButton>
        <span className="map-window__title">{title}</span>
        {meta ? <span className="map-window__meta">{meta}</span> : null}
        <IconButton
          className="map-window__collapse"
          label={
            docked
              ? `Return ${title} window to ${layout.edge} rail`
              : `${layout.collapsed ? "Expand" : "Collapse"} ${title} window`
          }
          aria-expanded={docked ? true : !layout.collapsed}
          onClick={docked ? returnToRail : () => dispatch({ type: "toggle-collapse", id })}
        >
          {docked && layout.edge ? (
            <DockCollapseIcon edge={layout.edge} />
          ) : layout.collapsed ? (
            <ChevronDownIcon size={14} />
          ) : (
            <ChevronUpIcon size={14} />
          )}
        </IconButton>
        <IconButton className="map-window__close" label={`Close ${title} window`} onClick={onClose}>
          <CloseIcon size={14} />
        </IconButton>
      </header>
      <div className="map-window__body" hidden={layout.collapsed}>
        {children}
      </div>
      {footer ? <footer className="map-window__footer">{footer}</footer> : null}
    </aside>
  );
}

function DockCollapseIcon({ edge }: { edge: MapWindowEdge }) {
  if (edge === "top") return <ChevronUpIcon size={14} />;
  if (edge === "right") return <ChevronRightIcon size={14} />;
  if (edge === "bottom") return <ChevronDownIcon size={14} />;
  return <CollapseIcon size={14} />;
}

function railLengthsWithout(state: MapWindowWorkspaceState, id: string): Record<MapWindowEdge, number> {
  return {
    top: state.rails.top.filter((candidate) => candidate !== id).length,
    right: state.rails.right.filter((candidate) => candidate !== id).length,
    bottom: state.rails.bottom.filter((candidate) => candidate !== id).length,
    left: state.rails.left.filter((candidate) => candidate !== id).length
  };
}

function clampPosition(left: number, top: number, parent: HTMLElement, element: HTMLElement): MapWindowPosition {
  return {
    left: clamp(left, 0, Math.max(0, parent.clientWidth - element.offsetWidth)),
    top: clamp(top, 0, Math.max(0, parent.clientHeight - element.offsetHeight))
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
