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
  for (const vertex of geometryVertices(geometry)) {
    const element = document.createElement("div");
    element.className = "vertex-handle";
    element.title = "Drag to move - right-click to remove";
    const marker = new MarkerConstructor({ element, draggable: true }).setLngLat([vertex.lng, vertex.lat]).addTo(map);
    marker.on("dragend", () => {
      const next = marker.getLngLat();
      onChange(moveVertex(geometry, vertex.ref, next.lng, next.lat));
    });
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
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
