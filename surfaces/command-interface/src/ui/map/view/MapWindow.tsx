import { type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "../../primitives/controls.js";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, DragHandleVerticalIcon } from "../../primitives/icons.js";

type Position = { left: number; top: number };
type DragState = Position & { pointerId: number; clientX: number; clientY: number };

/** A map-owned window with one interface for movement, collapse, and dismissal. */
export function MapWindow({
  title,
  meta,
  footer,
  children,
  onClose
}: {
  title: string;
  meta?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  onClose(): void;
}) {
  const windowRef = useRef<HTMLElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const [position, setPosition] = useState<Position>();
  const [collapsed, setCollapsed] = useState(false);
  const [docked, setDocked] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 720px)");
    const update = () => {
      setDocked(query.matches);
      if (query.matches) setPosition(undefined);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const moveTo = useCallback((left: number, top: number) => {
    const element = windowRef.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const maxLeft = Math.max(0, parent.clientWidth - element.offsetWidth);
    const maxTop = Math.max(0, parent.clientHeight - element.offsetHeight);
    setPosition({ left: clamp(left, 0, maxLeft), top: clamp(top, 0, maxTop) });
  }, []);

  const currentPosition = useCallback((): Position | undefined => {
    const element = windowRef.current;
    const parent = element?.parentElement;
    if (!element || !parent) return undefined;
    const elementRect = element.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    return { left: elementRect.left - parentRect.left, top: elementRect.top - parentRect.top };
  }, []);

  const startMove = (event: PointerEvent<HTMLElement>) => {
    if (docked) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button:not([data-map-window-move])")) return;
    const current = currentPosition();
    if (!current) return;
    dragRef.current = {
      ...current,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const continueMove = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    moveTo(drag.left + event.clientX - drag.clientX, drag.top + event.clientY - drag.clientY);
  };

  const finishMove = (event: PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (docked) return;
    const current = currentPosition();
    if (!current) return;
    const distance = event.shiftKey ? 24 : 8;
    let next = current;
    if (event.key === "ArrowLeft") next = { ...current, left: current.left - distance };
    else if (event.key === "ArrowRight") next = { ...current, left: current.left + distance };
    else if (event.key === "ArrowUp") next = { ...current, top: current.top - distance };
    else if (event.key === "ArrowDown") next = { ...current, top: current.top + distance };
    else return;
    event.preventDefault();
    moveTo(next.left, next.top);
  };

  return (
    <aside
      ref={windowRef}
      className="map-window"
      aria-label={title}
      data-collapsed={collapsed || undefined}
      data-docked={docked || undefined}
      data-map-interaction-control
      style={position ? { left: position.left, top: position.top, right: "auto" } : undefined}
    >
      <header
        className="map-window__bar"
        onPointerDown={startMove}
        onPointerMove={continueMove}
        onPointerUp={finishMove}
        onPointerCancel={finishMove}
      >
        <IconButton
          className="map-window__move"
          label={`Move ${title} window. Use arrow keys.`}
          data-map-window-move
          disabled={docked}
          onKeyDown={moveWithKeyboard}
        >
          <DragHandleVerticalIcon size={14} />
        </IconButton>
        <span className="map-window__title">{title}</span>
        {meta ? <span className="map-window__meta">{meta}</span> : null}
        <IconButton
          className="map-window__collapse"
          label={`${collapsed ? "Expand" : "Collapse"} ${title} window`}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed ? <ChevronDownIcon size={14} /> : <ChevronUpIcon size={14} />}
        </IconButton>
        <IconButton className="map-window__close" label={`Close ${title} window`} onClick={onClose}>
          <CloseIcon size={14} />
        </IconButton>
      </header>
      <div className="map-window__body" hidden={collapsed}>
        {children}
      </div>
      {footer ? <footer className="map-window__footer">{footer}</footer> : null}
    </aside>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
