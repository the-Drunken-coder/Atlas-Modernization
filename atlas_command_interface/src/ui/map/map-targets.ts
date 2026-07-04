import type { Map as MlMap, MapGeoJSONFeature } from "maplibre-gl";
import type { MouseEvent, PointerEvent } from "react";
import type { UiRawGeometry } from "../../atlas/geometry.js";
import { collectLngLatPositions, featureForEntityId, type MapTarget } from "./map-camera.js";
import type { MapFeature, MapSources } from "./map-sources.js";
import {
  boxFromProjectedPositions,
  boxIntersectsViewport,
  reticleForTarget,
  squareAround,
  type ReticleState,
  type ReticleTarget,
  type ScreenPoint,
  type TargetBox
} from "./map-reticle.js";
import { INTERACTIVE_LAYERS } from "./map-layers.js";

export type MapReticleTarget = MapTarget;
export type HoverTarget = ReticleTarget & { entityId: string };

export function hoverSelectionTarget(
  event: (PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) & { currentTarget: HTMLDivElement },
  mapRect: DOMRect,
  point: ScreenPoint,
  map: MlMap | undefined
): HoverTarget | null {
  if (event.target instanceof Element) {
    const element = event.target.closest<HTMLElement>(".map-symbol-marker");
    const entityId = element?.dataset.entityId;
    if (element && entityId && event.currentTarget.contains(element)) {
      return { entityId, box: boxFromElement(element, mapRect) };
    }
  }

  const markerAtPoint = markerTargetAtPoint(event.currentTarget, mapRect, point);
  if (markerAtPoint) return markerAtPoint;

  if (!map) return null;
  try {
    const features = map.queryRenderedFeatures([point.x, point.y], { layers: INTERACTIVE_LAYERS });
    for (const feature of features) {
      const box = boxFromFeature(map, feature);
      const entityId = feature.properties?.entityId;
      if (box && typeof entityId === "string") return { entityId, box };
    }
  } catch {
    return null;
  }
  return null;
}

export function reticleForVisibleTarget(mapCanvas: HTMLElement | null, map: MlMap, sources: MapSources, target: MapReticleTarget): ReticleState | null {
  if (!mapCanvas) return null;
  const box = boxForMapReticleTarget(mapCanvas, map, sources, target);
  if (!box) return null;
  const viewport = mapCanvas.getBoundingClientRect();
  if (!boxIntersectsViewport(box, { width: viewport.width, height: viewport.height })) return null;
  return reticleForTarget({ id: target.id, entityId: target.type === "entity" ? target.id : undefined, box });
}

export function targetBoxForEntityId(mapCanvas: HTMLElement, map: MlMap, sources: MapSources, entityId: string): TargetBox | null {
  return boxForEntityMarker(mapCanvas, entityId) ?? boxForFeature(map, featureForEntityId(sources, entityId));
}

function markerTargetAtPoint(mapCanvas: HTMLElement, mapRect: DOMRect, point: ScreenPoint): HoverTarget | null {
  for (const element of mapCanvas.querySelectorAll<HTMLElement>(".map-symbol-marker")) {
    const entityId = element.dataset.entityId;
    if (!entityId) continue;
    const box = boxFromElement(element, mapRect);
    if (point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height) {
      return { entityId, box };
    }
  }
  return null;
}

function boxForMapReticleTarget(mapCanvas: HTMLElement, map: MlMap, sources: MapSources, target: MapReticleTarget): TargetBox | null {
  if (target.type === "entity") return targetBoxForEntityId(mapCanvas, map, sources, target.id);
  if (target.type === "point") {
    const point = map.project(target.coordinates);
    return squareAround({ x: point.x, y: point.y }, 1);
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

function boxFromFeature(map: MlMap, feature: MapGeoJSONFeature): TargetBox | null {
  return boxFromProjectedPositions(collectLngLatPositions(feature.geometry.coordinates), (position) => {
    const projected = map.project([position[0], position[1]]);
    return { x: projected.x, y: projected.y };
  });
}

function boxForFeature(map: MlMap, feature: MapFeature | undefined): TargetBox | null {
  return feature ? boxFromGeometry(map, feature.geometry) : null;
}

function boxFromGeometry(map: MlMap, geometry: UiRawGeometry): TargetBox | null {
  return boxFromProjectedPositions(collectLngLatPositions(geometry.coordinates), (position) => {
    const projected = map.project([position[0], position[1]]);
    return { x: projected.x, y: projected.y };
  });
}
