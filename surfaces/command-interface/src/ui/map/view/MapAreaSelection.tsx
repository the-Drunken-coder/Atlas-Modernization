import type { MapArea } from "@the-drunken-coder/atlas-sdk";
import type { Map as MlMap } from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import { foregroundEscapeOwner } from "../interaction/foreground-escape-owner.js";
import { MapRegionSelection, type ScreenRect } from "./MapRegionSelection.js";
import { regionFromMapBounds, screenRectsEqual, visibleScreenRect } from "./map-region-geometry.js";
import { useMapRegionInteraction } from "./map-region-interaction.js";

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
  const rectRef = useRef(rect);
  const boxZoomGestureRef = useRef(false);
  const onBoxZoomActiveChangeRef = useRef(onBoxZoomActiveChange);
  const callbacksRef = useRef({ onAreaChange, onDrawingComplete, onCancelDrawing, onViewportArea });
  rectRef.current = rect;
  onBoxZoomActiveChangeRef.current = onBoxZoomActiveChange;
  callbacksRef.current = { onAreaChange, onDrawingComplete, onCancelDrawing, onViewportArea };

  const setBoxZoomActive = useCallback((active: boolean) => {
    boxZoomGestureRef.current = active;
    onBoxZoomActiveChangeRef.current(active);
  }, []);

  useEffect(() => {
    return () => {
      setBoxZoomActive(false);
    };
  }, [setBoxZoomActive]);

  useEffect(() => {
    if (!map || !mapCanvas || !mapReady) return;
    const publishViewport = () => {
      callbacksRef.current.onViewportArea(regionFromMapBounds(map));
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

  const interaction = useMapRegionInteraction({
    map,
    mapCanvas,
    onBeginInteraction: onBeginRegionInteraction,
    onRegionChange: (nextArea) => callbacksRef.current.onAreaChange(nextArea),
    onDrawResult: (result) => {
      if (result.kind === "invalid") return "continue";
      if (result.kind === "undersized") {
        callbacksRef.current.onCancelDrawing();
        return;
      }
      callbacksRef.current.onAreaChange(result.region);
      callbacksRef.current.onDrawingComplete();
    },
    onCancel: (cancellation) => {
      if (cancellation.kind === "transform") callbacksRef.current.onAreaChange(cancellation.initialRegion);
      else callbacksRef.current.onCancelDrawing();
    },
    escapeBlocked: (event) => {
      if (boxZoomGestureRef.current) {
        queueMicrotask(() => setBoxZoomActive(false));
        return true;
      }
      return event.defaultPrevented || Boolean(foregroundEscapeOwner(event.target));
    },
    suppressNextClick,
    onShiftPointerDown: () => setBoxZoomActive(true),
    onWindowMouseUp: () => setBoxZoomActive(false),
    onPointerCancelWithoutInteraction: () => setBoxZoomActive(false),
    unmountReleaseClickSuppression: "always"
  });

  useEffect(() => {
    if (!drawing) {
      if (interaction.activeKind === "draw") {
        interaction.cancelInteraction({ reason: "external", suppressReleaseClick: "always", notify: false });
      }
      return;
    }
    if (interaction.activeKind === "draw") return;
    if (interaction.activeKind === "transform") {
      interaction.cancelInteraction({ reason: "external", suppressReleaseClick: "always", notify: true });
    }
    interaction.beginDrawing(null);
  }, [drawing, interaction.activeKind, interaction.beginDrawing, interaction.cancelInteraction]);

  return (
    <>
      <MapRegionSelection
        rect={rect}
        drawing={interaction.drawing}
        drawingRect={interaction.drawingRect}
        drawingPrompt={interaction.selectionError ?? "Drag an area. Press Escape to cancel."}
        label="selected area"
        testId="map-area-selection"
        viewport={mapCanvas?.getBoundingClientRect()}
        tinted
        onPointerDown={(transform, event) => {
          if (area && rect) interaction.beginTransform(transform, event, area);
        }}
        onKeyDown={(transform, event) => {
          if (area) interaction.transformWithKeyboard(transform, event, area);
        }}
      />
      {interaction.selectionError && !interaction.drawing ? (
        <p className="map-region-selection__status" role="status">
          {interaction.selectionError}
        </p>
      ) : null}
    </>
  );
}
