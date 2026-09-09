import type { MovementSample, MovementTrail } from "@the-drunken-coder/atlas-sdk";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";

export type MovementMapOverlay = {
  trail?: MovementTrail;
  selected?: MovementSample;
  interactive: boolean;
  onPin(sample: MovementSample): void;
  onPreview(sample: MovementSample | undefined): void;
  onDismiss(): boolean;
};
export const MOVEMENT_POINTS_LAYER = "movement-history-points";
const sourceID = "movement-history";

// Split the shortest connector at the dateline instead of drawing across the world.
export function movementConnector(a: [number, number], b: [number, number]): Array<Array<[number, number]>> {
  const delta = b[0] - a[0];
  if (Math.abs(delta) <= 180) return [[a, b]];
  const end = b[0] + (delta > 180 ? -360 : 360);
  const edge = end > 180 ? 180 : -180;
  const latitude = a[1] + ((edge - a[0]) / (end - a[0])) * (b[1] - a[1]);
  return [
    [a, [edge, latitude]],
    [[-edge, latitude], b]
  ];
}

export function movementFeatures(
  overlay: Pick<MovementMapOverlay, "trail" | "selected"> | undefined
): FeatureCollection {
  const features: Feature<Geometry>[] = [];
  let previous: [number, number] | undefined;
  for (const point of overlay?.trail?.points ?? []) {
    const { sample } = point;
    if (sample.latitude === undefined || sample.longitude === undefined) continue;
    const coordinates: [number, number] = [sample.longitude, sample.latitude];
    if (previous)
      for (const line of movementConnector(previous, coordinates)) {
        features.push({
          type: "Feature",
          properties: { kind: "line", gap: point.gap_before },
          geometry: { type: "LineString", coordinates: line }
        });
      }
    features.push({
      type: "Feature",
      properties: { kind: "report", sampleId: sample.sample_id },
      geometry: { type: "Point", coordinates }
    });
    previous = coordinates;
  }
  const selected = overlay?.selected;
  if (selected?.latitude !== undefined && selected.longitude !== undefined)
    features.push({
      type: "Feature",
      properties: { kind: "selected" },
      geometry: { type: "Point", coordinates: [selected.longitude, selected.latitude] }
    });
  return { type: "FeatureCollection", features };
}

export function pushMovementOverlay(map: MlMap, overlay: Pick<MovementMapOverlay, "trail" | "selected"> | undefined) {
  if (!map.getSource(sourceID)) {
    map.addSource(sourceID, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "movement-history-line",
      type: "line",
      source: sourceID,
      filter: ["all", ["==", ["get", "kind"], "line"], ["==", ["get", "gap"], false]],
      paint: { "line-color": "#ffc058", "line-width": 2 }
    });
    map.addLayer({
      id: "movement-history-gaps",
      type: "line",
      source: sourceID,
      filter: ["all", ["==", ["get", "kind"], "line"], ["==", ["get", "gap"], true]],
      layout: { "line-cap": "round" },
      paint: { "line-color": "#ffc058", "line-width": 2, "line-dasharray": [0, 3] }
    });
    map.addLayer({
      id: MOVEMENT_POINTS_LAYER,
      type: "circle",
      source: sourceID,
      filter: ["==", ["get", "kind"], "report"],
      paint: {
        "circle-radius": 3,
        "circle-color": "#101315",
        "circle-stroke-color": "#ffc058",
        "circle-stroke-width": 1
      }
    });
    map.addLayer({
      id: "movement-history-selected",
      type: "circle",
      source: sourceID,
      filter: ["==", ["get", "kind"], "selected"],
      paint: {
        "circle-radius": 9,
        "circle-color": "#101315",
        "circle-stroke-color": "#ffc058",
        "circle-stroke-width": 2
      }
    });
  }
  (map.getSource(sourceID) as GeoJSONSource).setData(movementFeatures(overlay));
}
