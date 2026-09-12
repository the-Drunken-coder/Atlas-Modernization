import type { MapEventType, Map as MlMap } from "maplibre-gl";
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { MapRegionSelection, type ScreenRect } from "./MapRegionSelection.js";
import {
  MIN_REGION_SIZE,
  type RegionBounds,
  regionFromScreenRect,
  screenRectsEqual,
  visibleScreenRect
} from "./map-region-geometry.js";
import { useMapRegionInteraction } from "./map-region-interaction.js";
import { cloneStyle } from "./map-view-utils.js";

type GeographicRegion = RegionBounds;

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
  onBeginRegionInteraction: () => void;
  onBeginDrawing: () => void;
  suppressNextClick: () => void;
};

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
  onBeginRegionInteraction,
  onBeginDrawing,
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
  sourcesRef.current = sources;
  editingRef.current = editing;
  regionRectRef.current = regionRect;

  const interaction = useMapRegionInteraction({
    map,
    mapCanvas,
    onBeginInteraction: onBeginRegionInteraction,
    onRegionChange: setRegion,
    onDrawResult: (result) => {
      if (result.kind === "complete") setRegion(result.region);
      else setRegion(result.initialRegion);
      setPanelOpen(result.kind === "undersized" ? Boolean(result.initialRegion) : true);
    },
    onCancel: (cancellation) => {
      setRegion(cancellation.initialRegion);
      setPanelOpen(cancellation.kind === "draw" && Boolean(cancellation.initialRegion));
      if (cancellation.reason !== "external") toolRef.current?.focus();
    },
    escapeBlocked: (event) => boxZoomActive || Boolean(foregroundEscapeOwner(event.target)),
    suppressNextClick
  });
  const drawing = interaction.drawing;

  useEffect(() => {
    if (!exclusiveDrawingActive) return;
    if (!interaction.activeKind) {
      setPanelOpen(false);
      return;
    }
    interaction.cancelInteraction({ reason: "external", suppressReleaseClick: "if-captured", notify: true });
    setPanelOpen(false);
  }, [exclusiveDrawingActive, interaction.activeKind, interaction.cancelInteraction]);

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
    if (!region && !panelOpen) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || interaction.activeKind) return;
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
  }, [interaction.activeKind, panelOpen, region]);

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
    let styleLoaded = comparisonMap.isStyleLoaded();

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
    const handleStyleLoad = () => {
      styleLoaded = true;
      initializeLayers();
    };
    const handleError = (event: { error?: unknown; sourceId?: string }) => {
      // MapLibre bubbles source/tile failures through the map. They are not
      // fatal to the comparison map and should not strand the operator in an
      // error state. Before the initial style load, an error without a
      // sourceId means the style itself failed and needs a fresh retry.
      if (styleLoaded || "sourceId" in event) return;
      failed = true;
      setStatus({ kind: "error", message: sanitizeConnectionError(event.error) });
    };
    comparisonMap.on("style.load", handleStyleLoad);
    comparisonMap.on("dataloading", handleLoading);
    comparisonMap.on("idle", handleIdle);
    comparisonMap.on("error", handleError);
    if (styleLoaded) initializeLayers();

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
    interaction.clearSelectionError();
    toolRef.current?.focus();
  };

  const beginDrawing = (previousRegion: GeographicRegion | null) => {
    if (!mapCanvas || !map || !mapReady) return;
    interaction.beginDrawing(previousRegion);
    onBeginDrawing();
    setPanelOpen(false);
  };

  const createKeyboardRegion = () => {
    if (!mapCanvas || !map || !mapReady) return;
    const viewport = mapCanvas.getBoundingClientRect();
    if (viewport.width < MIN_REGION_SIZE || viewport.height < MIN_REGION_SIZE) return;
    const width = Math.min(240, Math.max(MIN_REGION_SIZE, viewport.width / 2));
    const height = Math.min(180, Math.max(MIN_REGION_SIZE, viewport.height / 2));
    onBeginRegionInteraction();
    onBeginDrawing();
    interaction.clearSelectionError();
    const nextRegion = regionFromScreenRect(map, {
      left: (viewport.width - width) / 2,
      top: (viewport.height - height) / 2,
      width,
      height
    });
    if (!nextRegion) {
      interaction.reportInvalidSelection();
      setRegion(null);
      setPanelOpen(true);
      return;
    }
    setRegion(nextRegion);
    setPanelOpen(true);
  };

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
          aria-pressed={Boolean(region || interaction.activeKind || panelOpen)}
          disabled={!mapReady}
          title="Compare map source inside a region"
          onKeyDown={(event) => {
            if (
              !region &&
              !interaction.activeKind &&
              availableAlternatives.length > 0 &&
              ["Enter", " "].includes(event.key)
            ) {
              event.preventDefault();
              createKeyboardRegion();
            }
          }}
          onClick={() => {
            if (interaction.activeKind === "draw") {
              interaction.cancelInteraction({ reason: "external", suppressReleaseClick: false, notify: true });
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
        drawingRect={interaction.drawingRect}
        drawingPrompt="Drag a region. Shift-drag still zooms."
        label="comparison region"
        testId="map-comparison-region"
        viewport={canvasBounds}
        onPointerDown={(transform, event) => {
          if (!region || !regionRect) return;
          interaction.beginTransform(transform, event, region);
          setPanelOpen(false);
        }}
        onKeyDown={(transform, event) => {
          if (region && interaction.transformWithKeyboard(transform, event, region)) setPanelOpen(false);
        }}
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
          <StatusLabel status={status} selectionError={interaction.selectionError} />
        </button>
      ) : null}

      {interaction.selectionError && !panelOpen && !drawing ? (
        <p className="map-region-selection__status" role="status">
          {interaction.selectionError}
        </p>
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
          {interaction.selectionError ? (
            <p className="map-compare__status" role="status">
              {interaction.selectionError}
            </p>
          ) : null}
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

function StatusLabel({ status, selectionError }: { status: ComparisonStatus; selectionError: string | null }) {
  if (selectionError) return <small data-error>Error</small>;
  return status.kind === "loading" ? (
    <small>Loading</small>
  ) : status.kind === "error" ? (
    <small data-error>Error</small>
  ) : null;
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
