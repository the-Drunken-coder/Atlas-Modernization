import type maplibregl from "maplibre-gl";
import type { Map as MlMap } from "maplibre-gl";
import { displayGeometry } from "../../atlas/geometry.js";
import { emptyFeatureCollection, type MapSources } from "./map-sources.js";
import type { MapEditing } from "./map-editing.js";

const COLORS = {
  geofeature: "#3fd27a",
  geofeatureFill: "rgba(63,210,122,0.16)",
  selected: "#ffffff"
};

export const INTERACTIVE_LAYERS = ["geofeatures-point", "geofeatures-line", "geofeatures-fill"];

export function pushSources(map: MlMap, sources: MapSources): void {
  (map.getSource("geofeatures") as maplibregl.GeoJSONSource | undefined)?.setData(sources.geofeatures as never);
}

export function pushEditingOverlay(map: MlMap, editing: MapEditing | undefined): void {
  const overlay = map.getSource("editing") as maplibregl.GeoJSONSource | undefined;
  overlay?.setData(
    editing
      ? ({ type: "FeatureCollection", features: [{ type: "Feature", geometry: displayGeometry(editing.geometry), properties: {} }] } as never)
      : (emptyFeatureCollection() as never)
  );
}

export function registerSourcesAndLayers(map: MlMap): void {
  for (const id of ["geofeatures", "editing"]) {
    if (!map.getSource(id)) {
      map.addSource(id, { type: "geojson", data: emptyFeatureCollection() as never });
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
      paint: { "fill-color": "rgba(63,182,255,0.18)" }
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
}

function circlePaint(color: string): maplibregl.CircleLayerSpecification["paint"] {
  return {
    "circle-radius": ["case", ["boolean", ["get", "selected"], false], 7, 5],
    "circle-color": color,
    "circle-stroke-width": ["case", ["boolean", ["get", "selected"], false], 3, 1.5],
    "circle-stroke-color": ["case", ["boolean", ["get", "selected"], false], COLORS.selected, "rgba(0,0,0,0.65)"]
  };
}
