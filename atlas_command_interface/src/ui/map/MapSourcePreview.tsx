import { type Map as MlMap, type StyleSpecification } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import { Button, IconButton } from "../primitives/controls.js";
import { CloseIcon } from "../primitives/icons.js";
import type { MapLibreRuntime } from "./runtime/maplibre-runtime.js";
import type { MapViewport } from "./view/MapView.js";
import { cloneStyle, webglAvailable } from "./view/map-view-utils.js";
import "./MapSourcePreview.css";

type PreviewSource = {
  id: string;
  label: string;
  style: StyleSpecification;
};

type MapSourcePreviewProps = {
  source: PreviewSource;
  viewport?: MapViewport;
  onCommit: () => void;
  onDismiss: () => void;
};

type PreviewStatus = "loading" | "slow" | "ready" | "error";

export function MapSourcePreview({ source, viewport, onCommit, onDismiss }: MapSourcePreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | undefined>(undefined);
  const viewportRef = useRef(viewport);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<PreviewStatus>("loading");
  const [error, setError] = useState<string>();
  viewportRef.current = viewport;
  const canCreateMap = viewport !== undefined;
  const previewLabel = viewport ? `Preview · Z${viewport.zoom.toFixed(1)}` : "Preview";

  useEffect(() => {
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onDismiss();
    };
    window.addEventListener("keydown", dismissOnEscape);
    return () => window.removeEventListener("keydown", dismissOnEscape);
  }, [onDismiss]);

  useEffect(() => {
    if (!canCreateMap || !containerRef.current) return;
    if (!webglAvailable()) {
      setStatus("error");
      setError("MapLibre WebGL renderer is unavailable");
      return;
    }

    let map: MlMap | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let cancelled = false;
    let loaded = false;
    const slowTimer = window.setTimeout(() => {
      if (!cancelled && !loaded) setStatus("slow");
    }, 2_000);
    setStatus("loading");
    setError(undefined);

    const initializeMap = (maplibre: MapLibreRuntime) => {
      const initialViewport = viewportRef.current;
      if (cancelled || !containerRef.current || !initialViewport) return;
      try {
        map = new maplibre.Map({
          container: containerRef.current,
          style: cloneStyle(source.style),
          center: initialViewport.center,
          zoom: initialViewport.zoom,
          bearing: initialViewport.bearing,
          pitch: initialViewport.pitch,
          interactive: false,
          renderWorldCopies: false,
          attributionControl: false
        });
      } catch (cause) {
        window.clearTimeout(slowTimer);
        setStatus("error");
        setError(sanitizeConnectionError(cause));
        return;
      }

      const mapInstance = map;
      mapRef.current = mapInstance;
      mapInstance.addControl(new maplibre.AttributionControl({ compact: false }), "bottom-right");
      resizeObserver = new ResizeObserver(() => mapInstance.resize());
      resizeObserver.observe(containerRef.current);
      mapInstance.on("load", () => {
        if (cancelled) return;
        loaded = true;
        window.clearTimeout(slowTimer);
        setStatus("ready");
      });
      mapInstance.on("error", (event) => {
        if (cancelled || loaded) return;
        window.clearTimeout(slowTimer);
        setStatus("error");
        setError(sanitizeConnectionError(event.error));
      });
    };

    void import("./runtime/maplibre-runtime.js")
      .then(({ getMapLibreRuntime, loadMapLibre }) => getMapLibreRuntime() ?? loadMapLibre())
      .then(initializeMap)
      .catch((cause: unknown) => {
        if (cancelled) return;
        window.clearTimeout(slowTimer);
        setStatus("error");
        setError(sanitizeConnectionError(cause));
      });

    return () => {
      cancelled = true;
      window.clearTimeout(slowTimer);
      resizeObserver?.disconnect();
      map?.remove();
      if (mapRef.current === map) mapRef.current = undefined;
    };
  }, [attempt, canCreateMap, source.id, source.style]);

  useEffect(() => {
    if (!viewport) return;
    mapRef.current?.jumpTo({
      center: viewport.center,
      zoom: viewport.zoom,
      bearing: viewport.bearing,
      pitch: viewport.pitch
    });
  }, [viewport]);

  return (
    <section className="map-source-preview" aria-label={`${source.label} map preview`}>
      <header className="map-source-preview__header">
        <div className="map-source-preview__identity">
          <h2>{source.label}</h2>
          <span className="map-source-preview__meta">{previewLabel}</span>
        </div>
        <div className="map-source-preview__header-actions">
          <Button
            className="map-source-preview__use"
            variant="primary"
            aria-label={`Use ${source.label}`}
            disabled={status !== "ready"}
            onClick={onCommit}
          >
            Use
          </Button>
          <IconButton className="map-source-preview__dismiss" label="Dismiss map preview" onClick={onDismiss}>
            <CloseIcon size={12} />
          </IconButton>
        </div>
      </header>
      <div className="map-source-preview__map">
        <div className="map-source-preview__host" ref={containerRef} />
        {!viewport ? (
          <div className="map-source-preview__state" role="status">
            Reading current view…
          </div>
        ) : status === "loading" ? (
          <div className="map-source-preview__state" role="status">
            Loading tiles…
          </div>
        ) : status === "slow" ? (
          <div className="map-source-preview__state" role="status">
            <strong>Still loading</strong>
            <span>Waiting for {source.label} tiles.</span>
          </div>
        ) : status === "error" ? (
          <div className="map-source-preview__state map-source-preview__state--error" role="alert">
            <strong>Preview unavailable</strong>
            <code>{error}</code>
            <Button className="map-source-preview__retry" onClick={() => setAttempt((current) => current + 1)}>
              Retry
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
