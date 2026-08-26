import type { Map as MlMap, StyleSpecification } from "maplibre-gl";
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "../../styles/map-comparison.css";
import type { MapSourceConfig } from "../../../app/config.js";
import { sanitizeConnectionError } from "../../../atlas/connection-error.js";
import { Button, IconButton } from "../../primitives/controls.js";
import { CloseIcon, ComparisonIcon, DoubleCaretVerticalIcon, TrashIcon } from "../../primitives/icons.js";
import { MapSourceSelect } from "../MapSourcePicker.js";
import type { MapEditing } from "../rendering/map-editing.js";
import { pushEditingOverlay, pushSources, registerSourcesAndLayers } from "../rendering/map-layers.js";
import type { MapSources } from "../rendering/map-sources.js";
import type { MapLibreRuntime } from "../runtime/maplibre-runtime.js";
import { cloneStyle } from "./map-view-utils.js";

type GeographicRegion = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type ScreenRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type DragState =
  | {
      kind: "draw";
      start: ScreenPoint | null;
      current: ScreenPoint | null;
      previousRegion: GeographicRegion | null;
    }
  | { kind: "move"; start: ScreenPoint; initialRect: ScreenRect; initialRegion: GeographicRegion };

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
  notifyUserGesture: () => void;
};

const MIN_REGION_SIZE = 32;
const PANEL_WIDTH = 258;
const PANEL_HEIGHT = 160;

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
  notifyUserGesture
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
  sourcesRef.current = sources;
  editingRef.current = editing;
  regionRectRef.current = regionRect;

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
    const startDrawing = (event: globalThis.MouseEvent) => {
      if (drag.kind !== "draw" || drag.start || event.button !== 0 || event.shiftKey) return;
      if (event.target instanceof HTMLElement && event.target.closest("[data-map-interaction-control]")) return;
      event.preventDefault();
      event.stopPropagation();
      const point = pointInCanvas(event, mapCanvas, true);
      setDrag({ ...drag, start: point, current: point });
      notifyUserGesture();
    };
    const updateDrag = (event: globalThis.MouseEvent) => {
      const point = pointInCanvas(event, mapCanvas, true);
      if (drag.kind === "draw") {
        if (!drag.start) return;
        setDrag((current) => (current?.kind === "draw" ? { ...current, current: point } : current));
        return;
      }
      const delta = { x: point.x - drag.start.x, y: point.y - drag.start.y };
      const movedRect = clampMovedRect(drag.initialRect, delta, mapCanvas.getBoundingClientRect());
      setRegion(regionFromScreenRect(primaryMap, movedRect));
    };
    const finishDrag = (event: globalThis.MouseEvent) => {
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
      if (event.target instanceof Node && mapCanvas.contains(event.target)) {
        mapCanvas.addEventListener(
          "click",
          (clickEvent) => {
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
          },
          { capture: true, once: true }
        );
      }
      setDrag(null);
      notifyUserGesture();
    };
    const cancelDrag = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || boxZoomActive) return;
      event.preventDefault();
      event.stopPropagation();
      setRegion(drag.kind === "draw" ? drag.previousRegion : drag.initialRegion);
      setPanelOpen(drag.kind === "draw" && Boolean(drag.previousRegion));
      setDrag(null);
      toolRef.current?.focus();
    };
    mapCanvas.classList.toggle("map-canvas--compare-drawing", drag.kind === "draw");
    mapCanvas.addEventListener("mousedown", startDrawing, { capture: true });
    window.addEventListener("mousemove", updateDrag);
    window.addEventListener("mouseup", finishDrag);
    window.addEventListener("keydown", cancelDrag, { capture: true });
    return () => {
      mapCanvas.classList.remove("map-canvas--compare-drawing");
      mapCanvas.removeEventListener("mousedown", startDrawing, { capture: true });
      window.removeEventListener("mousemove", updateDrag);
      window.removeEventListener("mouseup", finishDrag);
      window.removeEventListener("keydown", cancelDrag, { capture: true });
    };
  }, [boxZoomActive, drag, map, mapCanvas, notifyUserGesture]);

  useEffect(() => {
    if (!region && !panelOpen) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || drag) return;
      if (event.target instanceof HTMLElement && event.target.closest('[role="listbox"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (panelOpen) setPanelOpen(false);
      else setRegion(null);
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
    const handleLoading = () => {
      if (!failed) setStatus({ kind: "loading" });
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
  }, [map, maplibre, regionVisible, retryGeneration, source?.id, source?.style]);

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
    setStatus({ kind: "idle" });
    toolRef.current?.focus();
  };

  const beginDrawing = (previousRegion: GeographicRegion | null) => {
    if (!mapCanvas || !map || !mapReady) return;
    setPanelOpen(false);
    setDrag({ kind: "draw", start: null, current: null, previousRegion });
  };

  const drawingRect =
    drag?.kind === "draw" && drag.start && drag.current ? rectFromPoints(drag.start, drag.current) : null;
  const drawing = drag?.kind === "draw";
  const panelAnchor = panelPosition(regionRect, mapCanvas?.getBoundingClientRect());
  const captionStyle = captionPosition(regionRect, mapCanvas?.getBoundingClientRect());
  const comparisonStyle = regionRect ? rectStyle(regionRect) : undefined;
  const attribution = source?.style ? attributionHtml(source.style.sources) : "";

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

      {regionRect && source?.style ? (
        <div ref={comparisonHostRef} className="map-compare__map" style={comparisonStyle} aria-hidden="true" />
      ) : null}

      {regionRect ? (
        <div className="map-compare__region" style={comparisonStyle} data-testid="map-comparison-region">
          <button
            type="button"
            className="map-compare__move-handle"
            data-map-interaction-control
            aria-label="Move comparison region"
            title="Drag or use arrow keys to move region"
            onMouseDown={(event) => {
              if (event.button !== 0 || !mapCanvas || !region) return;
              event.preventDefault();
              event.stopPropagation();
              setPanelOpen(false);
              setDrag({
                kind: "move",
                start: pointInCanvas(event, mapCanvas, true),
                initialRect: regionRect,
                initialRegion: region
              });
            }}
            onKeyDown={(event) => {
              if (!map || !mapCanvas || !regionRect) return;
              const step = event.shiftKey ? 40 : 10;
              const delta =
                event.key === "ArrowLeft"
                  ? { x: -step, y: 0 }
                  : event.key === "ArrowRight"
                    ? { x: step, y: 0 }
                    : event.key === "ArrowUp"
                      ? { x: 0, y: -step }
                      : event.key === "ArrowDown"
                        ? { x: 0, y: step }
                        : null;
              if (!delta) return;
              event.preventDefault();
              event.stopPropagation();
              setRegion(
                regionFromScreenRect(map, clampMovedRect(regionRect, delta, mapCanvas.getBoundingClientRect()))
              );
              notifyUserGesture();
            }}
          >
            <DoubleCaretVerticalIcon size={12} />
          </button>
        </div>
      ) : null}

      {drawing ? (
        <div className="map-compare__drawing-surface">
          {drawingRect && (drawingRect.width > 0 || drawingRect.height > 0) ? (
            <div className="map-compare__drawing-region" style={rectStyle(drawingRect)} />
          ) : null}
          <div className="map-compare__drawing-prompt" role="status">
            Drag a region. Shift-drag still zooms.
          </div>
        </div>
      ) : null}

      {regionRect && !panelOpen ? (
        <button
          type="button"
          className="map-compare__caption"
          style={captionStyle}
          data-map-interaction-control
          onClick={() => setPanelOpen(true)}
        >
          <span>{source?.label ?? "Source unavailable"}</span>
          <StatusLabel status={status} />
        </button>
      ) : null}

      {source?.style && regionRect && attribution ? (
        <div
          className="map-compare__attribution"
          style={attributionPosition(regionRect)}
          data-map-interaction-control
          aria-label="Comparison map attribution"
          // Map source attributions are trusted build-time provider metadata.
          dangerouslySetInnerHTML={{ __html: attribution }}
        />
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
              <Button onClick={() => setRetryGeneration((generation) => generation + 1)}>Retry</Button>
            </div>
          ) : null}
          <footer className="map-compare__actions">
            <Button disabled={!region} onClick={() => beginDrawing(region)}>
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
  const points = [
    map.project([region.west, region.north]),
    map.project([region.east, region.north]),
    map.project([region.east, region.south]),
    map.project([region.west, region.south])
  ];
  const left = Math.max(0, Math.min(...points.map((point) => point.x)));
  const top = Math.max(0, Math.min(...points.map((point) => point.y)));
  const right = Math.min(viewportWidth, Math.max(...points.map((point) => point.x)));
  const bottom = Math.min(viewportHeight, Math.max(...points.map((point) => point.y)));
  if (right - left < 2 || bottom - top < 2) return null;
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
  return {
    ...rect,
    left: Math.max(0, Math.min(viewport.width - rect.width, rect.left + delta.x)),
    top: Math.max(0, Math.min(viewport.height - rect.height, rect.top + delta.y))
  };
}

function rectStyle(rect: ScreenRect): CSSProperties {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function panelPosition(
  rect: ScreenRect | null,
  viewport: DOMRect | undefined
): { style: CSSProperties; placement: "above" | "below" | "floating" } | undefined {
  if (!rect || !viewport) return undefined;
  const left = Math.max(10, Math.min(viewport.width - PANEL_WIDTH - 10, rect.left));
  if (rect.top >= PANEL_HEIGHT + 10) {
    return { style: { left, top: rect.top - 10, transform: "translateY(-100%)" }, placement: "above" };
  }
  if (viewport.height - rect.top - rect.height >= PANEL_HEIGHT + 10) {
    return { style: { left, top: rect.top + rect.height + 10 }, placement: "below" };
  }
  return { style: { left, top: 10, maxHeight: Math.max(0, viewport.height - 20) }, placement: "floating" };
}

function captionPosition(rect: ScreenRect | null, viewport: DOMRect | undefined): CSSProperties | undefined {
  if (!rect || !viewport) return undefined;
  return {
    left: Math.max(8, Math.min(viewport.width - 210, rect.left)),
    top: Math.max(8, rect.top - 30)
  };
}

function attributionPosition(rect: ScreenRect): CSSProperties {
  return { left: rect.left + 4, top: rect.top + rect.height - 22, maxWidth: Math.max(0, rect.width - 8) };
}

function attributionHtml(sources: StyleSpecification["sources"]): string {
  return Object.values(sources)
    .flatMap((source) => {
      if (!source || typeof source !== "object" || !("attribution" in source)) return [];
      const attribution = source.attribution;
      return typeof attribution === "string" && attribution.trim() ? [attribution] : [];
    })
    .join(" · ");
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
