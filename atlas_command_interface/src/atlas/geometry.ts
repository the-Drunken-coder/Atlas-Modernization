// GeoJSON is the preferred editing shape for the UI. Coordinates use GeoJSON
// order: [longitude, latitude]. Atlas Core also accepts a legacy AtlasGeometry
// form ([latitude, longitude] pairs); we normalise that to GeoJSON on read but
// always write GeoJSON back.

export type Position = [number, number];

export type UiPoint = { type: "Point"; coordinates: Position };
export type UiLineString = { type: "LineString"; coordinates: Position[] };
export type UiPolygon = { type: "Polygon"; coordinates: Position[][] };
export type UiGeometry = UiPoint | UiLineString | UiPolygon;

export type GeometryKind = UiGeometry["type"];

export type VertexRef =
  | { kind: "Point" }
  | { kind: "LineString"; index: number }
  | { kind: "Polygon"; ring: number; index: number };

export type EditableVertex = {
  ref: VertexRef;
  lng: number;
  lat: number;
};

export type GeometryValidity = { valid: true } | { valid: false; reason: string };

const COORDINATE_EPSILON = 1e-9;

export function isUiGeometry(value: unknown): value is UiGeometry {
  return geometryFromGeoJSON(value) !== undefined;
}

/**
 * Normalise an entity geometry component (GeoJSON or legacy AtlasGeometry) into
 * the GeoJSON shape the UI edits. Returns undefined when the geometry is absent
 * or not one of Point/LineString/Polygon.
 */
export function toUiGeometry(value: unknown): UiGeometry | undefined {
  return geometryFromGeoJSON(value) ?? geometryFromAtlas(value);
}

/** A representative [lng, lat] point used to place markers and recenter the map. */
export function representativePoint(geometry: UiGeometry): Position | undefined {
  if (geometry.type === "Point") return geometry.coordinates;
  if (geometry.type === "LineString") return geometry.coordinates[0];
  return geometry.coordinates[0]?.[0];
}

/** Editable vertices, excluding a polygon ring's repeated closing coordinate. */
export function geometryVertices(geometry: UiGeometry): EditableVertex[] {
  if (geometry.type === "Point") {
    return [{ ref: { kind: "Point" }, lng: geometry.coordinates[0], lat: geometry.coordinates[1] }];
  }
  if (geometry.type === "LineString") {
    return geometry.coordinates.map((position, index) => ({ ref: { kind: "LineString", index }, lng: position[0], lat: position[1] }));
  }
  return geometry.coordinates.flatMap((ring, ringIndex) =>
    openRing(ring).map((position, index) => ({ ref: { kind: "Polygon", ring: ringIndex, index }, lng: position[0], lat: position[1] }))
  );
}

export function moveVertex(geometry: UiGeometry, ref: VertexRef, lng: number, lat: number): UiGeometry {
  const next: Position = [lng, lat];
  if (geometry.type === "Point" && ref.kind === "Point") {
    return { type: "Point", coordinates: next };
  }
  if (geometry.type === "LineString" && ref.kind === "LineString") {
    const coordinates = geometry.coordinates.map((position, index) => (index === ref.index ? next : position));
    return { type: "LineString", coordinates };
  }
  if (geometry.type === "Polygon" && ref.kind === "Polygon") {
    const coordinates = geometry.coordinates.map((ring, ringIndex) => (ringIndex === ref.ring ? moveRingVertex(ring, ref.index, next) : ring));
    return { type: "Polygon", coordinates };
  }
  return geometry;
}

/** Insert a vertex immediately after the referenced one. No-op for points. */
export function addVertexAfter(geometry: UiGeometry, ref: VertexRef, lng: number, lat: number): UiGeometry {
  const next: Position = [lng, lat];
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
  if (geometry.type === "Point") {
    return isFinitePosition(geometry.coordinates) ? { valid: true } : { valid: false, reason: "Point needs one valid coordinate" };
  }
  if (geometry.type === "LineString") {
    if (geometry.coordinates.length < 2) {
      return { valid: false, reason: "Line needs at least two points" };
    }
    return geometry.coordinates.every(isFinitePosition) ? { valid: true } : { valid: false, reason: "Line contains an invalid coordinate" };
  }
  const ring = geometry.coordinates[0];
  if (!ring || ring.length < 4) {
    return { valid: false, reason: "Polygon needs a closed ring of at least four coordinates" };
  }
  if (!ring.every(isFinitePosition)) {
    return { valid: false, reason: "Polygon contains an invalid coordinate" };
  }
  if (!positionsEqual(ring[0], ring[ring.length - 1])) {
    return { valid: false, reason: "Polygon ring must repeat its first coordinate to close" };
  }
  return { valid: true };
}

export function geometrySummary(geometry: UiGeometry): string {
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

function moveRingVertex(ring: Position[], index: number, next: Position): Position[] {
  const open = openRing(ring);
  const updated = open.map((position, position_index) => (position_index === index ? next : position));
  return closeRing(updated);
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

function geometryFromGeoJSON(value: unknown): UiGeometry | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "Point" && isPosition(value.coordinates)) {
    return { type: "Point", coordinates: toPosition(value.coordinates) };
  }
  if (value.type === "LineString" && Array.isArray(value.coordinates) && value.coordinates.every(isPosition)) {
    return { type: "LineString", coordinates: value.coordinates.map(toPosition) };
  }
  if (
    value.type === "Polygon" &&
    Array.isArray(value.coordinates) &&
    value.coordinates.every((ring) => Array.isArray(ring) && ring.every(isPosition))
  ) {
    return { type: "Polygon", coordinates: (value.coordinates as unknown[][]).map((ring) => ring.map((p) => toPosition(p as number[]))) };
  }
  return undefined;
}

function geometryFromAtlas(value: unknown): UiGeometry | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.point_lat === "number" && typeof value.point_lng === "number") {
    return { type: "Point", coordinates: [value.point_lng, value.point_lat] };
  }
  if (Array.isArray(value.line) && value.line.every(isPosition)) {
    return { type: "LineString", coordinates: value.line.map((p) => latLngToPosition(p as number[])) };
  }
  if (Array.isArray(value.polygon) && value.polygon.every(isPosition)) {
    const ring = value.polygon.map((p) => latLngToPosition(p as number[]));
    return { type: "Polygon", coordinates: [isClosedRing(ring) ? ring : closeRing(ring)] };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is number[] {
  return Array.isArray(value) && value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
}

function isFinitePosition(value: Position): boolean {
  return isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isClosedRing(ring: Position[]): boolean {
  return ring.length >= 2 && positionsEqual(ring[0], ring[ring.length - 1]);
}

function toPosition(value: number[]): Position {
  return [value[0], value[1]];
}

function latLngToPosition(value: number[]): Position {
  return [value[1], value[0]];
}
