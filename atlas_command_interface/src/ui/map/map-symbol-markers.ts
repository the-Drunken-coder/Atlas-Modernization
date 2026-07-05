import type { Marker } from "maplibre-gl";
import { defaultSidcIconService } from "../symbols/sidc-symbol-service.js";
import type { MapFeature, MapSources } from "./map-sources.js";

export function symbolMarkerFeatures(sources: MapSources): Array<MapFeature & { geometry: { type: "Point"; coordinates: [number, number] } }> {
  return [...sources.assets.features, ...sources.tracks.features].filter(isPointFeature);
}

export function createSymbolMarkerElement(feature: MapFeature & { geometry: { type: "Point"; coordinates: [number, number] } }): HTMLButtonElement {
  const { properties } = feature;
  const opacity = properties.linkState === "disconnected" ? 0.58 : properties.linkState === "degraded" ? 0.82 : 1;
  const rotation = properties.kind === "asset" ? properties.heading : undefined;
  const symbol =
    properties.kind === "track"
      ? defaultSidcIconService.getTrackSymbol({ type: properties.symbolType ?? properties.subtype ?? properties.classification ?? properties.name })
      : defaultSidcIconService.getAssetSymbol({
          entityId: properties.entityId,
          entityType: properties.entityType,
          modelId: properties.modelId,
          assetType: properties.assetType,
          symbolType: properties.symbolType,
          subtype: properties.subtype
        });
  const rendered = defaultSidcIconService.render(symbol, { selected: properties.selected, opacity, rotation });
  const element = document.createElement("button");
  element.type = "button";
  element.className = [
    "map-symbol-marker",
    `map-symbol-marker--${properties.kind}`,
    properties.selected ? "map-symbol-marker--selected" : "",
    rendered.isFallback ? "map-symbol-marker--fallback" : ""
  ]
    .filter(Boolean)
    .join(" ");
  element.title = properties.name;
  element.setAttribute("aria-label", `${properties.name} ${properties.kind}`);
  element.dataset.entityId = properties.entityId;
  element.innerHTML = rendered.html;
  return element;
}

export function clearMarkers(markers: Marker[]): void {
  for (const marker of markers) marker.remove();
}

function isPointFeature(feature: MapFeature): feature is MapFeature & { geometry: { type: "Point"; coordinates: [number, number] } } {
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
