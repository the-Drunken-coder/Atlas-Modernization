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
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, DragHandleVerticalIcon } from "../../primitives/icons.js";
import { useMapWindowWorkspace } from "./MapWindowWorkspace.js";
import {
  dockTargetAtPoint,
  edgeForArrow,
  type MapWindowDockTarget,
  type MapWindowEdge,
  type MapWindowLayout,
  type MapWindowPosition
} from "./map-window-workspace-state.js";

const DOCK_DETACH_DISTANCE = 40;

type DragState = MapWindowPosition & {
  pointerId: number;
  clientX: number;
  clientY: number;
  moved: boolean;
  dockedEdge?: MapWindowEdge;
  dockOffset: number;
  detached: boolean;
};

type MapWindowStyle = CSSProperties & { "--map-window-offset"?: string };
type MapWindowHandleStatus = "loading" | "error";

/** A workspace-owned window with one interface for movement, edge attachment, collapse, and dismissal. */
export function MapWindow({
  id,
  title,
  meta,
  footer,
  handleIcon,
  handleBadge,
  handleStatus,
  children,
  onClose
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  footer?: ReactNode;
  handleIcon?: ReactNode;
  handleBadge?: ReactNode;
  handleStatus?: MapWindowHandleStatus;
  children: ReactNode;
  onClose(): void;
}) {
  const { state, dispatch, workspaceRef, setDragPreview } = useMapWindowWorkspace();
  const windowRef = useRef<HTMLElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const suppressExpandRef = useRef(false);
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
    if (!element || !parent || typeof ResizeObserver !== "function") return;
    const keepReachable = () => {
      const current = state.windows[id];
      if (!current) return;
      if (current.placement === "docked" && current.edge) {
        const next = clampDockOffset(current.edge, current.dockOffset ?? 0.5, parent, element);
        if (next !== current.dockOffset) dispatch({ type: "dock-position", id, offset: next });
        return;
      }
      if (!current.position) return;
      const next = clampPosition(current.position.left, current.position.top, parent, element);
      if (next.left !== current.position.left || next.top !== current.position.top) {
        dispatch({ type: "position", id, position: next });
      }
    };
    const observer = new ResizeObserver(keepReachable);
    observer.observe(parent);
    observer.observe(element);
    keepReachable();
    return () => observer.disconnect();
  }, [dispatch, id, state.windows, workspaceRef]);

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
    return dockTargetAtPoint({ x: clientX, y: clientY }, bounds);
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
      dockedEdge: docked ? layout.edge : undefined,
      dockOffset: layout.dockOffset ?? 0.5,
      detached: false
    };
    const moveHandle = event.currentTarget;
    moveHandle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== moveEvent.pointerId) return;
      const deltaX = moveEvent.clientX - drag.clientX;
      const deltaY = moveEvent.clientY - drag.clientY;
      if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
      drag.moved = true;

      const element = windowRef.current;
      const parent = workspaceRef.current;
      if (drag.dockedEdge && !drag.detached && element && parent) {
        const horizontal = isHorizontalEdge(drag.dockedEdge);
        const perpendicularDistance = Math.abs(horizontal ? deltaY : deltaX);
        if (perpendicularDistance <= DOCK_DETACH_DISTANCE) {
          const axisLength = horizontal ? parent.clientWidth : parent.clientHeight;
          const parallelDistance = horizontal ? deltaX : deltaY;
          const offset = clampDockOffset(
            drag.dockedEdge,
            drag.dockOffset + parallelDistance / Math.max(1, axisLength),
            parent,
            element
          );
          dispatch({ type: "dock-position", id, offset });
          setDragPreview({ id, target: { edge: drag.dockedEdge, offset } });
          return;
        }

        drag.detached = true;
        dispatch({
          type: "float",
          id,
          position: clampPosition(drag.left + deltaX, drag.top + deltaY, parent, element)
        });
        setDragPreview({ id, target: targetAt(moveEvent.clientX, moveEvent.clientY) });
        return;
      }

      moveTo(drag.left + deltaX, drag.top + deltaY);
      setDragPreview({ id, target: targetAt(moveEvent.clientX, moveEvent.clientY) });
    };
    const finish = (finishEvent: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== finishEvent.pointerId) return;
      dragRef.current = undefined;
      if (layout.collapsed) suppressExpandRef.current = drag.moved && !drag.detached;
      stopListeningRef.current?.();
      if (moveHandle.hasPointerCapture?.(finishEvent.pointerId)) {
        moveHandle.releasePointerCapture(finishEvent.pointerId);
      }
      const stayedDocked = Boolean(drag.dockedEdge && !drag.detached);
      if (finishEvent.type === "pointerup" && drag.moved && !stayedDocked) {
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

  const stopMoveOnLostPointerCapture = () => {
    if (!dragRef.current) return;
    dragRef.current = undefined;
    stopListeningRef.current?.();
    setDragPreview();
  };

  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    const requestedEdge = edgeForArrow(event.key);
    if (event.altKey && requestedEdge) {
      event.preventDefault();
      dispatch({
        type: "dock",
        id,
        collapsed: layout.collapsed,
        target: {
          edge: requestedEdge,
          offset:
            layout.placement === "docked"
              ? (layout.dockOffset ?? 0.5)
              : dockOffsetAtCurrentPosition(requestedEdge, workspaceRef.current, windowRef.current)
        }
      });
      return;
    }

    if (docked && layout.edge) {
      const horizontal = isHorizontalEdge(layout.edge);
      const previousKey = horizontal ? "ArrowLeft" : "ArrowUp";
      const nextKey = horizontal ? "ArrowRight" : "ArrowDown";
      const parent = workspaceRef.current;
      const element = windowRef.current;
      if (!parent || !element) return;
      let nextOffset: number | undefined;
      if (event.key === "Home") nextOffset = clampDockOffset(layout.edge, 0, parent, element);
      else if (event.key === "End") nextOffset = clampDockOffset(layout.edge, 1, parent, element);
      else if (event.key === previousKey || event.key === nextKey) {
        const axisLength = horizontal ? parent.clientWidth : parent.clientHeight;
        const distance = event.shiftKey ? 24 : 8;
        const direction = event.key === previousKey ? -1 : 1;
        nextOffset = clampDockOffset(
          layout.edge,
          (layout.dockOffset ?? 0.5) + (direction * distance) / Math.max(1, axisLength),
          parent,
          element
        );
      }
      if (nextOffset === undefined) return;
      event.preventDefault();
      dispatch({ type: "dock-position", id, offset: nextOffset });
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

  const style: MapWindowStyle =
    layout.placement === "docked" && layout.edge
      ? dockedWindowStyle(layout.edge, layout.dockOffset ?? 0.5, layout.zIndex)
      : layout.position
        ? {
            right: "auto",
            bottom: "auto",
            left: layout.position.left,
            top: layout.position.top,
            zIndex: layout.zIndex
          }
        : { "--map-window-offset": `${layout.cascade * 22}px`, zIndex: layout.zIndex };

  const toggleCollapse = () => {
    if (!layout.collapsed && !docked) {
      const target = nearestDockTargetAtCurrentPosition(workspaceRef.current, windowRef.current);
      if (target) dispatch({ type: "dock", id, target });
    }
    dispatch({ type: "toggle-collapse", id });
  };

  const handleMetaLabel = typeof meta === "string" || typeof meta === "number" ? `, ${meta}` : "";
  const handleLabel = `Expand ${title} window${handleMetaLabel}${
    handleStatus ? `, ${handleStatus}` : ""
  }. Use arrow keys to move; use Alt plus an arrow to change edges.`;
  const peekAlign = (layout.dockOffset ?? 0.5) < 0.28 ? "start" : (layout.dockOffset ?? 0.5) > 0.72 ? "end" : "center";

  return (
    <aside
      id={`map-window-${id}`}
      ref={windowRef}
      className={`map-window${layout.collapsed && docked ? " map-window--handle" : ""}`}
      aria-label={title}
      data-collapsed={layout.collapsed || undefined}
      data-placement={layout.placement}
      data-edge={layout.edge}
      data-dock-offset={layout.dockOffset}
      data-handle-status={handleStatus}
      data-peek-align={peekAlign}
      data-map-window
      data-map-interaction-control
      style={style}
      onPointerDown={() => dispatch({ type: "activate", id })}
    >
      {layout.collapsed && docked ? (
        <>
          <button
            type="button"
            className="map-window__pull"
            aria-label={handleLabel}
            title={handleLabel}
            data-map-window-move
            onClick={() => {
              if (suppressExpandRef.current) {
                suppressExpandRef.current = false;
                return;
              }
              dispatch({ type: "toggle-collapse", id });
            }}
            onKeyDown={moveWithKeyboard}
            onLostPointerCapture={stopMoveOnLostPointerCapture}
            onPointerDown={startMove}
          >
            <span className="map-window__pull-icon">{handleIcon ?? <DragHandleVerticalIcon size={15} />}</span>
            {handleBadge !== undefined ? <span className="map-window__pull-badge">{handleBadge}</span> : null}
          </button>
          <section className="map-window__peek" aria-label={`${title} collapsed window details`}>
            <div className="map-window__peek-heading">
              <span className="map-window__peek-title">{title}</span>
              {meta ? <span className="map-window__peek-meta">{meta}</span> : null}
              <IconButton className="map-window__peek-close" label={`Close ${title} window`} onClick={onClose}>
                <CloseIcon size={14} />
              </IconButton>
            </div>
            {footer ? <footer className="map-window__peek-footer">{footer}</footer> : null}
          </section>
        </>
      ) : (
        <>
          <header
            className="map-window__bar"
            onPointerDown={startMove}
            onLostPointerCapture={stopMoveOnLostPointerCapture}
          >
            <IconButton
              className="map-window__move"
              label={`Move ${title} window. Use arrow keys to move; use Alt plus an arrow to attach to an edge.`}
              data-map-window-move
              onKeyDown={moveWithKeyboard}
            >
              <DragHandleVerticalIcon size={14} />
            </IconButton>
            <span className="map-window__title">{title}</span>
            {meta ? <span className="map-window__meta">{meta}</span> : null}
            <IconButton
              className="map-window__collapse"
              label={`${layout.collapsed ? "Expand" : "Collapse"} ${title} window`}
              aria-expanded={!layout.collapsed}
              onClick={toggleCollapse}
            >
              {layout.collapsed ? <ChevronDownIcon size={14} /> : <ChevronUpIcon size={14} />}
            </IconButton>
            <IconButton className="map-window__close" label={`Close ${title} window`} onClick={onClose}>
              <CloseIcon size={14} />
            </IconButton>
          </header>
          <div className="map-window__body" hidden={layout.collapsed}>
            {children}
          </div>
          {footer ? <footer className="map-window__footer">{footer}</footer> : null}
        </>
      )}
    </aside>
  );
}

function dockedWindowStyle(edge: MapWindowEdge, offset: number, zIndex: number): MapWindowStyle {
  const position = `${offset * 100}%`;
  if (edge === "top") {
    return { top: 0, right: "auto", bottom: "auto", left: position, transform: "translateX(-50%)", zIndex };
  }
  if (edge === "right") {
    return { top: position, right: 0, bottom: "auto", left: "auto", transform: "translateY(-50%)", zIndex };
  }
  if (edge === "bottom") {
    return { top: "auto", right: "auto", bottom: 0, left: position, transform: "translateX(-50%)", zIndex };
  }
  return { top: position, right: "auto", bottom: "auto", left: 0, transform: "translateY(-50%)", zIndex };
}

function dockOffsetAtCurrentPosition(
  edge: MapWindowEdge,
  parent: HTMLElement | null,
  element: HTMLElement | null
): number {
  if (!parent || !element) return 0.5;
  const parentRect = parent.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  if (isHorizontalEdge(edge)) {
    return clamp((elementRect.left - parentRect.left + elementRect.width / 2) / Math.max(1, parentRect.width), 0, 1);
  }
  return clamp((elementRect.top - parentRect.top + elementRect.height / 2) / Math.max(1, parentRect.height), 0, 1);
}

function nearestDockTargetAtCurrentPosition(
  parent: HTMLElement | null,
  element: HTMLElement | null
): MapWindowDockTarget | undefined {
  if (!parent || !element) return undefined;
  const parentRect = parent.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const centerX = elementRect.left - parentRect.left + elementRect.width / 2;
  const centerY = elementRect.top - parentRect.top + elementRect.height / 2;
  const distances: Array<[MapWindowEdge, number]> = [
    ["top", centerY],
    ["right", parentRect.width - centerX],
    ["bottom", parentRect.height - centerY],
    ["left", centerX]
  ];
  const edge = distances.reduce((nearest, candidate) => (candidate[1] < nearest[1] ? candidate : nearest))[0];
  return {
    edge,
    offset: isHorizontalEdge(edge)
      ? clamp(centerX / Math.max(1, parentRect.width), 0, 1)
      : clamp(centerY / Math.max(1, parentRect.height), 0, 1)
  };
}

function clampDockOffset(edge: MapWindowEdge, offset: number, parent: HTMLElement, element: HTMLElement): number {
  const horizontal = isHorizontalEdge(edge);
  const axisLength = horizontal ? parent.clientWidth : parent.clientHeight;
  const windowLength = horizontal ? element.offsetWidth : element.offsetHeight;
  if (axisLength <= 0) return 0.5;
  const halfWindow = Math.min(0.5, windowLength / axisLength / 2);
  return clamp(offset, halfWindow, 1 - halfWindow);
}

function isHorizontalEdge(edge: MapWindowEdge): boolean {
  return edge === "top" || edge === "bottom";
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
