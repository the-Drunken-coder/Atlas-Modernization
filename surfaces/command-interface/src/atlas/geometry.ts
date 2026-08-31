// GeoJSON coordinates use [longitude, latitude].

import {
  type GeoJSONCircleFeature,
  type GeoJSONLineString,
  type GeoJSONMultiPolygon,
  type GeoJSONPoint,
  type GeoJSONPolygon,
  type GeoJSONPosition,
  type GeometryComponent,
  isGeometryComponent
} from "@the-drunken-coder/atlas-sdk";

export type Position = GeoJSONPosition;
export type UiPoint = GeoJSONPoint;
export type UiLineString = GeoJSONLineString;
export type UiPolygon = GeoJSONPolygon;
export type UiMultiPolygon = GeoJSONMultiPolygon;
export type UiRawGeometry = UiPoint | UiLineString | UiPolygon | UiMultiPolygon;
export type UiCircleFeature = GeoJSONCircleFeature;
export type UiGeometry = GeometryComponent;

export type VertexRef =
  | { kind: "Point" }
  | { kind: "Circle" }
  | { kind: "LineString"; index: number }
  | { kind: "Polygon"; ring: number; index: number };

export type EditableVertex = {
  ref: VertexRef;
  lng: number;
  lat: number;
};

export type GeometryValidity = { valid: true } | { valid: false; reason: string };

const COORDINATE_EPSILON = 1e-9;
const EARTH_RADIUS_M = 6_371_008.8;
const CIRCLE_DISPLAY_SEGMENTS = 64;

/**
 * Return a supported entity geometry in the shape the UI edits, or undefined
 * when the geometry is absent or unsupported.
 */
export function toUiGeometry(value: unknown): UiGeometry | undefined {
  return isGeometryComponent(value) ? value : undefined;
}

/** A representative [lng, lat] point used to place markers and recenter the map. */
export function representativePoint(geometry: UiGeometry): Position | undefined {
  if (isCircleFeature(geometry)) return geometry.geometry.coordinates;
  if (geometry.type === "Point") return geometry.coordinates;
  if (geometry.type === "LineString") return geometry.coordinates[0];
  return geometry.coordinates[0]?.[0];
}

export function displayGeometry(geometry: UiGeometry): UiRawGeometry {
  return isCircleFeature(geometry) ? circleFeaturePolygon(geometry) : geometry;
}

export function isCircleFeature(geometry: UiGeometry): geometry is UiCircleFeature {
  return geometry.type === "Feature" && geometry.properties.shape === "circle";
}

export function updateCircleRadius(geometry: UiCircleFeature, radius_m: number): UiCircleFeature {
  return { ...geometry, properties: { shape: "circle", radius_m } };
}

/** Editable vertices, excluding a polygon ring's repeated closing coordinate. */
export function geometryVertices(geometry: UiGeometry): EditableVertex[] {
  if (isCircleFeature(geometry)) {
    const [lng, lat] = geometry.geometry.coordinates;
    return [{ ref: { kind: "Circle" }, lng, lat }];
  }
  if (geometry.type === "Point") {
    return [{ ref: { kind: "Point" }, lng: geometry.coordinates[0], lat: geometry.coordinates[1] }];
  }
  if (geometry.type === "LineString") {
    return geometry.coordinates.map((position, index) => ({
      ref: { kind: "LineString", index },
      lng: position[0],
      lat: position[1]
    }));
  }
  return geometry.coordinates.flatMap((ring, ringIndex) =>
    openRing(ring).map((position, index) => ({
      ref: { kind: "Polygon", ring: ringIndex, index },
      lng: position[0],
      lat: position[1]
    }))
  );
}

export function moveVertex(geometry: UiGeometry, ref: VertexRef, lng: number, lat: number): UiGeometry {
  if (isCircleFeature(geometry) && ref.kind === "Circle") {
    return {
      ...geometry,
      geometry: { type: "Point", coordinates: movePosition(geometry.geometry.coordinates, lng, lat) }
    };
  }
  if (geometry.type === "Point" && ref.kind === "Point") {
    return { type: "Point", coordinates: movePosition(geometry.coordinates, lng, lat) };
  }
  if (geometry.type === "LineString" && ref.kind === "LineString") {
    const coordinates = geometry.coordinates.map((position, index) =>
      index === ref.index ? movePosition(position, lng, lat) : position
    );
    return { type: "LineString", coordinates };
  }
  if (geometry.type === "Polygon" && ref.kind === "Polygon") {
    const coordinates = geometry.coordinates.map((ring, ringIndex) =>
      ringIndex === ref.ring ? moveRingVertex(ring, ref.index, lng, lat) : ring
    );
    return { type: "Polygon", coordinates };
  }
  return geometry;
}

/** Insert a complete position immediately after the referenced vertex. No-op for points. */
export function addVertexAfter(geometry: UiGeometry, ref: VertexRef, position: Position): UiGeometry {
  const next: Position = [...position];
  if (geometry.type === "LineString" && ref.kind === "LineString") {
    const coordinates = [...geometry.coordinates];
    coordinates.splice(ref.index + 1, 0, next);
    return { type: "LineString", coordinates };
  }
  if (geometry.type === "Polygon" && ref.kind === "Polygon") {
    const coordinates = geometry.coordinates.map((ring, ringIndex) => {
      if (ringIndex !== ref.ring) return ring;
      const open = openRing(ring);
      open.splice(ref.index + 1, 0, next);
      return closeRing(open);
    });
    return { type: "Polygon", coordinates };
  }
  return geometry;
}

/** Midpoint along the shortest longitude path, retaining dimensions shared by both positions. */
export function midpointPosition(current: Position, next: Position): Position {
  const longitudeDelta = normalizeLongitude(next[0] - current[0]);
  const midpoint: number[] = [normalizeLongitude(current[0] + longitudeDelta / 2), (current[1] + next[1]) / 2];
  for (let index = 2; index < Math.min(current.length, next.length); index++) {
    midpoint.push((current[index] + next[index]) / 2);
  }
  return midpoint as Position;
}

export function canRemoveVertex(geometry: UiGeometry, ref: VertexRef): boolean {
  if (geometry.type === "LineString" && ref.kind === "LineString") {
    return geometry.coordinates.length > 2;
  }
  if (geometry.type === "Polygon" && ref.kind === "Polygon") {
    const ring = geometry.coordinates[ref.ring];
    return ring !== undefined && openRing(ring).length > 3;
  }
  return false;
}

/** Remove a vertex, or return undefined when removal would break validity. */
export function removeVertex(geometry: UiGeometry, ref: VertexRef): UiGeometry | undefined {
  if (!canRemoveVertex(geometry, ref)) return undefined;
  if (geometry.type === "LineString" && ref.kind === "LineString") {
    return { type: "LineString", coordinates: geometry.coordinates.filter((_, index) => index !== ref.index) };
  }
  if (geometry.type === "Polygon" && ref.kind === "Polygon") {
    const coordinates = geometry.coordinates.map((ring, ringIndex) => {
      if (ringIndex !== ref.ring) return ring;
      const open = openRing(ring).filter((_, index) => index !== ref.index);
      return closeRing(open);
    });
    return { type: "Polygon", coordinates };
  }
  return undefined;
}

export function validateGeometry(geometry: UiGeometry): GeometryValidity {
  if (isCircleFeature(geometry)) {
    if (!isFinitePosition(geometry.geometry.coordinates)) {
      return { valid: false, reason: "Circle needs one valid center coordinate" };
    }
    return isFiniteNumber(geometry.properties.radius_m) && geometry.properties.radius_m > 0
      ? { valid: true }
      : { valid: false, reason: "Circle radius must be greater than zero" };
  }
  if (geometry.type === "Point") {
    return isFinitePosition(geometry.coordinates)
      ? { valid: true }
      : { valid: false, reason: "Point needs one valid coordinate" };
  }
  if (geometry.type === "LineString") {
    if (geometry.coordinates.length < 2) {
      return { valid: false, reason: "Line needs at least two points" };
    }
    return geometry.coordinates.every(isFinitePosition)
      ? { valid: true }
      : { valid: false, reason: "Line contains an invalid coordinate" };
  }
  if (geometry.coordinates.length === 0) {
    return { valid: false, reason: "Polygon needs a closed ring of at least four coordinates" };
  }
  for (const ring of geometry.coordinates) {
    if (ring.length < 4) {
      return { valid: false, reason: "Polygon needs a closed ring of at least four coordinates" };
    }
    if (!ring.every(isFinitePosition)) {
      return { valid: false, reason: "Polygon contains an invalid coordinate" };
    }
    if (!positionsEqual(ring[0], ring[ring.length - 1])) {
      return { valid: false, reason: "Polygon ring must repeat its first coordinate to close" };
    }
  }
  return { valid: true };
}

export function geometrySummary(geometry: UiGeometry): string {
  if (isCircleFeature(geometry)) {
    return `Circle · ${formatMeters(geometry.properties.radius_m)} radius · ${formatCoordinate(geometry.geometry.coordinates)}`;
  }
  if (geometry.type === "Point") {
    return `Point · ${formatCoordinate(geometry.coordinates)}`;
  }
  if (geometry.type === "LineString") {
    return `LineString · ${geometry.coordinates.length} points`;
  }
  return `Polygon · ${openRing(geometry.coordinates[0] ?? []).length} vertices`;
}

export function formatCoordinate(position: Position): string {
  return `${position[1].toFixed(5)}, ${position[0].toFixed(5)}`;
}

export function formatMeters(value: number): string {
  return Number.isInteger(value) ? `${value} m` : `${value.toFixed(2)} m`;
}

function moveRingVertex(ring: Position[], index: number, lng: number, lat: number): Position[] {
  const open = openRing(ring);
  const updated = open.map((position, position_index) =>
    position_index === index ? movePosition(position, lng, lat) : position
  );
  return closeRing(updated);
}

function movePosition(position: Position, lng: number, lat: number): Position {
  return [lng, lat, ...position.slice(2)];
}

function openRing(ring: Position[]): Position[] {
  if (ring.length >= 2 && positionsEqual(ring[0], ring[ring.length - 1])) {
    return ring.slice(0, -1);
  }
  return [...ring];
}

function closeRing(open: Position[]): Position[] {
  if (open.length === 0) return [];
  return [...open, open[0]];
}

function positionsEqual(a: Position | undefined, b: Position | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a[0] - b[0]) < COORDINATE_EPSILON && Math.abs(a[1] - b[1]) < COORDINATE_EPSILON;
}

function isFinitePosition(value: Position): boolean {
  return value.every(isFiniteNumber);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function circleFeaturePolygon(circle: UiCircleFeature): UiPolygon {
  const [lng, lat] = circle.geometry.coordinates;
  const lat1 = degreesToRadians(lat);
  const lng1 = degreesToRadians(lng);
  const distance = circle.properties.radius_m / EARTH_RADIUS_M;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinDistance = Math.sin(distance);
  const cosDistance = Math.cos(distance);
  const ring: Position[] = [];
  for (let index = 0; index < CIRCLE_DISPLAY_SEGMENTS; index++) {
    const bearing = (2 * Math.PI * index) / CIRCLE_DISPLAY_SEGMENTS;
    const lat2 = Math.asin(sinLat1 * cosDistance + cosLat1 * sinDistance * Math.cos(bearing));
    const lng2 = lng1 + Math.atan2(Math.sin(bearing) * sinDistance * cosLat1, cosDistance - sinLat1 * Math.sin(lat2));
    ring.push([normalizeLongitude(radiansToDegrees(lng2)), radiansToDegrees(lat2)]);
  }
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function normalizeLongitude(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}
