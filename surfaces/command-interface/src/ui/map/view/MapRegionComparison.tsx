import type { MapEventType, Map as MlMap } from "maplibre-gl";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import "../../styles/map-comparison.css";
import type { MapSourceConfig } from "../../../app/config.js";
import { sanitizeConnectionError } from "../../../atlas/connection-error.js";
import { Button, IconButton } from "../../primitives/controls.js";
import { CloseIcon, ComparisonIcon, TrashIcon } from "../../primitives/icons.js";
import { foregroundEscapeOwner } from "../interaction/foreground-escape-owner.js";
import { MapSourceSelect } from "../MapSourcePicker.js";
import type { MapEditing } from "../rendering/map-editing.js";
import { pushEditingOverlay, pushSources, registerSourcesAndLayers } from "../rendering/map-layers.js";
import type { MapSources } from "../rendering/map-sources.js";
import type { MapLibreRuntime } from "../runtime/maplibre-runtime.js";
import { MapRegionSelection, type RegionTransform, type ResizeAxes, type ScreenRect } from "./MapRegionSelection.js";
import { cloneStyle } from "./map-view-utils.js";

type GeographicRegion = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type DragState =
  | {
      kind: "draw";
      start: ScreenPoint | null;
      current: ScreenPoint | null;
      pointerId: number | null;
      previousRegion: GeographicRegion | null;
    }
  | {
      kind: "transform";
      transform: RegionTransform;
      start: ScreenPoint;
      pointerId: number;
      initialRect: ScreenRect;
      initialRegion: GeographicRegion;
    };

type ScreenPoint = { x: number; y: number };

type ComparisonStatus = { kind: "idle" } | { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

type MapRegionComparisonProps = {
  mapCanvas: HTMLDivElement | null;
  map: MlMap | undefined;
  maplibre: MapLibreRuntime | undefined;
  mapReady: boolean;
  boxZoomActive: boolean;
  baseSourceId: string;
  sourceOptions: MapSourceConfig[];
  sources: MapSources;
  editing?: MapEditing;
  exclusiveDrawingActive: boolean;
  onBeginDrawing: () => void;
  notifyUserGesture: () => void;
  suppressNextClick: () => void;
};

const MIN_REGION_SIZE = 32;
const PANEL_WIDTH = 258;
const PANEL_HEIGHT_ESTIMATE = 210;

export function MapRegionComparison({
  mapCanvas,
  map,
  maplibre,
  mapReady,
  boxZoomActive,
  baseSourceId,
  sourceOptions,
  sources,
  editing,
  exclusiveDrawingActive,
  onBeginDrawing,
  notifyUserGesture,
  suppressNextClick
}: MapRegionComparisonProps) {
  const alternatives = useMemo(
    () => sourceOptions.filter((source) => source.id !== baseSourceId),
    [baseSourceId, sourceOptions]
  );
  const availableAlternatives = useMemo(
    () =>
      alternatives.filter((source): source is MapSourceConfig & { style: NonNullable<MapSourceConfig["style"]> } =>
        Boolean(source.style)
      ),
    [alternatives]
  );
  const [alternateSourceId, setAlternateSourceId] = useState(availableAlternatives[0]?.id ?? "");
  const [region, setRegion] = useState<GeographicRegion | null>(null);
  const [regionRect, setRegionRect] = useState<ScreenRect | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelHeight, setPanelHeight] = useState(PANEL_HEIGHT_ESTIMATE);
  const [opacity, setOpacity] = useState(100);
  const [status, setStatus] = useState<ComparisonStatus>({ kind: "idle" });
  const [retryGeneration, setRetryGeneration] = useState(0);
  const toolRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const comparisonHostRef = useRef<HTMLDivElement>(null);
  const comparisonMapRef = useRef<MlMap | undefined>(undefined);
  const syncFrameRef = useRef<number | undefined>(undefined);
  const regionRectRef = useRef(regionRect);
  const sourcesRef = useRef(sources);
  const editingRef = useRef(editing);
  const source = alternatives.find((candidate) => candidate.id === alternateSourceId);
  const regionVisible = regionRect !== null;
  const drawing = drag?.kind === "draw";
  sourcesRef.current = sources;
  editingRef.current = editing;
  regionRectRef.current = regionRect;

  useEffect(() => {
    if (!exclusiveDrawingActive || !drag) return;
    if (drag.pointerId !== null && mapCanvas?.hasPointerCapture?.(drag.pointerId)) {
      suppressNextClick();
      mapCanvas.releasePointerCapture?.(drag.pointerId);
    }
    setRegion(drag.kind === "draw" ? drag.previousRegion : drag.initialRegion);
    if (drag.kind === "draw") setPanelOpen(Boolean(drag.previousRegion));
    setDrag(null);
  }, [drag, exclusiveDrawingActive, mapCanvas, suppressNextClick]);

  useEffect(() => {
    if (source?.style) return;
    setAlternateSourceId(availableAlternatives[0]?.id ?? "");
  }, [availableAlternatives, source?.style]);

  useEffect(() => {
    if (!panelOpen) return;
    const frame = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>("[data-map-source-trigger]")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [panelOpen]);

  useLayoutEffect(() => {
    if (!panelOpen) return;
    const height = panelRef.current?.scrollHeight;
    if (!height) return;
    setPanelHeight((current) => (current === height ? current : height));
  }, [panelOpen, regionRect, source?.id, status]);

  useEffect(() => {
    if (!map || !mapCanvas || !mapReady || !region) {
      setRegionRect(null);
      return;
    }
    const syncRect = () => {
      if (syncFrameRef.current !== undefined) return;
      syncFrameRef.current = requestAnimationFrame(() => {
        syncFrameRef.current = undefined;
        const bounds = mapCanvas.getBoundingClientRect();
        const next = visibleScreenRect(map, region, bounds.width, bounds.height);
        if (
          !next &&
          document.activeElement instanceof Element &&
          document.activeElement.closest(".map-region-selection, .map-compare__caption")
        )
          toolRef.current?.focus();
        if (screenRectsEqual(regionRectRef.current, next)) {
          if (next) syncComparisonCamera(map, comparisonMapRef.current, next, false);
          return;
        }
        regionRectRef.current = next;
        setRegionRect(next);
      });
    };
    syncRect();
    map.on("move", syncRect);
    map.on("zoom", syncRect);
    map.on("resize", syncRect);
    return () => {
      map.off("move", syncRect);
      map.off("zoom", syncRect);
      map.off("resize", syncRect);
      if (syncFrameRef.current !== undefined) cancelAnimationFrame(syncFrameRef.current);
      syncFrameRef.current = undefined;
    };
  }, [map, mapCanvas, mapReady, region]);

  useEffect(() => {
    if (!map || !mapCanvas || !drag) return;
    const primaryMap = map;
    const startDrawing = (event: globalThis.PointerEvent) => {
      if (drag.kind !== "draw" || drag.start || event.button !== 0 || event.shiftKey) return;
      if (
        event.target instanceof Element &&
        event.target.closest(".maplibregl-control-container, [data-map-interaction-control]")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      primaryMap.stop();
      mapCanvas.setPointerCapture?.(event.pointerId);
      const point = pointInCanvas(event, mapCanvas, true);
      setDrag({ ...drag, start: point, current: point, pointerId: event.pointerId });
      notifyUserGesture();
    };
    const updateDrag = (event: globalThis.PointerEvent) => {
      if (drag.pointerId === null || event.pointerId !== drag.pointerId) return;
      const point = pointInCanvas(event, mapCanvas, true);
      if (drag.kind === "draw") {
        if (!drag.start) return;
        setDrag((current) => (current?.kind === "draw" ? { ...current, current: point } : current));
        return;
      }
      const delta = { x: point.x - drag.start.x, y: point.y - drag.start.y };
      const nextRect =
        drag.transform === "move"
          ? clampMovedRect(drag.initialRect, delta, mapCanvas.getBoundingClientRect())
          : clampResizedRect(drag.initialRect, delta, drag.transform);
      setRegion(regionFromScreenRect(primaryMap, nextRect));
    };
    const finishDrag = (event: globalThis.PointerEvent) => {
      if (drag.pointerId === null || event.pointerId !== drag.pointerId) return;
      if (drag.kind === "draw") {
        if (!drag.start) return;
        const end = pointInCanvas(event, mapCanvas, true);
        const rect = rectFromPoints(drag.start, end);
        if (rect.width >= MIN_REGION_SIZE && rect.height >= MIN_REGION_SIZE) {
          setRegion(regionFromScreenRect(primaryMap, rect));
          setPanelOpen(true);
        } else {
          setRegion(drag.previousRegion);
          setPanelOpen(Boolean(drag.previousRegion));
        }
      }
      if (event.target instanceof Node && mapCanvas.contains(event.target)) suppressNextClick();
      setDrag(null);
      notifyUserGesture();
    };
    const cancelActiveDrag = (suppressReleaseClick: boolean) => {
      if (drag.pointerId !== null) {
        if (suppressReleaseClick) suppressNextClick();
        if (mapCanvas.hasPointerCapture?.(drag.pointerId)) mapCanvas.releasePointerCapture?.(drag.pointerId);
      }
      setRegion(drag.kind === "draw" ? drag.previousRegion : drag.initialRegion);
      setPanelOpen(drag.kind === "draw" && Boolean(drag.previousRegion));
      setDrag(null);
      toolRef.current?.focus();
    };
    const cancelPointer = (event: globalThis.PointerEvent) => {
      if (drag.pointerId === null || event.pointerId !== drag.pointerId) return;
      cancelActiveDrag(false);
    };
    const cancelDrag = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || boxZoomActive || foregroundEscapeOwner(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      cancelActiveDrag(true);
    };
    mapCanvas.classList.toggle("map-canvas--region-drawing", drag.kind === "draw");
    mapCanvas.addEventListener("pointerdown", startDrawing, { capture: true });
    window.addEventListener("pointermove", updateDrag);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("keydown", cancelDrag, { capture: true });
    return () => {
      mapCanvas.classList.remove("map-canvas--region-drawing");
      mapCanvas.removeEventListener("pointerdown", startDrawing, { capture: true });
      window.removeEventListener("pointermove", updateDrag);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("keydown", cancelDrag, { capture: true });
    };
  }, [boxZoomActive, drag, map, mapCanvas, notifyUserGesture, suppressNextClick]);

  useEffect(() => {
    if (!region && !panelOpen) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || drag) return;
      const escapeOwner = foregroundEscapeOwner(event.target);
      if (escapeOwner && !escapeOwner.matches(".map-compare__panel")) return;
      event.preventDefault();
      event.stopPropagation();
      if (panelOpen) setPanelOpen(false);
      else {
        setRegion(null);
        setOpacity(100);
      }
      toolRef.current?.focus();
    };
    window.addEventListener("keydown", handleEscape, { capture: true });
    return () => window.removeEventListener("keydown", handleEscape, { capture: true });
  }, [drag, panelOpen, region]);

  useEffect(() => {
    const host = comparisonHostRef.current;
    const initialRect = regionRectRef.current;
    if (!map || !maplibre || !host || !initialRect || !source?.style) {
      comparisonMapRef.current?.remove();
      comparisonMapRef.current = undefined;
      setStatus({ kind: "idle" });
      return;
    }

    let failed = false;
    setStatus({ kind: "loading" });
    let comparisonMap: MlMap;
    try {
      comparisonMap = new maplibre.Map({
        container: host,
        style: cloneStyle(source.style),
        center: map.unproject([initialRect.left + initialRect.width / 2, initialRect.top + initialRect.height / 2]),
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
        renderWorldCopies: false,
        interactive: false,
        attributionControl: false,
        fadeDuration: 0
      });
    } catch (error) {
      setStatus({ kind: "error", message: sanitizeConnectionError(error) });
      return;
    }
    comparisonMapRef.current = comparisonMap;

    const initializeLayers = () => {
      registerSourcesAndLayers(comparisonMap);
      pushSources(comparisonMap, sourcesRef.current);
      pushEditingOverlay(comparisonMap, editingRef.current);
    };
    const alternateSourceIds = new Set(Object.keys(source.style.sources));
    const handleLoading = (event: MapEventType["dataloading"]) => {
      if (!failed && "sourceId" in event && alternateSourceIds.has(event.sourceId)) setStatus({ kind: "loading" });
    };
    const handleIdle = () => {
      if (!failed) setStatus({ kind: "ready" });
    };
    const handleError = (event: { error?: unknown }) => {
      failed = true;
      setStatus({ kind: "error", message: sanitizeConnectionError(event.error) });
    };
    comparisonMap.on("style.load", initializeLayers);
    comparisonMap.on("dataloading", handleLoading);
    comparisonMap.on("idle", handleIdle);
    comparisonMap.on("error", handleError);
    if (comparisonMap.isStyleLoaded()) initializeLayers();

    return () => {
      comparisonMap.remove();
      if (comparisonMapRef.current === comparisonMap) comparisonMapRef.current = undefined;
    };
    // The map persists while the region moves. Camera changes are synchronized below.
  }, [drawing, map, maplibre, regionVisible, retryGeneration, source?.id, source?.style]);

  useEffect(() => {
    const comparisonMap = comparisonMapRef.current;
    if (!comparisonMap || !comparisonMap.isStyleLoaded()) return;
    pushSources(comparisonMap, sources);
  }, [sources]);

  useEffect(() => {
    const comparisonMap = comparisonMapRef.current;
    if (!comparisonMap || !comparisonMap.isStyleLoaded()) return;
    pushEditingOverlay(comparisonMap, editing);
  }, [editing]);

  useLayoutEffect(() => {
    if (!map || !regionRect) return;
    syncComparisonCamera(map, comparisonMapRef.current, regionRect, true);
  }, [map, regionRect]);

  const clear = () => {
    setRegion(null);
    setPanelOpen(false);
    setOpacity(100);
    setStatus({ kind: "idle" });
    toolRef.current?.focus();
  };

  const beginDrawing = (previousRegion: GeographicRegion | null) => {
    if (!mapCanvas || !map || !mapReady) return;
    onBeginDrawing();
    setPanelOpen(false);
    setDrag({ kind: "draw", start: null, current: null, pointerId: null, previousRegion });
  };

  const createKeyboardRegion = () => {
    if (!mapCanvas || !map || !mapReady) return;
    const viewport = mapCanvas.getBoundingClientRect();
    if (viewport.width < MIN_REGION_SIZE || viewport.height < MIN_REGION_SIZE) return;
    const width = Math.min(240, Math.max(MIN_REGION_SIZE, viewport.width / 2));
    const height = Math.min(180, Math.max(MIN_REGION_SIZE, viewport.height / 2));
    onBeginDrawing();
    map.stop();
    setRegion(
      regionFromScreenRect(map, {
        left: (viewport.width - width) / 2,
        top: (viewport.height - height) / 2,
        width,
        height
      })
    );
    setPanelOpen(true);
    notifyUserGesture();
  };

  const beginTransform = (transform: RegionTransform, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !map || !mapCanvas || !region || !regionRect) return;
    event.preventDefault();
    event.stopPropagation();
    map.stop();
    mapCanvas.setPointerCapture?.(event.pointerId);
    notifyUserGesture();
    setPanelOpen(false);
    setDrag({
      kind: "transform",
      transform,
      start: pointInCanvas(event, mapCanvas, true),
      pointerId: event.pointerId,
      initialRect: projectedScreenRect(map, region),
      initialRegion: region
    });
  };

  const transformWithKeyboard = (transform: RegionTransform, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!map || !mapCanvas || !region) return;
    const delta = keyboardDelta(event.key, event.shiftKey ? 40 : 10, transform === "move" ? "both" : transform);
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    map.stop();
    setPanelOpen(false);
    const viewport = mapCanvas.getBoundingClientRect();
    const projectedRect = projectedScreenRect(map, region);
    const nextRect =
      transform === "move"
        ? clampMovedRect(projectedRect, delta, viewport)
        : clampResizedRect(projectedRect, delta, transform);
    setRegion(regionFromScreenRect(map, nextRect));
    notifyUserGesture();
  };

  const drawingRect =
    drag?.kind === "draw" && drag.start && drag.current ? rectFromPoints(drag.start, drag.current) : null;
  const canvasBounds = mapCanvas?.getBoundingClientRect();
  const panelAnchor = panelPosition(regionRect, canvasBounds, panelHeight);
  const captionStyle = captionPosition(regionRect, canvasBounds);
  const comparisonStyle = regionRect ? { ...rectStyle(regionRect), opacity: opacity / 100 } : undefined;

  return (
    <>
      <div className="map-compare__tool" data-map-interaction-control>
        <button
          ref={toolRef}
          type="button"
          className="map-compare__tool-button"
          aria-label="Compare map source inside a region"
          aria-pressed={Boolean(region || drag || panelOpen)}
          disabled={!mapReady}
          title="Compare map source inside a region"
          onKeyDown={(event) => {
            if (!region && !drag && availableAlternatives.length > 0 && ["Enter", " "].includes(event.key)) {
              event.preventDefault();
              createKeyboardRegion();
            }
          }}
          onClick={() => {
            if (drag?.kind === "draw") {
              setRegion(drag.previousRegion);
              setPanelOpen(Boolean(drag.previousRegion));
              setDrag(null);
              return;
            }
            if (region) {
              setPanelOpen(true);
              return;
            }
            if (availableAlternatives.length === 0) {
              setPanelOpen((open) => !open);
              return;
            }
            beginDrawing(null);
          }}
        >
          <ComparisonIcon size={14} />
          <span>Compare</span>
        </button>
      </div>

      {regionRect && source?.style && !drawing ? (
        <div ref={comparisonHostRef} className="map-compare__map" style={comparisonStyle} aria-hidden="true" />
      ) : null}

      <MapRegionSelection
        rect={regionRect}
        drawing={drawing}
        drawingRect={drawingRect}
        drawingPrompt="Drag a region. Shift-drag still zooms."
        label="comparison region"
        testId="map-comparison-region"
        viewport={canvasBounds}
        onPointerDown={beginTransform}
        onKeyDown={transformWithKeyboard}
      />

      {regionRect && !panelOpen && !drawing ? (
        <button
          type="button"
          className="map-compare__caption"
          style={captionStyle}
          data-map-interaction-control
          onClick={() => setPanelOpen(true)}
        >
          <span>
            {source?.label ?? "Source unavailable"}
            {source?.style ? ` · ${opacity}%` : ""}
          </span>
          <StatusLabel status={status} />
        </button>
      ) : null}

      {panelOpen ? (
        <section
          ref={panelRef}
          className={`map-compare__panel${regionRect ? "" : " map-compare__panel--tool"}`}
          style={regionRect ? panelAnchor?.style : undefined}
          data-placement={regionRect ? panelAnchor?.placement : "tool"}
          role="dialog"
          aria-label="Region comparison"
          data-map-interaction-control
        >
          <header className="map-compare__panel-header">
            <strong>Region comparison</strong>
            <IconButton
              label="Close comparison controls"
              className="map-compare__close"
              onClick={() => {
                setPanelOpen(false);
                toolRef.current?.focus();
              }}
            >
              <CloseIcon size={12} />
            </IconButton>
          </header>
          <MapSourceSelect
            sources={alternatives}
            value={alternateSourceId}
            label="Inside region"
            onChange={(next) => {
              setAlternateSourceId(next);
              setRetryGeneration((generation) => generation + 1);
            }}
          />
          {region && source?.style ? (
            <label className="map-compare__opacity">
              <span>
                <span>Opacity</span>
                <output>{opacity}%</output>
              </span>
              <input
                type="range"
                min="0"
                max="100"
                aria-label="Comparison map opacity"
                value={opacity}
                onChange={(event) => setOpacity(event.currentTarget.valueAsNumber)}
              />
            </label>
          ) : null}
          {availableAlternatives.length === 0 ? (
            <p className="map-compare__message" role="status">
              No alternate source is available. Configure a provider key to compare maps.
            </p>
          ) : status.kind === "loading" ? (
            <p className="map-compare__status" role="status">
              Loading tiles
            </p>
          ) : status.kind === "error" ? (
            <div className="map-compare__error" role="alert">
              <span>Tile error</span>
              <code>{status.message}</code>
              <Button
                onClick={() => {
                  panelRef.current?.querySelector<HTMLButtonElement>("[data-map-source-trigger]")?.focus();
                  setRetryGeneration((generation) => generation + 1);
                }}
              >
                Retry
              </Button>
            </div>
          ) : null}
          <footer className="map-compare__actions">
            <Button
              disabled={!region}
              onKeyDown={(event) => {
                if (!["Enter", " "].includes(event.key)) return;
                event.preventDefault();
                createKeyboardRegion();
              }}
              onClick={() => beginDrawing(region)}
            >
              Redraw
            </Button>
            <Button variant="ghost" disabled={!region} onClick={clear}>
              <TrashIcon size={12} /> Clear
            </Button>
          </footer>
        </section>
      ) : null}
    </>
  );
}

function StatusLabel({ status }: { status: ComparisonStatus }) {
  return status.kind === "loading" ? (
    <small>Loading</small>
  ) : status.kind === "error" ? (
    <small data-error>Error</small>
  ) : null;
}

function pointInCanvas(
  event: Pick<globalThis.MouseEvent, "clientX" | "clientY">,
  canvas: HTMLDivElement,
  clamp: boolean
): ScreenPoint {
  const bounds = canvas.getBoundingClientRect();
  const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  return clamp
    ? { x: Math.max(0, Math.min(bounds.width, point.x)), y: Math.max(0, Math.min(bounds.height, point.y)) }
    : point;
}

function rectFromPoints(a: ScreenPoint, b: ScreenPoint): ScreenRect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  };
}

function regionFromScreenRect(map: MlMap, rect: ScreenRect): GeographicRegion {
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
  region: GeographicRegion,
  viewportWidth: number,
  viewportHeight: number
): ScreenRect | null {
  const rect = projectedScreenRect(map, region);
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewportWidth, rect.left + rect.width);
  const bottom = Math.min(viewportHeight, rect.top + rect.height);
  if (right - left < 2 || bottom - top < 2) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function projectedScreenRect(map: MlMap, region: GeographicRegion): ScreenRect {
  const points = [
    map.project([region.west, region.north]),
    map.project([region.east, region.north]),
    map.project([region.east, region.south]),
    map.project([region.west, region.south])
  ];
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  return { left, top, width: right - left, height: bottom - top };
}

function syncComparisonCamera(
  primaryMap: MlMap,
  comparisonMap: MlMap | undefined,
  rect: ScreenRect,
  resize: boolean
): void {
  if (!comparisonMap) return;
  if (resize) comparisonMap.resize();
  comparisonMap.jumpTo({
    center: primaryMap.unproject([rect.left + rect.width / 2, rect.top + rect.height / 2]),
    zoom: primaryMap.getZoom(),
    bearing: primaryMap.getBearing(),
    pitch: primaryMap.getPitch()
  });
}

function clampMovedRect(rect: ScreenRect, delta: ScreenPoint, viewport: DOMRect): ScreenRect {
  const visibleWidth = Math.min(MIN_REGION_SIZE, rect.width);
  const visibleHeight = Math.min(MIN_REGION_SIZE, rect.height);
  return {
    ...rect,
    left: Math.max(visibleWidth - rect.width, Math.min(viewport.width - visibleWidth, rect.left + delta.x)),
    top: Math.max(visibleHeight - rect.height, Math.min(viewport.height - visibleHeight, rect.top + delta.y))
  };
}

function clampResizedRect(rect: ScreenRect, delta: ScreenPoint, axes: ResizeAxes): ScreenRect {
  const minWidth = Math.max(MIN_REGION_SIZE, MIN_REGION_SIZE - rect.left);
  const minHeight = Math.max(MIN_REGION_SIZE, MIN_REGION_SIZE - rect.top);
  return {
    ...rect,
    width: axes === "height" ? rect.width : Math.max(minWidth, rect.width + delta.x),
    height: axes === "width" ? rect.height : Math.max(minHeight, rect.height + delta.y)
  };
}

function keyboardDelta(key: string, step: number, axes: ResizeAxes): ScreenPoint | null {
  if (axes !== "height" && key === "ArrowLeft") return { x: -step, y: 0 };
  if (axes !== "height" && key === "ArrowRight") return { x: step, y: 0 };
  if (axes !== "width" && key === "ArrowUp") return { x: 0, y: -step };
  if (axes !== "width" && key === "ArrowDown") return { x: 0, y: step };
  return null;
}

function rectStyle(rect: ScreenRect): CSSProperties {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function panelPosition(
  rect: ScreenRect | null,
  viewport: DOMRect | undefined,
  panelHeight: number
): { style: CSSProperties; placement: "above" | "below" | "floating" } | undefined {
  if (!rect || !viewport) return undefined;
  const left = Math.max(10, Math.min(viewport.width - PANEL_WIDTH - 10, rect.left));
  const safeTop = 88;
  if (rect.top - safeTop - 10 >= panelHeight) {
    return { style: { left, top: rect.top - 10, transform: "translateY(-100%)" }, placement: "above" };
  }
  if (viewport.height - rect.top - rect.height - 10 >= panelHeight) {
    return { style: { left, top: rect.top + rect.height + 10 }, placement: "below" };
  }
  return {
    style: { left, top: safeTop, maxHeight: Math.max(0, viewport.height - safeTop - 10) },
    placement: "floating"
  };
}

function captionPosition(rect: ScreenRect | null, viewport: DOMRect | undefined): CSSProperties | undefined {
  if (!rect || !viewport) return undefined;
  return {
    left: Math.max(8, Math.min(viewport.width - 210, rect.left)),
    top: Math.max(8, rect.top - 30)
  };
}

function screenRectsEqual(a: ScreenRect | null, b: ScreenRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}
