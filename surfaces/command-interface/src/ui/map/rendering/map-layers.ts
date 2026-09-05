import type { SpatialFeature } from "@the-drunken-coder/atlas-sdk";
import type * as maplibregl from "maplibre-gl";
import type { Map as MlMap } from "maplibre-gl";
import { displayGeometry } from "../../../atlas/geometry.js";
import type { MapEditing } from "./map-editing.js";
import { emptyFeatureCollection, type MapSources } from "./map-sources.js";

// MapLibre paint values cannot resolve CSS variables. Keep these paired with
// the corresponding semantic colors in tokens.css.
const COLORS = {
  editingFill: "rgba(217,148,47,0.18)",
  geofeature: "#54b77b",
  geofeatureFill: "rgba(84,183,123,0.14)",
  selected: "#f5f2e9",
  spatial: "#d9942f",
  spatialFill: "rgba(217,148,47,0.20)"
};

export const INTERACTIVE_LAYERS = ["geofeatures-point", "geofeatures-line", "geofeatures-fill"];
export const SPATIAL_RESULT_LAYERS = ["spatial-results-line", "spatial-results-fill"];

export type SpatialMapOverlay = {
  features: SpatialFeature[];
  selectedFeatureId?: string;
};

export function pushSources(map: MlMap, sources: MapSources): void {
  (map.getSource("geofeatures") as maplibregl.GeoJSONSource | undefined)?.setData(sources.geofeatures);
}

export function pushEditingOverlay(map: MlMap, editing: MapEditing | undefined): void {
  const overlay = map.getSource("editing") as maplibregl.GeoJSONSource | undefined;
  overlay?.setData(
    editing
      ? {
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: displayGeometry(editing.geometry), properties: {} }]
        }
      : emptyFeatureCollection()
  );
}

export function pushSpatialOverlay(map: MlMap, overlay: SpatialMapOverlay | undefined): void {
  const source = map.getSource("spatial-results") as maplibregl.GeoJSONSource | undefined;
  source?.setData(
    overlay
      ? {
          type: "FeatureCollection",
          features: overlay.features.map((feature) => ({
            type: "Feature",
            id: feature.id,
            geometry: feature.geometry,
            properties: { featureId: feature.id, selected: feature.id === overlay.selectedFeatureId }
          }))
        }
      : emptyFeatureCollection()
  );
}

export function registerSourcesAndLayers(map: MlMap): void {
  for (const id of ["geofeatures", "editing", "spatial-results"]) {
    if (!map.getSource(id)) {
      map.addSource(id, { type: "geojson", data: emptyFeatureCollection() });
    }
  }

  if (!map.getLayer("geofeatures-fill")) {
    map.addLayer({
      id: "geofeatures-fill",
      type: "fill",
      source: "geofeatures",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": COLORS.geofeatureFill, "fill-outline-color": COLORS.geofeature }
    });
  }
  if (!map.getLayer("geofeatures-line")) {
    map.addLayer({
      id: "geofeatures-line",
      type: "line",
      source: "geofeatures",
      filter: ["match", ["geometry-type"], ["LineString", "Polygon"], true, false],
      paint: {
        "line-color": COLORS.geofeature,
        "line-width": ["case", ["boolean", ["get", "selected"], false], 3.5, 2]
      }
    });
  }
  if (!map.getLayer("geofeatures-point")) {
    map.addLayer({
      id: "geofeatures-point",
      type: "circle",
      source: "geofeatures",
      filter: ["==", ["geometry-type"], "Point"],
      paint: circlePaint(COLORS.geofeature)
    });
  }

  if (!map.getLayer("editing-fill")) {
    map.addLayer({
      id: "editing-fill",
      type: "fill",
      source: "editing",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": COLORS.editingFill }
    });
  }
  if (!map.getLayer("editing-line")) {
    map.addLayer({
      id: "editing-line",
      type: "line",
      source: "editing",
      filter: ["match", ["geometry-type"], ["LineString", "Polygon"], true, false],
      paint: { "line-color": COLORS.selected, "line-width": 2, "line-dasharray": [2, 1.5] }
    });
  }

  if (!map.getLayer("spatial-results-fill")) {
    map.addLayer({
      id: "spatial-results-fill",
      type: "fill",
      source: "spatial-results",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": COLORS.spatialFill,
        "fill-outline-color": COLORS.spatial
      }
    });
  }
  if (!map.getLayer("spatial-results-line")) {
    map.addLayer({
      id: "spatial-results-line",
      type: "line",
      source: "spatial-results",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "line-color": ["case", ["boolean", ["get", "selected"], false], COLORS.selected, COLORS.spatial],
        "line-width": ["case", ["boolean", ["get", "selected"], false], 4, 2]
      }
    });
  }
}

function circlePaint(color: string): maplibregl.CircleLayerSpecification["paint"] {
  return {
    "circle-radius": ["case", ["boolean", ["get", "selected"], false], 7, 5],
    "circle-color": color,
    "circle-stroke-width": ["case", ["boolean", ["get", "selected"], false], 3, 1.5],
    "circle-stroke-color": ["case", ["boolean", ["get", "selected"], false], COLORS.selected, "rgba(0,0,0,0.65)"]
  };
}
