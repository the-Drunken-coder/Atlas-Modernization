import {
  isMapArea,
  type MapArea,
  type SpatialFeature,
  type SpatialOperationResult
} from "@the-drunken-coder/atlas-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import { createAuthenticatedAtlasClient } from "../../auth/atlas.js";
import { foregroundEscapeOwner } from "../../ui/map/interaction/foreground-escape-owner.js";

export type SpatialOperationTarget = {
  pluginId: string;
  pluginName: string;
  operationId: string;
  operationName: string;
};

export type SpatialOperationExecutor = {
  invokeSpatial(
    pluginId: string,
    operationId: string,
    area: MapArea,
    options?: { signal?: AbortSignal }
  ): Promise<SpatialOperationResult>;
};

export type SpatialOperationRunner = {
  target?: SpatialOperationTarget;
  area: MapArea | null;
  viewportArea: MapArea | null;
  result: SpatialOperationResult | null;
  selectedFeature?: SpatialFeature;
  status: "idle" | "drawing" | "loading" | "ready" | "error";
  stale: boolean;
  error?: string;
  selectTarget(target: SpatialOperationTarget): void;
  refreshTarget(target: SpatialOperationTarget): void;
  closeTarget(): void;
  beginDrawing(): void;
  cancelDrawing(): void;
  setArea(area: MapArea): void;
  setViewportArea(area: MapArea | null): void;
  useCurrentView(): void;
  search(): Promise<void>;
  retry(): Promise<void>;
  cancel(): void;
  clear(): void;
  selectFeature(id: string): void;
};

export function useSpatialOperationRunner({
  baseUrl,
  executor: suppliedExecutor
}: {
  baseUrl?: string;
  executor?: SpatialOperationExecutor;
}): SpatialOperationRunner {
  const executor = useMemo<SpatialOperationExecutor | undefined>(
    () =>
      suppliedExecutor ??
      (baseUrl
        ? createAuthenticatedAtlasClient(baseUrl, { sync: false, requestTimeoutMs: 25_000 }).plugins
        : undefined),
    [baseUrl, suppliedExecutor]
  );
  const [target, setTarget] = useState<SpatialOperationTarget>();
  const [area, setAreaState] = useState<MapArea | null>(null);
  const [viewportArea, setViewportAreaState] = useState<MapArea | null>(null);
  const [result, setResult] = useState<SpatialOperationResult | null>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string>();
  const [status, setStatus] = useState<SpatialOperationRunner["status"]>("idle");
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string>();
  const requestRef = useRef<AbortController | undefined>(undefined);

  const abortRequest = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = undefined;
  }, []);

  useEffect(() => abortRequest, [abortRequest]);

  const selectTarget = useCallback(
    (next: SpatialOperationTarget) => {
      abortRequest();
      setTarget(next);
      setAreaState(null);
      setResult(null);
      setSelectedFeatureId(undefined);
      setStatus("idle");
      setStale(false);
      setError(undefined);
    },
    [abortRequest]
  );

  const refreshTarget = useCallback((next: SpatialOperationTarget) => {
    setTarget((current) => {
      if (!current || current.pluginId !== next.pluginId || current.operationId !== next.operationId) return current;
      if (current.pluginName === next.pluginName && current.operationName === next.operationName) return current;
      return next;
    });
  }, []);

  const closeTarget = useCallback(() => {
    abortRequest();
    setTarget(undefined);
    setAreaState(null);
    setResult(null);
    setSelectedFeatureId(undefined);
    setStatus("idle");
    setStale(false);
    setError(undefined);
  }, [abortRequest]);

  const setArea = useCallback(
    (next: MapArea) => {
      abortRequest();
      if (!isMapArea(next)) {
        setStatus("error");
        setStale(result !== null);
        setError("Select a non-crossing area no larger than 5 km².");
        return;
      }
      setAreaState(next);
      setStatus("idle");
      setStale(result !== null);
      setError(undefined);
    },
    [abortRequest, result]
  );

  const beginDrawing = useCallback(() => {
    abortRequest();
    setStatus("drawing");
    setError(undefined);
  }, [abortRequest]);

  const cancelDrawing = useCallback(() => {
    setStatus((current) => (current === "drawing" ? "idle" : current));
  }, []);

  const useCurrentView = useCallback(() => {
    if (!viewportArea) {
      setError("The current map view is unavailable.");
      setStatus("error");
      return;
    }
    if (!isMapArea(viewportArea)) {
      setError("Zoom in until the current view is a non-crossing area no larger than 5 km².");
      setStatus("error");
      return;
    }
    setArea(viewportArea);
  }, [setArea, viewportArea]);

  const search = useCallback(async () => {
    if (!executor || !target) {
      setError("This operation is unavailable.");
      setStatus("error");
      return;
    }
    if (!area || !isMapArea(area)) {
      setError("Select a non-crossing area no larger than 5 km².");
      setStatus("error");
      return;
    }

    abortRequest();
    const controller = new AbortController();
    requestRef.current = controller;
    setStatus("loading");
    setError(undefined);
    setStale(result !== null);
    try {
      const next = await executor.invokeSpatial(target.pluginId, target.operationId, area, {
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      setResult(next);
      setSelectedFeatureId(next.features[0]?.id);
      setStatus("ready");
      setStale(false);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setStatus("error");
      setStale(result !== null);
      setError(sanitizeConnectionError(cause));
    } finally {
      if (requestRef.current === controller) requestRef.current = undefined;
    }
  }, [abortRequest, area, executor, result, target]);

  const cancel = useCallback(() => {
    if (status === "drawing") {
      cancelDrawing();
      return;
    }
    if (status !== "loading") return;
    abortRequest();
    setStatus("idle");
    setStale(result !== null);
  }, [abortRequest, cancelDrawing, result, status]);

  const clear = useCallback(() => {
    abortRequest();
    setAreaState(null);
    setResult(null);
    setSelectedFeatureId(undefined);
    setStatus("idle");
    setStale(false);
    setError(undefined);
  }, [abortRequest]);

  useEffect(() => {
    if (status !== "drawing" && status !== "loading") return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const owner = foregroundEscapeOwner(event.target);
      if (owner && !owner.matches("[data-spatial-operation]")) return;
      event.preventDefault();
      if (status === "drawing") event.stopPropagation();
      cancel();
    };
    const capture = status === "drawing";
    window.addEventListener("keydown", handleEscape, { capture });
    return () => window.removeEventListener("keydown", handleEscape, { capture });
  }, [cancel, status]);

  return {
    target,
    area,
    viewportArea,
    result,
    selectedFeature: result?.features.find((feature) => feature.id === selectedFeatureId),
    status,
    stale,
    error,
    selectTarget,
    refreshTarget,
    closeTarget,
    beginDrawing,
    cancelDrawing,
    setArea,
    setViewportArea: setViewportAreaState,
    useCurrentView,
    search,
    retry: search,
    cancel,
    clear,
    selectFeature: setSelectedFeatureId
  };
}
