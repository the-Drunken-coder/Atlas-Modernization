import type * as maplibregl from "maplibre-gl";
import type { Map as MlMap } from "maplibre-gl";
import {
  addVertexAfter,
  displayGeometry,
  geometryVertices,
  midpointPosition,
  moveVertex,
  type Position,
  removeVertex,
  type UiGeometry,
  type VertexRef
} from "../../../atlas/geometry.js";
import type { MapLibreRuntime } from "../runtime/maplibre-runtime.js";
import { emptyFeatureCollection } from "./map-sources.js";

export type MapEditing = {
  geometry: UiGeometry;
  onChange: (geometry: UiGeometry) => void;
};

type Midpoint = { position: Position; afterRef: VertexRef };

const KEYBOARD_MOVE_STEP = 10;
const KEYBOARD_MOVE_SHIFT_STEP = 40;

export function createEditingMarkers(
  map: MlMap,
  editing: MapEditing | undefined,
  MarkerConstructor: MapLibreRuntime["Marker"]
): InstanceType<MapLibreRuntime["Marker"]>[] {
  const overlay = map.getSource("editing") as maplibregl.GeoJSONSource | undefined;
  if (!editing) {
    overlay?.setData(emptyFeatureCollection());
    return [];
  }

  overlay?.setData({
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: displayGeometry(editing.geometry), properties: {} }]
  });

  const markers: InstanceType<MapLibreRuntime["Marker"]>[] = [];
  const { geometry, onChange } = editing;
  for (const [vertexIndex, vertex] of geometryVertices(geometry).entries()) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "vertex-handle";
    element.title = "Drag to move; use arrow keys to move; press Delete or right-click to remove";
    element.setAttribute("aria-label", vertexLabel(geometry, vertexIndex));
    element.setAttribute("data-map-interaction-control", "");
    element.dataset.vertexKey = vertexKey(vertex.ref);
    const marker = new MarkerConstructor({ element, draggable: true }).setLngLat([vertex.lng, vertex.lat]).addTo(map);
    marker.on("dragend", () => {
      const next = marker.getLngLat();
      onChange(moveVertex(geometry, vertex.ref, next.lng, next.lat));
    });
    element.addEventListener("keydown", (event) => {
      const delta = vertexKeyboardDelta(event.key, event.shiftKey ? KEYBOARD_MOVE_SHIFT_STEP : KEYBOARD_MOVE_STEP);
      if (delta) {
        event.preventDefault();
        event.stopPropagation();
        const current = marker.getLngLat();
        const projected = map.project([current.lng, current.lat]);
        const next = map.unproject([projected.x + delta.x, projected.y + delta.y]);
        const lng = clamp(next.lng, -180, 180);
        const lat = clamp(next.lat, -90, 90);
        if (!Number.isFinite(lng) || !Number.isFinite(lat) || (lng === current.lng && lat === current.lat)) return;
        marker.setLngLat([lng, lat]);
        onChange(moveVertex(geometry, vertex.ref, lng, lat));
        return;
      }

      if (event.key !== "Delete") return;
      event.preventDefault();
      event.stopPropagation();
      const next = removeVertex(geometry, vertex.ref);
      if (next) onChange(next);
    });
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = removeVertex(geometry, vertex.ref);
      if (next) onChange(next);
    });
    markers.push(marker);
  }

  for (const mid of midpoints(geometry)) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "vertex-handle vertex-handle--mid";
    element.title = "Click to add a vertex";
    element.setAttribute("aria-label", "Add vertex");
    element.setAttribute("data-map-interaction-control", "");
    const marker = new MarkerConstructor({ element, draggable: false })
      .setLngLat([mid.position[0], mid.position[1]])
      .addTo(map);
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      onChange(addVertexAfter(geometry, mid.afterRef, mid.position));
    });
    markers.push(marker);
  }
  return markers;
}

function vertexLabel(geometry: UiGeometry, index: number): string {
  if (geometry.type === "Feature") return "Move center";
  if (geometry.type === "Point") return "Move point";
  return `Move vertex ${index + 1}`;
}

function vertexKey(ref: VertexRef): string {
  if (ref.kind === "Point") return "point";
  if (ref.kind === "Circle") return "circle";
  if (ref.kind === "LineString") return `line-${ref.index}`;
  return `polygon-${ref.ring}-${ref.index}`;
}

function vertexKeyboardDelta(key: string, step: number): { x: number; y: number } | undefined {
  if (key === "ArrowLeft") return { x: -step, y: 0 };
  if (key === "ArrowRight") return { x: step, y: 0 };
  if (key === "ArrowUp") return { x: 0, y: -step };
  if (key === "ArrowDown") return { x: 0, y: step };
  return undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function midpoints(geometry: UiGeometry): Midpoint[] {
  if (geometry.type === "Point" || geometry.type === "Feature") return [];
  const result: Midpoint[] = [];
  if (geometry.type === "LineString") {
    for (let index = 0; index < geometry.coordinates.length - 1; index++) {
      result.push(
        midpoint(geometry.coordinates[index], geometry.coordinates[index + 1], { kind: "LineString", index })
      );
    }
    return result;
  }
  for (const [ringIndex, ring] of geometry.coordinates.entries()) {
    const open = openRing(ring);
    for (let index = 0; index < open.length; index++) {
      const next = open[(index + 1) % open.length];
      if (!next) continue;
      result.push(midpoint(open[index], next, { kind: "Polygon", ring: ringIndex, index }));
    }
  }
  return result;
}

function midpoint(current: Position, next: Position, afterRef: VertexRef): Midpoint {
  return { position: midpointPosition(current, next), afterRef };
}

function openRing(ring: Position[]): Position[] {
  if (ring.length >= 2 && positionsEqual(ring[0], ring[ring.length - 1])) {
    return ring.slice(0, -1);
  }
  return [...ring];
}

function positionsEqual(a: Position | undefined, b: Position | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}
