import type { Marker } from "maplibre-gl";
import { defaultSidcIconService } from "../../symbols/sidc-symbol-service.js";
import type { MapFeature, MapSources } from "./map-sources.js";

export type SymbolMarkerFeature = MapFeature & { geometry: { type: "Point"; coordinates: [number, number] } };

export function symbolMarkerFeatures(sources: MapSources): SymbolMarkerFeature[] {
  return [...sources.assets.features, ...sources.tracks.features].filter(isPointFeature);
}

export function createSymbolMarkerElement(feature: SymbolMarkerFeature): HTMLButtonElement {
  const element = document.createElement("button");
  updateSymbolMarkerElement(element, feature);
  return element;
}

export function updateSymbolMarkerElement(element: HTMLButtonElement, feature: SymbolMarkerFeature): void {
  const { properties } = feature;
  const opacity = properties.linkState === "disconnected" ? 0.58 : properties.linkState === "degraded" ? 0.82 : 1;
  const rotation = properties.kind === "asset" ? properties.heading : undefined;
  const symbol =
    properties.kind === "track"
      ? defaultSidcIconService.getTrackSymbol({
          type: properties.symbolType ?? properties.subtype ?? properties.classification ?? properties.name
        })
      : defaultSidcIconService.getAssetSymbol({
          entityId: properties.entityId,
          entityType: properties.entityType,
          modelId: properties.modelId,
          assetType: properties.assetType,
          symbolType: properties.symbolType,
          subtype: properties.subtype
        });
  const rendered = defaultSidcIconService.render(symbol, { selected: properties.selected, opacity, rotation });
  element.type = "button";
  element.classList.add("map-symbol-marker");
  element.classList.toggle("map-symbol-marker--asset", properties.kind === "asset");
  element.classList.toggle("map-symbol-marker--track", properties.kind === "track");
  element.classList.toggle("map-symbol-marker--selected", properties.selected);
  element.classList.toggle("map-symbol-marker--fallback", rendered.isFallback);
  element.title = properties.name;
  element.setAttribute("aria-label", `${properties.name} ${properties.kind}`);
  element.dataset.entityId = properties.entityId;
  element.innerHTML = rendered.html;
}

export function symbolMarkerPositionsEqual(left: SymbolMarkerFeature, right: SymbolMarkerFeature): boolean {
  return (
    left.geometry.coordinates[0] === right.geometry.coordinates[0] &&
    left.geometry.coordinates[1] === right.geometry.coordinates[1]
  );
}

export function symbolMarkerPresentationsEqual(left: SymbolMarkerFeature, right: SymbolMarkerFeature): boolean {
  const a = left.properties;
  const b = right.properties;
  return (
    a.entityId === b.entityId &&
    a.entityType === b.entityType &&
    a.kind === b.kind &&
    a.name === b.name &&
    a.selected === b.selected &&
    a.classification === b.classification &&
    a.linkState === b.linkState &&
    a.heading === b.heading &&
    a.subtype === b.subtype &&
    a.modelId === b.modelId &&
    a.assetType === b.assetType &&
    a.symbolType === b.symbolType
  );
}

export function clearMarkers(markers: Marker[]): void {
  for (const marker of markers) marker.remove();
}

function isPointFeature(feature: MapFeature): feature is SymbolMarkerFeature {
  const [longitude, latitude] = feature.geometry.coordinates;
  return (
    feature.geometry.type === "Point" &&
    Array.isArray(feature.geometry.coordinates) &&
    feature.geometry.coordinates.length >= 2 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90
  );
}
