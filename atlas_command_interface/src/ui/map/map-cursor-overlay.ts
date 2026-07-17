import type { ReticleState, ScreenPoint, TargetBox } from "./map-reticle.js";

const EARTH_RADIUS_METERS = 6_371_008.8;
const FEET_PER_METER = 3.28084;
const FEET_PER_MILE = 5_280;
const POINTER_GAP = 9;

export type CursorCoordinates = { lng: number; lat: number };
export type CursorOverlayState = {
  point: ScreenPoint;
  coordinates: CursorCoordinates;
  selection?: ReticleState;
  distanceMeters?: number;
  bearingDegrees?: number;
};

export function tetherSegment(
  selection: TargetBox,
  pointer: ScreenPoint
): { start: ScreenPoint; end: ScreenPoint } | null {
  if (
    pointer.x >= selection.x &&
    pointer.x <= selection.x + selection.width &&
    pointer.y >= selection.y &&
    pointer.y <= selection.y + selection.height
  ) {
    return null;
  }
  const center = { x: selection.x + selection.width / 2, y: selection.y + selection.height / 2 };
  const dx = pointer.x - center.x;
  const dy = pointer.y - center.y;
  const distance = Math.hypot(dx, dy);
  const scaleToEdge = Math.min(
    dx === 0 ? Infinity : selection.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : selection.height / 2 / Math.abs(dy)
  );
  const start = { x: center.x + dx * scaleToEdge, y: center.y + dy * scaleToEdge };
  if (Math.hypot(pointer.x - start.x, pointer.y - start.y) <= POINTER_GAP) return null;
  const unit = { x: dx / distance, y: dy / distance };
  return {
    start,
    end: { x: pointer.x - unit.x * POINTER_GAP, y: pointer.y - unit.y * POINTER_GAP }
  };
}

export function geographicDistanceMeters(a: CursorCoordinates, b: CursorCoordinates): number {
  const lat1 = degreesToRadians(a.lat);
  const lat2 = degreesToRadians(b.lat);
  const deltaLat = lat2 - lat1;
  const deltaLng = degreesToRadians(b.lng - a.lng);
  const value = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  const clampedValue = Math.min(1, Math.max(0, value));
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(clampedValue), Math.sqrt(1 - clampedValue));
}

export function geographicBearingDegrees(a: CursorCoordinates, b: CursorCoordinates): number {
  const lat1 = degreesToRadians(a.lat);
  const lat2 = degreesToRadians(b.lat);
  const deltaLng = degreesToRadians(b.lng - a.lng);
  const bearing = Math.atan2(
    Math.sin(deltaLng) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng)
  );
  return ((bearing * 180) / Math.PI + 360) % 360;
}

export function formatImperialDistance(distanceMeters: number): string {
  const feet = distanceMeters * FEET_PER_METER;
  return feet < FEET_PER_MILE
    ? `${Math.round(feet).toLocaleString("en-US")} ft`
    : `${(feet / FEET_PER_MILE).toFixed(2)} mi`;
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}
