import type { Map as MlMap } from "maplibre-gl";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import type { RegionTransform, ScreenRect } from "./MapRegionSelection.js";
import {
  DATE_LINE_CROSSING_MESSAGE,
  keyboardDelta,
  MIN_REGION_SIZE,
  pointInCanvas,
  projectedScreenRect,
  type RegionBounds,
  rectFromPoints,
  regionAfterTransform,
  regionFromScreenRect
} from "./map-region-geometry.js";

type DrawInteraction = {
  kind: "draw";
  start: { x: number; y: number } | null;
  current: { x: number; y: number } | null;
  pointerId: number | null;
  initialRegion: RegionBounds | null;
};

type TransformInteraction = {
  kind: "transform";
  transform: RegionTransform;
  start: { x: number; y: number };
  pointerId: number;
  initialRect: ScreenRect;
  initialRegion: RegionBounds;
};

type ActiveInteraction = DrawInteraction | TransformInteraction;
type ReleaseClickSuppression = "always" | "if-captured" | false;

export type RegionDrawResult =
  | { kind: "complete"; region: RegionBounds; initialRegion: RegionBounds | null }
  | { kind: "invalid"; initialRegion: RegionBounds | null }
  | { kind: "undersized"; initialRegion: RegionBounds | null };

export type RegionInteractionCancellation =
  | { kind: "draw"; initialRegion: RegionBounds | null; reason: "pointer" | "keyboard" | "external" }
  | { kind: "transform"; initialRegion: RegionBounds; reason: "pointer" | "keyboard" | "external" };

type UseMapRegionInteractionOptions = {
  map: MlMap | undefined;
  mapCanvas: HTMLDivElement | null;
  onBeginInteraction(): void;
  onRegionChange(region: RegionBounds): void;
  onDrawResult(result: RegionDrawResult): "continue" | void;
  onCancel(cancellation: RegionInteractionCancellation): void;
  escapeBlocked(event: globalThis.KeyboardEvent): boolean;
  suppressNextClick(): void;
  onShiftPointerDown?(): void;
  onWindowMouseUp?(): void;
  onPointerCancelWithoutInteraction?(): void;
  unmountReleaseClickSuppression?: Exclude<ReleaseClickSuppression, false>;
};

type CancelInteractionOptions = {
  reason: "external";
  suppressReleaseClick: ReleaseClickSuppression;
  notify: boolean;
};

export function useMapRegionInteraction(options: UseMapRegionInteractionOptions) {
  const { map, mapCanvas } = options;
  const [active, setActive] = useState<ActiveInteraction | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const activeRef = useRef(active);
  const optionsRef = useRef(options);
  const notifyDrawingWhenReadyRef = useRef(false);
  activeRef.current = active;
  optionsRef.current = options;

  const releasePointer = useCallback((pointerId: number | null, suppressReleaseClick: ReleaseClickSuppression) => {
    if (pointerId === null) return;
    const currentCanvas = optionsRef.current.mapCanvas;
    const pointerCaptured = Boolean(currentCanvas?.hasPointerCapture?.(pointerId));
    if (suppressReleaseClick === "always" || (suppressReleaseClick === "if-captured" && pointerCaptured)) {
      optionsRef.current.suppressNextClick();
    }
    if (pointerCaptured) {
      currentCanvas?.releasePointerCapture?.(pointerId);
    }
  }, []);

  const cancelActive = useCallback(
    (
      interaction: ActiveInteraction,
      reason: RegionInteractionCancellation["reason"],
      suppressReleaseClick: ReleaseClickSuppression,
      notify: boolean
    ) => {
      releasePointer(interaction.pointerId, suppressReleaseClick);
      if (notify) {
        optionsRef.current.onCancel(
          interaction.kind === "draw"
            ? { kind: "draw", initialRegion: interaction.initialRegion, reason }
            : { kind: "transform", initialRegion: interaction.initialRegion, reason }
        );
      }
      notifyDrawingWhenReadyRef.current = false;
      setSelectionError(null);
      setActive(null);
    },
    [releasePointer]
  );

  const beginDrawing = useCallback((initialRegion: RegionBounds | null) => {
    notifyDrawingWhenReadyRef.current = !optionsRef.current.map || !optionsRef.current.mapCanvas;
    optionsRef.current.onBeginInteraction();
    setSelectionError(null);
    setActive({ kind: "draw", start: null, current: null, pointerId: null, initialRegion });
  }, []);

  const cancelInteraction = useCallback(
    ({ reason, suppressReleaseClick, notify }: CancelInteractionOptions) => {
      const interaction = activeRef.current;
      if (!interaction) return;
      cancelActive(interaction, reason, suppressReleaseClick, notify);
    },
    [cancelActive]
  );

  const beginTransform = useCallback(
    (transform: RegionTransform, event: ReactPointerEvent<HTMLButtonElement>, region: RegionBounds) => {
      const { map, mapCanvas } = optionsRef.current;
      if (event.button !== 0 || !map || !mapCanvas) return false;
      event.preventDefault();
      event.stopPropagation();
      optionsRef.current.onBeginInteraction();
      notifyDrawingWhenReadyRef.current = false;
      mapCanvas.setPointerCapture?.(event.pointerId);
      setSelectionError(null);
      setActive({
        kind: "transform",
        transform,
        start: pointInCanvas(event, mapCanvas),
        pointerId: event.pointerId,
        initialRect: projectedScreenRect(map, region),
        initialRegion: region
      });
      return true;
    },
    []
  );

  const applyTransformedRegion = useCallback((region: RegionBounds | null) => {
    if (region) optionsRef.current.onRegionChange(region);
    setSelectionError(region ? null : DATE_LINE_CROSSING_MESSAGE);
  }, []);

  const transformWithKeyboard = useCallback(
    (transform: RegionTransform, event: ReactKeyboardEvent<HTMLButtonElement>, region: RegionBounds) => {
      const { map, mapCanvas } = optionsRef.current;
      if (!map || !mapCanvas) return false;
      const delta = keyboardDelta(event.key, event.shiftKey, transform);
      if (!delta) return false;
      event.preventDefault();
      event.stopPropagation();
      optionsRef.current.onBeginInteraction();
      const nextRegion = regionAfterTransform(
        map,
        projectedScreenRect(map, region),
        delta,
        transform,
        mapCanvas.getBoundingClientRect()
      );
      applyTransformedRegion(nextRegion);
      return true;
    },
    [applyTransformedRegion]
  );

  const clearSelectionError = useCallback(() => setSelectionError(null), []);
  const reportInvalidSelection = useCallback(() => setSelectionError(DATE_LINE_CROSSING_MESSAGE), []);

  useEffect(() => {
    if (active?.kind !== "draw" || !map || !mapCanvas || !notifyDrawingWhenReadyRef.current) return;
    notifyDrawingWhenReadyRef.current = false;
    optionsRef.current.onBeginInteraction();
  }, [active?.kind, map, mapCanvas]);

  useEffect(() => {
    return () => {
      const interaction = activeRef.current;
      if (interaction) {
        releasePointer(interaction.pointerId, optionsRef.current.unmountReleaseClickSuppression ?? "if-captured");
      }
    };
  }, [releasePointer]);

  useEffect(() => {
    if (!active) return;
    const cancelKeyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || optionsRef.current.escapeBlocked(event)) return;
      event.preventDefault();
      event.stopPropagation();
      cancelActive(active, "keyboard", "always", true);
    };
    window.addEventListener("keydown", cancelKeyboard, { capture: true });
    return () => window.removeEventListener("keydown", cancelKeyboard, { capture: true });
  }, [active, cancelActive]);

  useEffect(() => {
    if (!map || !mapCanvas || !active) return;

    const startDrawing = (event: globalThis.PointerEvent) => {
      if (active.kind !== "draw" || active.start || event.button !== 0) return;
      if (
        event.target instanceof Element &&
        event.target.closest(".maplibregl-control-container, [data-map-interaction-control]")
      )
        return;
      if (event.shiftKey) {
        optionsRef.current.onShiftPointerDown?.();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      optionsRef.current.onBeginInteraction();
      mapCanvas.setPointerCapture?.(event.pointerId);
      const point = pointInCanvas(event, mapCanvas);
      setSelectionError(null);
      setActive({ ...active, start: point, current: point, pointerId: event.pointerId });
    };

    const updateInteraction = (event: globalThis.PointerEvent) => {
      if (active.pointerId === null || event.pointerId !== active.pointerId) return;
      const point = pointInCanvas(event, mapCanvas);
      if (active.kind === "draw") {
        if (active.start) setActive({ ...active, current: point });
        return;
      }
      const nextRegion = regionAfterTransform(
        map,
        active.initialRect,
        { x: point.x - active.start.x, y: point.y - active.start.y },
        active.transform,
        mapCanvas.getBoundingClientRect()
      );
      applyTransformedRegion(nextRegion);
    };

    const finishInteraction = (event: globalThis.PointerEvent) => {
      if (active.pointerId === null || event.pointerId !== active.pointerId) return;
      releasePointer(
        active.pointerId,
        event.target instanceof Node && mapCanvas.contains(event.target) ? "always" : false
      );
      if (active.kind === "transform") {
        notifyDrawingWhenReadyRef.current = false;
        setActive(null);
        return;
      }
      if (!active.start) return;
      const rect = rectFromPoints(active.start, pointInCanvas(event, mapCanvas));
      let result: RegionDrawResult;
      if (rect.width < MIN_REGION_SIZE || rect.height < MIN_REGION_SIZE) {
        result = { kind: "undersized", initialRegion: active.initialRegion };
      } else {
        const region = regionFromScreenRect(map, rect);
        result = region
          ? { kind: "complete", region, initialRegion: active.initialRegion }
          : { kind: "invalid", initialRegion: active.initialRegion };
      }
      setSelectionError(result.kind === "invalid" ? DATE_LINE_CROSSING_MESSAGE : null);
      const disposition = optionsRef.current.onDrawResult(result);
      notifyDrawingWhenReadyRef.current = false;
      setActive(
        disposition === "continue" && result.kind === "invalid"
          ? { kind: "draw", start: null, current: null, pointerId: null, initialRegion: active.initialRegion }
          : null
      );
    };

    const cancelPointer = (event: globalThis.PointerEvent) => {
      if (active.pointerId === null || event.pointerId !== active.pointerId) {
        if (active.pointerId === null) optionsRef.current.onPointerCancelWithoutInteraction?.();
        return;
      }
      cancelActive(active, "pointer", false, true);
    };

    const controller = new AbortController();
    const { signal } = controller;
    mapCanvas.classList.toggle("map-canvas--region-drawing", active.kind === "draw");
    mapCanvas.addEventListener("pointerdown", startDrawing, { capture: true, signal });
    window.addEventListener("pointermove", updateInteraction, { signal });
    window.addEventListener("pointerup", finishInteraction, { signal });
    window.addEventListener("pointercancel", cancelPointer, { signal });
    window.addEventListener("mouseup", () => optionsRef.current.onWindowMouseUp?.(), { signal });
    return () => {
      mapCanvas.classList.remove("map-canvas--region-drawing");
      controller.abort();
    };
  }, [active, applyTransformedRegion, cancelActive, map, mapCanvas, releasePointer]);

  const drawingRect =
    active?.kind === "draw" && active.start && active.current ? rectFromPoints(active.start, active.current) : null;

  return {
    activeKind: active?.kind,
    drawing: active?.kind === "draw",
    drawingRect,
    selectionError,
    clearSelectionError,
    reportInvalidSelection,
    beginDrawing,
    cancelInteraction,
    beginTransform,
    transformWithKeyboard
  };
}
