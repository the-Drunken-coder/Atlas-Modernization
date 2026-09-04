import type { MapArea } from "@the-drunken-coder/atlas-sdk";
import type { Map as MlMap } from "maplibre-gl";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { foregroundEscapeOwner } from "../interaction/foreground-escape-owner.js";
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
  onBeginRegionInteraction(): void;
  onViewportArea(area: MapArea | null): void;
  onBoxZoomActiveChange(active: boolean): void;
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
  onBeginRegionInteraction,
  onViewportArea,
  onBoxZoomActiveChange,
  suppressNextClick
}: MapAreaSelectionProps) {
  const [rect, setRect] = useState<ScreenRect | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const rectRef = useRef(rect);
  const dragRef = useRef<DragState | null>(drag);
  const boxZoomGestureRef = useRef(false);
  const onBoxZoomActiveChangeRef = useRef(onBoxZoomActiveChange);
  const onBeginRegionInteractionRef = useRef(onBeginRegionInteraction);
  const callbacksRef = useRef({ onAreaChange, onDrawingComplete, onCancelDrawing, onViewportArea });
  rectRef.current = rect;
  dragRef.current = drag;
  onBeginRegionInteractionRef.current = onBeginRegionInteraction;
  onBoxZoomActiveChangeRef.current = onBoxZoomActiveChange;
  callbacksRef.current = { onAreaChange, onDrawingComplete, onCancelDrawing, onViewportArea };

  const setBoxZoomActive = useCallback((active: boolean) => {
    boxZoomGestureRef.current = active;
    onBoxZoomActiveChangeRef.current(active);
  }, []);

  useEffect(() => {
    return () => {
      setBoxZoomActive(false);
      releasePointerCapture(mapCanvas, dragRef.current?.pointerId ?? null, suppressNextClick, true);
    };
  }, [mapCanvas, setBoxZoomActive, suppressNextClick]);

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
    if (!map) return;
    const markBoxZoomStarted = () => {
      setBoxZoomActive(true);
    };
    const markBoxZoomEnded = () => {
      setBoxZoomActive(false);
    };
    map.on("boxzoomstart", markBoxZoomStarted);
    map.on("boxzoomend", markBoxZoomEnded);
    map.on("boxzoomcancel", markBoxZoomEnded);
    return () => {
      setBoxZoomActive(false);
      map.off("boxzoomstart", markBoxZoomStarted);
      map.off("boxzoomend", markBoxZoomEnded);
      map.off("boxzoomcancel", markBoxZoomEnded);
    };
  }, [map, setBoxZoomActive]);

  useEffect(() => {
    const currentDrag = dragRef.current;
    if (!drawing) {
      setSelectionError(null);
      if (currentDrag?.kind === "draw") {
        releasePointerCapture(mapCanvas, currentDrag.pointerId, suppressNextClick, true);
        setDrag(null);
      }
      return;
    }
    onBeginRegionInteractionRef.current();
    if (currentDrag?.kind === "transform") {
      releasePointerCapture(mapCanvas, currentDrag.pointerId, suppressNextClick, true);
      callbacksRef.current.onAreaChange(currentDrag.initialArea);
    }
    setDrag((current) =>
      current?.kind === "draw" ? current : { kind: "draw", start: null, current: null, pointerId: null }
    );
  }, [drawing, mapCanvas, suppressNextClick]);

  useEffect(() => {
    if (!map || !mapCanvas || !drag) return;
    const startDrag = (event: globalThis.PointerEvent) => {
      if (drag.kind !== "draw" || drag.start || event.button !== 0) return;
      if (
        event.target instanceof Element &&
        event.target.closest(".maplibregl-control-container, [data-map-interaction-control]")
      )
        return;
      if (event.shiftKey) {
        setBoxZoomActive(true);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onBeginRegionInteraction();
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
      const suppressReleaseClick = event.target instanceof Node && mapCanvas.contains(event.target);
      releasePointerCapture(mapCanvas, drag.pointerId, suppressNextClick, suppressReleaseClick);
      if (drag.kind === "draw" && drag.start) {
        const next = rectFromPoints(drag.start, pointInCanvas(event, mapCanvas));
        if (next.width >= MIN_REGION_SIZE && next.height >= MIN_REGION_SIZE) {
          const nextArea = regionFromScreenRect(map, next);
          if (!nextArea) {
            setSelectionError(DATE_LINE_CROSSING_MESSAGE);
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
      setDrag(null);
    };
    const clearBoxZoomGesture = () => {
      setBoxZoomActive(false);
    };
    const cancelPointer = (event: globalThis.PointerEvent) => {
      if (drag.pointerId === null || event.pointerId !== drag.pointerId) {
        if (drag.pointerId === null) setBoxZoomActive(false);
        return;
      }
      releasePointerCapture(mapCanvas, drag.pointerId, suppressNextClick, true);
      if (drag.kind === "transform") callbacksRef.current.onAreaChange(drag.initialArea);
      else callbacksRef.current.onCancelDrawing();
      setSelectionError(null);
      setDrag(null);
    };
    const cancelKeyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (boxZoomGestureRef.current) {
        queueMicrotask(() => setBoxZoomActive(false));
        return;
      }
      if (event.defaultPrevented || foregroundEscapeOwner(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      releasePointerCapture(mapCanvas, drag.pointerId, suppressNextClick, true);
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
    window.addEventListener("mouseup", clearBoxZoomGesture);
    window.addEventListener("keydown", cancelKeyboard, { capture: true });
    return () => {
      mapCanvas.classList.remove("map-canvas--region-drawing");
      mapCanvas.removeEventListener("pointerdown", startDrag, { capture: true });
      window.removeEventListener("pointermove", updateDrag);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("mouseup", clearBoxZoomGesture);
      window.removeEventListener("keydown", cancelKeyboard, { capture: true });
    };
  }, [drag, map, mapCanvas, onBeginRegionInteraction, setBoxZoomActive, suppressNextClick]);

  const beginTransform = (transform: RegionTransform, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !map || !mapCanvas || !area || !rect) return;
    event.preventDefault();
    event.stopPropagation();
    onBeginRegionInteraction();
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
    onBeginRegionInteraction();
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

function releasePointerCapture(
  mapCanvas: HTMLDivElement | null,
  pointerId: number | null,
  suppressNextClick: () => void,
  suppressReleaseClick: boolean
): void {
  if (pointerId === null) return;
  if (suppressReleaseClick) suppressNextClick();
  if (mapCanvas?.hasPointerCapture?.(pointerId)) mapCanvas.releasePointerCapture?.(pointerId);
}
