import type { MapArea } from "@the-drunken-coder/atlas-sdk";
import type { Map as MlMap } from "maplibre-gl";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState
} from "react";
import { MapRegionSelection, type RegionTransform, type ResizeAxes, type ScreenRect } from "./MapRegionSelection.js";

type ScreenPoint = { x: number; y: number };
type DragState =
  | { kind: "draw"; start: ScreenPoint | null; current: ScreenPoint | null; pointerId: number | null }
  | {
      kind: "transform";
      transform: RegionTransform;
      start: ScreenPoint;
      pointerId: number;
      initialRect: ScreenRect;
      initialArea: MapArea;
    };

type MapAreaSelectionProps = {
  mapCanvas: HTMLDivElement | null;
  map: MlMap | undefined;
  mapReady: boolean;
  area: MapArea | null;
  drawing: boolean;
  onAreaChange(area: MapArea): void;
  onDrawingComplete(): void;
  onCancelDrawing(): void;
  onViewportArea(area: MapArea): void;
  suppressNextClick(): void;
};

const MIN_AREA_SIZE = 32;

export function MapAreaSelection({
  mapCanvas,
  map,
  mapReady,
  area,
  drawing,
  onAreaChange,
  onDrawingComplete,
  onCancelDrawing,
  onViewportArea,
  suppressNextClick
}: MapAreaSelectionProps) {
  const [rect, setRect] = useState<ScreenRect | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const rectRef = useRef(rect);
  const callbacksRef = useRef({ onAreaChange, onDrawingComplete, onCancelDrawing, onViewportArea });
  rectRef.current = rect;
  callbacksRef.current = { onAreaChange, onDrawingComplete, onCancelDrawing, onViewportArea };

  useEffect(() => {
    if (!map || !mapCanvas || !mapReady) return;
    const publishViewport = () => callbacksRef.current.onViewportArea(areaFromBounds(map));
    publishViewport();
    map.on("moveend", publishViewport);
    map.on("resize", publishViewport);
    return () => {
      map.off("moveend", publishViewport);
      map.off("resize", publishViewport);
    };
  }, [map, mapCanvas, mapReady]);

  useEffect(() => {
    if (!map || !mapCanvas || !mapReady || !area) {
      setRect(null);
      return;
    }
    const sync = () => {
      const bounds = mapCanvas.getBoundingClientRect();
      const next = visibleScreenRect(map, area, bounds.width, bounds.height);
      if (!screenRectsEqual(rectRef.current, next)) setRect(next);
    };
    sync();
    map.on("move", sync);
    map.on("zoom", sync);
    map.on("resize", sync);
    return () => {
      map.off("move", sync);
      map.off("zoom", sync);
      map.off("resize", sync);
    };
  }, [area, map, mapCanvas, mapReady]);

  useEffect(() => {
    if (!drawing) {
      setDrag((current) => (current?.kind === "draw" ? null : current));
      return;
    }
    setDrag((current) =>
      current?.kind === "draw" ? current : { kind: "draw", start: null, current: null, pointerId: null }
    );
  }, [drawing]);

  useEffect(() => {
    if (!map || !mapCanvas || !drag) return;
    const startDrag = (event: globalThis.PointerEvent) => {
      if (drag.kind !== "draw" || drag.start || event.button !== 0 || event.shiftKey) return;
      if (
        event.target instanceof Element &&
        event.target.closest(".maplibregl-control-container, [data-map-interaction-control]")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      map.stop();
      mapCanvas.setPointerCapture?.(event.pointerId);
      const point = pointInCanvas(event, mapCanvas);
      setDrag({ kind: "draw", start: point, current: point, pointerId: event.pointerId });
    };
    const updateDrag = (event: globalThis.PointerEvent) => {
      if (drag.pointerId === null || event.pointerId !== drag.pointerId) return;
      const point = pointInCanvas(event, mapCanvas);
      if (drag.kind === "draw") {
        if (drag.start) setDrag({ ...drag, current: point });
        return;
      }
      const delta = { x: point.x - drag.start.x, y: point.y - drag.start.y };
      const next =
        drag.transform === "move"
          ? clampMovedRect(drag.initialRect, delta, mapCanvas.getBoundingClientRect())
          : clampResizedRect(drag.initialRect, delta, drag.transform);
      callbacksRef.current.onAreaChange(areaFromScreenRect(map, next));
    };
    const finishDrag = (event: globalThis.PointerEvent) => {
      if (drag.pointerId === null || event.pointerId !== drag.pointerId) return;
      if (drag.kind === "draw" && drag.start) {
        const next = rectFromPoints(drag.start, pointInCanvas(event, mapCanvas));
        if (next.width >= MIN_AREA_SIZE && next.height >= MIN_AREA_SIZE) {
          callbacksRef.current.onAreaChange(areaFromScreenRect(map, next));
          callbacksRef.current.onDrawingComplete();
        } else {
          callbacksRef.current.onCancelDrawing();
        }
      }
      if (event.target instanceof Node && mapCanvas.contains(event.target)) suppressNextClick();
      setDrag(null);
    };
    const cancelPointer = (event: globalThis.PointerEvent) => {
      if (drag.pointerId === null || event.pointerId !== drag.pointerId) return;
      if (drag.kind === "transform") callbacksRef.current.onAreaChange(drag.initialArea);
      else callbacksRef.current.onCancelDrawing();
      setDrag(null);
    };
    const cancelKeyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (drag.kind === "transform") callbacksRef.current.onAreaChange(drag.initialArea);
      else callbacksRef.current.onCancelDrawing();
      setDrag(null);
    };

    mapCanvas.classList.toggle("map-canvas--region-drawing", drag.kind === "draw");
    mapCanvas.addEventListener("pointerdown", startDrag, { capture: true });
    window.addEventListener("pointermove", updateDrag);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("keydown", cancelKeyboard, { capture: true });
    return () => {
      mapCanvas.classList.remove("map-canvas--region-drawing");
      mapCanvas.removeEventListener("pointerdown", startDrag, { capture: true });
      window.removeEventListener("pointermove", updateDrag);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("keydown", cancelKeyboard, { capture: true });
    };
  }, [drag, map, mapCanvas, suppressNextClick]);

  const beginTransform = (transform: RegionTransform, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !map || !mapCanvas || !area || !rect) return;
    event.preventDefault();
    event.stopPropagation();
    map.stop();
    mapCanvas.setPointerCapture?.(event.pointerId);
    setDrag({
      kind: "transform",
      transform,
      start: pointInCanvas(event, mapCanvas),
      pointerId: event.pointerId,
      initialRect: projectedScreenRect(map, area),
      initialArea: area
    });
  };

  const transformWithKeyboard = (transform: RegionTransform, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!map || !mapCanvas || !area) return;
    const delta = keyboardDelta(event.key, event.shiftKey ? 40 : 10, transform === "move" ? "both" : transform);
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const initial = projectedScreenRect(map, area);
    const next =
      transform === "move"
        ? clampMovedRect(initial, delta, mapCanvas.getBoundingClientRect())
        : clampResizedRect(initial, delta, transform);
    callbacksRef.current.onAreaChange(areaFromScreenRect(map, next));
  };

  const drawingRect =
    drag?.kind === "draw" && drag.start && drag.current ? rectFromPoints(drag.start, drag.current) : null;
  return (
    <MapRegionSelection
      rect={rect}
      drawing={drawing}
      drawingRect={drawingRect}
      drawingPrompt="Drag an area. Press Escape to cancel."
      label="selected area"
      testId="map-area-selection"
      viewport={mapCanvas?.getBoundingClientRect()}
      tinted
      onPointerDown={beginTransform}
      onKeyDown={transformWithKeyboard}
    />
  );
}

function areaFromBounds(map: MlMap): MapArea {
  const bounds = map.getBounds();
  return { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() };
}

function pointInCanvas(event: Pick<globalThis.MouseEvent, "clientX" | "clientY">, canvas: HTMLDivElement): ScreenPoint {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
    y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top))
  };
}

function rectFromPoints(first: ScreenPoint, second: ScreenPoint): ScreenRect {
  return {
    left: Math.min(first.x, second.x),
    top: Math.min(first.y, second.y),
    width: Math.abs(first.x - second.x),
    height: Math.abs(first.y - second.y)
  };
}

function areaFromScreenRect(map: MlMap, rect: ScreenRect): MapArea {
  const first = map.unproject([rect.left, rect.top]);
  const second = map.unproject([rect.left + rect.width, rect.top + rect.height]);
  return {
    west: Math.min(first.lng, second.lng),
    south: Math.min(first.lat, second.lat),
    east: Math.max(first.lng, second.lng),
    north: Math.max(first.lat, second.lat)
  };
}

function visibleScreenRect(
  map: MlMap,
  area: MapArea,
  viewportWidth: number,
  viewportHeight: number
): ScreenRect | null {
  const rect = projectedScreenRect(map, area);
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewportWidth, rect.left + rect.width);
  const bottom = Math.min(viewportHeight, rect.top + rect.height);
  if (right - left < 2 || bottom - top < 2) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function projectedScreenRect(map: MlMap, area: MapArea): ScreenRect {
  const points = [
    map.project([area.west, area.north]),
    map.project([area.east, area.north]),
    map.project([area.east, area.south]),
    map.project([area.west, area.south])
  ];
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  return { left, top, width: right - left, height: bottom - top };
}

function clampMovedRect(rect: ScreenRect, delta: ScreenPoint, viewport: DOMRect): ScreenRect {
  const visibleWidth = Math.min(MIN_AREA_SIZE, rect.width);
  const visibleHeight = Math.min(MIN_AREA_SIZE, rect.height);
  return {
    ...rect,
    left: Math.max(visibleWidth - rect.width, Math.min(viewport.width - visibleWidth, rect.left + delta.x)),
    top: Math.max(visibleHeight - rect.height, Math.min(viewport.height - visibleHeight, rect.top + delta.y))
  };
}

function clampResizedRect(rect: ScreenRect, delta: ScreenPoint, axes: ResizeAxes): ScreenRect {
  return {
    ...rect,
    width: axes === "height" ? rect.width : Math.max(MIN_AREA_SIZE, rect.width + delta.x),
    height: axes === "width" ? rect.height : Math.max(MIN_AREA_SIZE, rect.height + delta.y)
  };
}

function keyboardDelta(key: string, step: number, axes: ResizeAxes): ScreenPoint | null {
  if (axes !== "height" && key === "ArrowLeft") return { x: -step, y: 0 };
  if (axes !== "height" && key === "ArrowRight") return { x: step, y: 0 };
  if (axes !== "width" && key === "ArrowUp") return { x: 0, y: -step };
  if (axes !== "width" && key === "ArrowDown") return { x: 0, y: step };
  return null;
}

function screenRectsEqual(first: ScreenRect | null, second: ScreenRect | null): boolean {
  if (first === second) return true;
  if (!first || !second) return false;
  return (
    Math.abs(first.left - second.left) < 0.5 &&
    Math.abs(first.top - second.top) < 0.5 &&
    Math.abs(first.width - second.width) < 0.5 &&
    Math.abs(first.height - second.height) < 0.5
  );
}
