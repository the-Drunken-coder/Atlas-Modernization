import type { Map as MlMap } from "maplibre-gl";
import type { ResizeAxes, ScreenRect } from "./MapRegionSelection.js";

export type { ScreenRect } from "./MapRegionSelection.js";

export type ScreenPoint = { x: number; y: number };

export type RegionBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

/** The smallest useful rectangle for either map interaction. */
export const MIN_REGION_SIZE = 32;

export const DATE_LINE_CROSSING_MESSAGE = "Date-line crossings are not supported. Draw a non-crossing area.";

export function pointInCanvas(
  event: Pick<globalThis.MouseEvent, "clientX" | "clientY">,
  canvas: HTMLDivElement,
  clamp = true
): ScreenPoint {
  const bounds = canvas.getBoundingClientRect();
  const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  return clamp
    ? { x: Math.max(0, Math.min(bounds.width, point.x)), y: Math.max(0, Math.min(bounds.height, point.y)) }
    : point;
}

export function rectFromPoints(first: ScreenPoint, second: ScreenPoint): ScreenRect {
  return {
    left: Math.min(first.x, second.x),
    top: Math.min(first.y, second.y),
    width: Math.abs(first.x - second.x),
    height: Math.abs(first.y - second.y)
  };
}

export function regionFromScreenRect(map: MlMap, rect: ScreenRect): RegionBounds | null {
  const first = map.unproject([rect.left, rect.top]);
  const second = map.unproject([rect.left + rect.width, rect.top + rect.height]);
  return regionFromLongitudeInterval(
    first.lng,
    Math.min(first.lat, second.lat),
    second.lng,
    Math.max(first.lat, second.lat)
  );
}

/** Convert map bounds without turning a wrapped viewport into a world-sized box. */
export function regionFromMapBounds(map: MlMap): RegionBounds | null {
  const bounds = map.getBounds();
  return regionFromLongitudeInterval(bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth());
}

export function visibleScreenRect(
  map: MlMap,
  region: RegionBounds,
  viewportWidth: number,
  viewportHeight: number
): ScreenRect | null {
  const rect = projectedScreenRect(map, region);
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewportWidth, rect.left + rect.width);
  const bottom = Math.min(viewportHeight, rect.top + rect.height);
  if (right - left < 2 || bottom - top < 2) return null;
  return { left, top, width: right - left, height: bottom - top };
}

export function projectedScreenRect(map: MlMap, region: RegionBounds): ScreenRect {
  const points = [
    map.project([region.west, region.north]),
    map.project([region.east, region.north]),
    map.project([region.east, region.south]),
    map.project([region.west, region.south])
  ];
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  return { left, top, width: right - left, height: bottom - top };
}

export function clampMovedRect(
  rect: ScreenRect,
  delta: ScreenPoint,
  viewport: Pick<DOMRect, "width" | "height">,
  minSize = MIN_REGION_SIZE
): ScreenRect {
  const visibleWidth = Math.min(minSize, rect.width);
  const visibleHeight = Math.min(minSize, rect.height);
  return {
    ...rect,
    left: Math.max(visibleWidth - rect.width, Math.min(viewport.width - visibleWidth, rect.left + delta.x)),
    top: Math.max(visibleHeight - rect.height, Math.min(viewport.height - visibleHeight, rect.top + delta.y))
  };
}

export function clampResizedRect(
  rect: ScreenRect,
  delta: ScreenPoint,
  axes: ResizeAxes,
  minSize = MIN_REGION_SIZE
): ScreenRect {
  const minWidth = Math.max(minSize, minSize - rect.left);
  const minHeight = Math.max(minSize, minSize - rect.top);
  return {
    ...rect,
    width: axes === "height" ? rect.width : Math.max(minWidth, rect.width + delta.x),
    height: axes === "width" ? rect.height : Math.max(minHeight, rect.height + delta.y)
  };
}

export function keyboardDelta(key: string, step: number, axes: ResizeAxes): ScreenPoint | null {
  if (axes !== "height" && key === "ArrowLeft") return { x: -step, y: 0 };
  if (axes !== "height" && key === "ArrowRight") return { x: step, y: 0 };
  if (axes !== "width" && key === "ArrowUp") return { x: 0, y: -step };
  if (axes !== "width" && key === "ArrowDown") return { x: 0, y: step };
  return null;
}

export function screenRectsEqual(first: ScreenRect | null, second: ScreenRect | null): boolean {
  if (first === second) return true;
  if (!first || !second) return false;
  return (
    Math.abs(first.left - second.left) < 0.5 &&
    Math.abs(first.top - second.top) < 0.5 &&
    Math.abs(first.width - second.width) < 0.5 &&
    Math.abs(first.height - second.height) < 0.5
  );
}

/**
 * Return a valid, non-crossing longitude interval. The map projection can
 * wrap from +180 to -180 while the pointer still moves east, so checking only
 * min/max would incorrectly produce an almost-worldwide rectangle.
 */
function regionFromLongitudeInterval(
  firstLongitude: number,
  south: number,
  secondLongitude: number,
  north: number
): RegionBounds | null {
  if (![firstLongitude, south, secondLongitude, north].every(Number.isFinite)) return null;
  if (firstLongitude >= secondLongitude || south >= north) return null;
  return { west: firstLongitude, south, east: secondLongitude, north };
}
