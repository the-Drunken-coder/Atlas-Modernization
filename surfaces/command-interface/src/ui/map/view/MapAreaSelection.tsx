import type { MapArea } from "@the-drunken-coder/atlas-sdk";
import type { Map as MlMap } from "maplibre-gl";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState
} from "react";
import { MapRegionSelection, type RegionTransform, type ScreenRect } from "./MapRegionSelection.js";
import {
  clampMovedRect,
  clampResizedRect,
  DATE_LINE_CROSSING_MESSAGE,
  keyboardDelta,
  MIN_REGION_SIZE,
  pointInCanvas,
  projectedScreenRect,
  rectFromPoints,
  regionFromMapBounds,
  regionFromScreenRect,
  type ScreenPoint,
  screenRectsEqual,
  visibleScreenRect
} from "./map-region-geometry.js";

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
  onViewportArea(area: MapArea | null): void;
  suppressNextClick(): void;
};

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
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const rectRef = useRef(rect);
  const callbacksRef = useRef({ onAreaChange, onDrawingComplete, onCancelDrawing, onViewportArea });
  rectRef.current = rect;
  callbacksRef.current = { onAreaChange, onDrawingComplete, onCancelDrawing, onViewportArea };

  useEffect(() => {
    if (!map || !mapCanvas || !mapReady) return;
    const publishViewport = () => {
      const viewportArea = regionFromMapBounds(map);
      if (!viewportArea) {
        callbacksRef.current.onViewportArea(null);
        return;
      }
      callbacksRef.current.onViewportArea(viewportArea);
    };
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
      setSelectionError(null);
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
      setSelectionError(null);
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
      const nextArea = regionFromScreenRect(map, next);
      if (!nextArea) {
        setSelectionError(DATE_LINE_CROSSING_MESSAGE);
        return;
      }
      callbacksRef.current.onAreaChange(nextArea);
      setSelectionError(null);
    };
    const finishDrag = (event: globalThis.PointerEvent) => {
      if (drag.pointerId === null || event.pointerId !== drag.pointerId) return;
      if (drag.kind === "draw" && drag.start) {
        const next = rectFromPoints(drag.start, pointInCanvas(event, mapCanvas));
        if (next.width >= MIN_REGION_SIZE && next.height >= MIN_REGION_SIZE) {
          const nextArea = regionFromScreenRect(map, next);
          if (!nextArea) {
            setSelectionError(DATE_LINE_CROSSING_MESSAGE);
            if (event.target instanceof Node && mapCanvas.contains(event.target)) suppressNextClick();
            setDrag({ kind: "draw", start: null, current: null, pointerId: null });
            return;
          } else {
            callbacksRef.current.onAreaChange(nextArea);
            callbacksRef.current.onDrawingComplete();
            setSelectionError(null);
          }
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
      setSelectionError(null);
      setDrag(null);
    };
    const cancelKeyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (drag.kind === "transform") callbacksRef.current.onAreaChange(drag.initialArea);
      else callbacksRef.current.onCancelDrawing();
      setSelectionError(null);
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
    setSelectionError(null);
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
    const nextArea = regionFromScreenRect(map, next);
    if (!nextArea) {
      setSelectionError(DATE_LINE_CROSSING_MESSAGE);
      return;
    }
    callbacksRef.current.onAreaChange(nextArea);
    setSelectionError(null);
  };

  const drawingRect =
    drag?.kind === "draw" && drag.start && drag.current ? rectFromPoints(drag.start, drag.current) : null;
  return (
    <>
      <MapRegionSelection
        rect={rect}
        drawing={drawing}
        drawingRect={drawingRect}
        drawingPrompt={selectionError ?? "Drag an area. Press Escape to cancel."}
        label="selected area"
        testId="map-area-selection"
        viewport={mapCanvas?.getBoundingClientRect()}
        tinted
        onPointerDown={beginTransform}
        onKeyDown={transformWithKeyboard}
      />
      {selectionError && !drawing ? (
        <p className="map-region-selection__status" role="status">
          {selectionError}
        </p>
      ) : null}
    </>
  );
}
