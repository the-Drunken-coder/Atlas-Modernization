import type { MapGeoJSONFeature, Map as MlMap } from "maplibre-gl";
import type { UiRawGeometry } from "../../../atlas/geometry.js";
import { INTERACTIVE_LAYERS } from "../rendering/map-layers.js";
import type { MapFeature, MapSources } from "../rendering/map-sources.js";
import { collectLngLatPositions, featureForEntityId, type MapTarget } from "./map-camera.js";
import {
  boxFromProjectedPositions,
  boxIntersectsViewport,
  distanceToBox,
  HOVER_MAGNET_RADIUS,
  type ReticleState,
  type ReticleTarget,
  reticleForTarget,
  type ScreenPoint,
  squareAround,
  type TargetBox
} from "./map-reticle.js";

export type MapReticleTarget = MapTarget;
export type LiteralMapReticleTarget = Exclude<MapTarget, { type: "entity" }>;
export type HoverTarget = ReticleTarget & { entityId: string };
export type MarkerBoxCache = { entries: HoverTarget[] | null; mapRect: TargetBox | null };
export type MapNavigationDirection = "up" | "down" | "left" | "right";
type MapPointerTargetEvent = { currentTarget: HTMLDivElement; target: EventTarget | null };

export function createMarkerBoxCache(): MarkerBoxCache {
  return { entries: null, mapRect: null };
}

export function invalidateMarkerBoxCache(cache: MarkerBoxCache): void {
  cache.entries = null;
  cache.mapRect = null;
}

export function hoverSelectionTarget(
  event: MapPointerTargetEvent,
  mapRect: DOMRect,
  point: ScreenPoint,
  map: MlMap | undefined,
  cache: MarkerBoxCache
): HoverTarget | null {
  return hoverSelectionTargets(event, mapRect, point, map, cache)[0] ?? null;
}

/**
 * All selectable entities within HOVER_MAGNET_RADIUS of the cursor, nearest
 * markers first, then rendered canvas features in draw order.
 */
export function hoverSelectionTargets(
  event: MapPointerTargetEvent,
  mapRect: DOMRect,
  point: ScreenPoint,
  map: MlMap | undefined,
  cache: MarkerBoxCache,
  trustDirectHit = false
): HoverTarget[] {
  const candidates: HoverTarget[] = [];
  const seen = new Set<string>();
  const push = (target: HoverTarget) => {
    if (seen.has(target.entityId)) return;
    seen.add(target.entityId);
    candidates.push(target);
  };

  if (event.target instanceof Element) {
    const element = event.target.closest<HTMLElement>(".map-symbol-marker");
    const entityId = element?.dataset.entityId;
    if (element && entityId && event.currentTarget.contains(element)) {
      const box = boxFromElement(element, mapRect);
      if (trustDirectHit || distanceToBox(point, box) <= HOVER_MAGNET_RADIUS) push({ entityId, box });
    }
  }

  const markers = cachedMarkerBoxes(cache, event.currentTarget, mapRect)
    .map((entry) => ({ entry, distance: distanceToBox(point, entry.box) }))
    .filter(({ distance }) => distance <= HOVER_MAGNET_RADIUS)
    .sort((a, b) => a.distance - b.distance);
  for (const { entry } of markers) push(entry);

  if (!map) return candidates;
  try {
    const features = map.queryRenderedFeatures(
      [
        [point.x - HOVER_MAGNET_RADIUS, point.y - HOVER_MAGNET_RADIUS],
        [point.x + HOVER_MAGNET_RADIUS, point.y + HOVER_MAGNET_RADIUS]
      ],
      { layers: INTERACTIVE_LAYERS }
    );
    for (const feature of features) {
      const entityId = feature.properties?.entityId;
      if (typeof entityId !== "string" || seen.has(entityId)) continue;
      const box = boxFromFeature(map, feature);
      if (box) push({ entityId, box });
    }
  } catch {
    return candidates;
  }
  return candidates;
}

export function reticleForVisibleTarget(
  mapCanvas: HTMLElement | null,
  map: MlMap,
  sources: MapSources,
  target: MapReticleTarget
): ReticleState | null {
  if (!mapCanvas) return null;
  const box = boxForMapReticleTarget(mapCanvas, map, sources, target);
  if (!box) return null;
  const viewport = mapCanvas.getBoundingClientRect();
  if (!boxIntersectsViewport(box, { width: viewport.width, height: viewport.height })) return null;
  return reticleForTarget({ id: target.id, entityId: target.type === "entity" ? target.id : undefined, box });
}

/** Resolves a literal point or geometry against the map's current camera. */
export function reticleForLiteralTarget(map: MlMap, target: LiteralMapReticleTarget): ReticleState | null {
  const box = boxForLiteralTarget(map, target);
  return box ? reticleForTarget({ id: target.id, box }) : null;
}

export function targetBoxForEntityId(
  mapCanvas: HTMLElement,
  map: MlMap,
  sources: MapSources,
  entityId: string
): TargetBox | null {
  return boxForEntityMarker(mapCanvas, entityId) ?? boxForFeature(map, featureForEntityId(sources, entityId));
}

export function nextVisibleEntityInDirection(
  mapCanvas: HTMLElement,
  map: MlMap,
  sources: MapSources,
  selectedEntityId: string | undefined,
  direction: MapNavigationDirection
): string | undefined {
  const viewport = mapCanvas.getBoundingClientRect();
  const size = { width: viewport.width, height: viewport.height };
  const targets = [...sources.assets.features, ...sources.tracks.features, ...sources.geofeatures.features].flatMap(
    (feature) => {
      const box = targetBoxForEntityId(mapCanvas, map, sources, feature.properties.entityId);
      const center = box && visibleBoxCenter(box, size);
      return center ? [{ entityId: feature.properties.entityId, center }] : [];
    }
  );
  const origin = targets.find((target) => target.entityId === selectedEntityId)?.center ?? {
    x: size.width / 2,
    y: size.height / 2
  };

  return targets
    .filter((target) => target.entityId !== selectedEntityId)
    .map((target) => ({ target, ...directionalDistances(origin, target.center, direction) }))
    .filter(({ forward }) => forward > 0)
    .sort(
      (a, b) =>
        a.forward + a.cross * 2 - (b.forward + b.cross * 2) ||
        a.cross - b.cross ||
        a.target.entityId.localeCompare(b.target.entityId)
    )[0]?.target.entityId;
}

function cachedMarkerBoxes(cache: MarkerBoxCache, mapCanvas: HTMLElement, mapRect: DOMRect): HoverTarget[] {
  const currentMapRect = { x: mapRect.left, y: mapRect.top, width: mapRect.width, height: mapRect.height };
  if (cache.entries && boxesEqual(cache.mapRect, currentMapRect)) return cache.entries;
  const entries: HoverTarget[] = [];
  for (const element of mapCanvas.querySelectorAll<HTMLElement>(".map-symbol-marker")) {
    const entityId = element.dataset.entityId;
    if (entityId) entries.push({ entityId, box: boxFromElement(element, mapRect) });
  }
  cache.entries = entries;
  cache.mapRect = currentMapRect;
  return entries;
}

function boxesEqual(a: TargetBox | null, b: TargetBox): boolean {
  return a?.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function boxForMapReticleTarget(
  mapCanvas: HTMLElement,
  map: MlMap,
  sources: MapSources,
  target: MapReticleTarget
): TargetBox | null {
  if (target.type === "entity") return targetBoxForEntityId(mapCanvas, map, sources, target.id);
  return boxForLiteralTarget(map, target);
}

function boxForLiteralTarget(map: MlMap, target: LiteralMapReticleTarget): TargetBox | null {
  if (target.type === "point") {
    const point = map.project(target.coordinates);
    return squareAround({ x: point.x, y: point.y }, target.reticleSize ?? 1);
  }
  return boxFromGeometry(map, target.geometry);
}

function boxForEntityMarker(mapCanvas: HTMLElement, entityId: string): TargetBox | null {
  const mapRect = mapCanvas.getBoundingClientRect();
  for (const element of mapCanvas.querySelectorAll<HTMLElement>(".map-symbol-marker")) {
    if (element.dataset.entityId === entityId) return boxFromElement(element, mapRect);
  }
  return null;
}

function boxFromElement(element: HTMLElement, mapRect: DOMRect): TargetBox {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left - mapRect.left,
    y: rect.top - mapRect.top,
    width: rect.width,
    height: rect.height
  };
}

function visibleBoxCenter(box: TargetBox, viewport: { width: number; height: number }): ScreenPoint | null {
  if (!boxIntersectsViewport(box, viewport)) return null;
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(viewport.width, box.x + box.width);
  const bottom = Math.min(viewport.height, box.y + box.height);
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

function directionalDistances(
  origin: ScreenPoint,
  target: ScreenPoint,
  direction: MapNavigationDirection
): { forward: number; cross: number } {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  return direction === "up"
    ? { forward: -dy, cross: Math.abs(dx) }
    : direction === "down"
      ? { forward: dy, cross: Math.abs(dx) }
      : direction === "left"
        ? { forward: -dx, cross: Math.abs(dy) }
        : { forward: dx, cross: Math.abs(dy) };
}

function boxFromFeature(map: MlMap, feature: MapGeoJSONFeature): TargetBox | null {
  return boxFromCoordinates(map, feature.geometry.coordinates);
}

function boxForFeature(map: MlMap, feature: MapFeature | undefined): TargetBox | null {
  return feature ? boxFromGeometry(map, feature.geometry) : null;
}

function boxFromGeometry(map: MlMap, geometry: UiRawGeometry): TargetBox | null {
  return boxFromCoordinates(map, geometry.coordinates);
}

function boxFromCoordinates(map: MlMap, coordinates: unknown): TargetBox | null {
  return boxFromProjectedPositions(collectLngLatPositions(coordinates), (position) => {
    const projected = map.project([position[0], position[1]]);
    return { x: projected.x, y: projected.y };
  });
}
