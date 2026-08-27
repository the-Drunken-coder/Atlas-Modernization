import type { Map as MlMap, StyleSpecification } from "maplibre-gl";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { sanitizeConnectionError } from "../../../atlas/connection-error.js";
import {
  boundsForGeometry,
  CAMERA_EVENT_TAG,
  type MapTarget,
  PREVIEW_FIT_MAX_ZOOM,
  PREVIEW_POINT_ZOOM
} from "../interaction/map-camera.js";
import { getMapLibreRuntime, loadMapLibre, type MapLibreRuntime } from "../runtime/maplibre-runtime.js";
import { cloneStyle, webglAvailable } from "./map-view-utils.js";

type PlaceDetailLensProps = {
  target: MapTarget;
  style: StyleSpecification;
};

const DETAIL_PADDING = 28;
const lensStyle = {
  position: "absolute",
  right: 12,
  bottom: 56,
  zIndex: 24,
  width: "min(320px, calc(100% - 24px))",
  height: "min(200px, 28vh)",
  overflow: "hidden",
  border: "1px solid var(--border-strong)",
  background: "var(--bg-base)",
  boxShadow: "var(--shadow-panel)",
  pointerEvents: "auto"
} satisfies CSSProperties;
const mapStyle = { position: "absolute", inset: 0, width: "100%", height: "100%" } satisfies CSSProperties;
const labelStyle = {
  position: "absolute",
  top: 8,
  left: 8,
  zIndex: 2,
  display: "grid",
  maxWidth: "calc(100% - 16px)",
  padding: "6px 8px",
  borderLeft: "2px solid var(--accent-strong)",
  background: "color-mix(in srgb, var(--surface-1) 94%, transparent)"
} satisfies CSSProperties;
const labelKindStyle = {
  color: "var(--text-3)",
  fontFamily: "var(--font-mono)",
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.1em",
  lineHeight: 1.4,
  textTransform: "uppercase"
} satisfies CSSProperties;
const labelNameStyle = {
  overflow: "hidden",
  color: "var(--text-1)",
  fontSize: 11,
  lineHeight: 1.35,
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
} satisfies CSSProperties;
const reticleStyle = {
  position: "absolute",
  top: "50%",
  left: "50%",
  zIndex: 2,
  width: 24,
  height: 24,
  border: "2px solid var(--accent-strong)",
  boxShadow: "0 0 0 1px color-mix(in srgb, black 58%, transparent)",
  transform: "translate(-50%, -50%)"
} satisfies CSSProperties;
const reticleLineStyle = {
  position: "absolute",
  background: "var(--accent-strong)"
} satisfies CSSProperties;
const statusStyle = {
  position: "absolute",
  inset: 0,
  zIndex: 1,
  display: "grid",
  placeItems: "center",
  background: "var(--surface-1)",
  color: "var(--text-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase"
} satisfies CSSProperties;

/** A noninteractive local map for browsing search results without moving the operator's main camera. */
export function PlaceDetailLens({ target, style }: PlaceDetailLensProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | undefined>(undefined);
  const initialStyleRef = useRef(style);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!containerRef.current) return;
    if (!webglAvailable()) {
      setError("MapLibre WebGL renderer is unavailable");
      return;
    }

    let map: MlMap | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let cancelled = false;
    const initializeMap = (maplibre: MapLibreRuntime) => {
      if (cancelled || !containerRef.current) return;
      try {
        map = new maplibre.Map({
          container: containerRef.current,
          style: cloneStyle(initialStyleRef.current),
          center: [0, 0],
          zoom: 0,
          interactive: false,
          renderWorldCopies: false,
          keyboard: false,
          dragRotate: false,
          pitchWithRotate: false,
          attributionControl: false
        });
      } catch (mapError) {
        setError(sanitizeConnectionError(mapError));
        return;
      }

      const mapInstance = map;
      mapRef.current = mapInstance;
      mapInstance.addControl(new maplibre.AttributionControl({ compact: true }), "bottom-left");
      const markReady = () => setReady(true);
      mapInstance.on("style.load", markReady);
      if (mapInstance.isStyleLoaded()) markReady();

      resizeObserver = new ResizeObserver(() => mapInstance.resize({ [CAMERA_EVENT_TAG]: true }));
      resizeObserver.observe(containerRef.current);
      requestAnimationFrame(() => mapInstance.resize({ [CAMERA_EVENT_TAG]: true }));
    };

    const maplibre = getMapLibreRuntime();
    if (maplibre) {
      initializeMap(maplibre);
    } else {
      void loadMapLibre()
        .then(initializeMap)
        .catch((mapError: unknown) => {
          if (!cancelled) setError(sanitizeConnectionError(mapError));
        });
    }

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      map?.remove();
      mapRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (target.type === "point") {
      map.jumpTo({ center: target.coordinates, zoom: PREVIEW_POINT_ZOOM }, { [CAMERA_EVENT_TAG]: true });
      return;
    }
    if (target.type !== "geometry") return;
    const bounds = boundsForGeometry(target.geometry);
    if (!bounds) return;
    map.fitBounds(
      bounds,
      { padding: DETAIL_PADDING, maxZoom: PREVIEW_FIT_MAX_ZOOM, duration: 0 },
      { [CAMERA_EVENT_TAG]: true }
    );
  }, [ready, target]);

  const label = target.type === "entity" ? "Place detail" : (target.label ?? "Place detail");
  return (
    <section className="place-detail-lens" style={lensStyle} aria-label={`Local detail for ${label}`}>
      <div ref={containerRef} style={mapStyle} aria-hidden="true" />
      <div style={labelStyle}>
        <span style={labelKindStyle}>Local detail</span>
        <strong style={labelNameStyle}>{label}</strong>
      </div>
      {ready && !error ? (
        <div style={reticleStyle} aria-hidden="true">
          <span
            style={{ ...reticleLineStyle, top: "50%", left: -7, width: 34, height: 2, transform: "translateY(-50%)" }}
          />
          <span
            style={{ ...reticleLineStyle, top: -7, left: "50%", width: 2, height: 34, transform: "translateX(-50%)" }}
          />
        </div>
      ) : null}
      {!ready && !error ? (
        <div style={statusStyle} role="status">
          Loading detail
        </div>
      ) : null}
      {error ? (
        <div style={statusStyle} role="status">
          Place detail unavailable
        </div>
      ) : null}
    </section>
  );
}
