import type { Map as MlMap } from "maplibre-gl";
import { useEffect, useReducer, useState } from "react";
import { createPortal } from "react-dom";
import type { Position } from "../../../atlas/geometry.js";

export type GeofeatureDrawing = {
  onPoint: (position: Position) => void;
  points?: readonly Position[];
  polygon?: boolean;
  onClose?: () => void;
};

export function MapGeofeatureDrawing({ map, drawing }: { map: MlMap; drawing: GeofeatureDrawing }) {
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [, redraw] = useReducer((version: number) => version + 1, 0);
  useEffect(() => {
    map.on("move", redraw);
    map.on("resize", redraw);
    return () => {
      map.off("move", redraw);
      map.off("resize", redraw);
    };
  }, [map]);

  const points = drawing.points ?? [];
  const first = points[0] ? map.project([points[0][0], points[0][1]]) : undefined;
  const lastPoint = points.at(-1);
  const last = lastPoint ? map.project([lastPoint[0], lastPoint[1]]) : undefined;
  const preview =
    cursor && last ? [last, cursor, ...(drawing.polygon && first && points.length >= 2 ? [first] : [])] : [];

  // Keep wheel and pinch events inside MapLibre's native zoom event container.
  return createPortal(
    <div
      className="geofeature-drawing"
      data-map-interaction-control
      data-testid="geofeature-drawing"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => {
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        setCursor({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      }}
      onPointerLeave={() => setCursor(null)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.detail > 1) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const point = map.unproject([event.clientX - bounds.left, event.clientY - bounds.top]);
        drawing.onPoint([((((point.lng + 180) % 360) + 360) % 360) - 180, Math.max(-90, Math.min(90, point.lat))]);
      }}
    >
      <svg aria-hidden="true">
        <polyline points={preview.map((point) => `${point.x},${point.y}`).join(" ")} />
      </svg>
      {first && drawing.onClose ? (
        <button
          type="button"
          className="geofeature-drawing__close"
          aria-label="Close polygon"
          title="Close polygon"
          style={{ left: first.x, top: first.y }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            drawing.onClose?.();
          }}
        />
      ) : null}
    </div>,
    map.getCanvasContainer()
  );
}
