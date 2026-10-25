import type { Map as MlMap } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import type { UiRawGeometry } from "../../../atlas/geometry.js";
import { type MapFeature, type MapSources } from "../rendering/map-sources.js";
import { type MapNavigationDirection, nextVisibleEntityInDirection, reticleForLiteralTarget } from "./map-targets.js";

describe("map target projection", () => {
  it("projects antimeridian geometry on the same unwrapped interval as fitBounds", () => {
    const project = vi.fn((position: [number, number]) => ({ x: position[0], y: position[1] }));
    const map = { project } as unknown as MlMap;
    const geometry: UiRawGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [179, 10],
          [-179, 10],
          [-179, 12],
          [179, 10]
        ]
      ]
    };

    const reticle = reticleForLiteralTarget(map, { type: "geometry", id: "crossing", geometry });

    expect(project.mock.calls.map(([position]) => position)).toEqual([
      [179, 10],
      [181, 10],
      [181, 12],
      [179, 10]
    ]);
    expect(reticle).toMatchObject({ x: 180, y: 11, target: { width: 22, height: 22 } });
  });
});

function pointFeature(id: string, x: number, y: number): MapFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [x, y] },
    properties: { entityId: id, entityType: "asset", kind: "asset", name: id, selected: false }
  };
}

function navigationFixture(features: MapFeature[]) {
  const markers: { dataset: { entityId: string }; getBoundingClientRect: () => object }[] = [];
  const canvas = {
    getBoundingClientRect: vi.fn(() => ({ left: 10, top: 20, width: 100, height: 100 })),
    querySelectorAll: vi.fn(() => markers)
  };
  const project = vi.fn((position: [number, number]) => ({ x: position[0], y: position[1] }));
  const sources: MapSources = {
    assets: { type: "FeatureCollection", features },
    tracks: { type: "FeatureCollection", features: [] },
    geofeatures: { type: "FeatureCollection", features: [] }
  };
  return {
    canvas,
    mapCanvas: canvas as unknown as HTMLElement,
    map: { project } as unknown as MlMap,
    sources,
    markers
  };
}

describe("directional map navigation", () => {
  it.each<MapNavigationDirection>(["up", "down", "left", "right"])(
    "navigates %s from the visible selection",
    (direction) => {
      const { mapCanvas, map, sources } = navigationFixture([
        pointFeature("selected", 50, 50),
        pointFeature("up", 50, 30),
        pointFeature("down", 50, 70),
        pointFeature("left", 30, 50),
        pointFeature("right", 70, 50)
      ]);
      expect(nextVisibleEntityInDirection(mapCanvas, map, sources, "selected", direction)).toBe(direction);
    }
  );

  it("preserves weighted distance, cross-distance and ID tie-breaks from the viewport fallback", () => {
    const { mapCanvas, map, sources } = navigationFixture([
      pointFeature("behind", 40, 50),
      pointFeature("offscreen", 150, 50),
      pointFeature("cross", 60, 55),
      pointFeature("z-right", 70, 50),
      pointFeature("a-right", 70, 50),
      pointFeature("near-but-off-axis", 55, 59)
    ]);
    expect(nextVisibleEntityInDirection(mapCanvas, map, sources, undefined, "right")).toBe("a-right");
    expect(nextVisibleEntityInDirection(mapCanvas, map, sources, "offscreen", "right")).toBe("a-right");
  });

  it("keeps first-marker and first-source precedence and clips the selected marker to the viewport", () => {
    const { mapCanvas, map, sources, markers } = navigationFixture([
      pointFeature("selected", 80, 50),
      pointFeature("duplicate", 40, 50),
      pointFeature("right", 20, 50),
      pointFeature("left-of-clipped-origin", 5, 50)
    ]);
    sources.tracks.features.push(pointFeature("duplicate", 15, 50));
    markers.push(
      {
        dataset: { entityId: "selected" },
        getBoundingClientRect: () => ({ left: -10, top: 70, width: 40, height: 0 })
      },
      { dataset: { entityId: "selected" }, getBoundingClientRect: () => ({ left: 90, top: 70, width: 0, height: 0 }) }
    );
    expect(nextVisibleEntityInDirection(mapCanvas, map, sources, "selected", "right")).toBe("right");
  });

  it("reads each feature ID once and scans marker layout only once per navigation", () => {
    const readEntityId = vi.fn((id: string) => id);
    const features: MapFeature[] = [];
    for (let index = 0; index < 64; index += 1) {
      const id = `entity-${index}`;
      const feature = pointFeature(id, index, 50);
      Object.defineProperty(feature.properties, "entityId", { get: () => readEntityId(id) });
      features.push(feature);
    }
    const { canvas, mapCanvas, map, sources } = navigationFixture(features);
    expect(nextVisibleEntityInDirection(mapCanvas, map, sources, undefined, "right")).toBe("entity-51");
    expect(readEntityId).toHaveBeenCalledTimes(features.length);
    expect(canvas.querySelectorAll).toHaveBeenCalledTimes(1);
    expect(canvas.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(nextVisibleEntityInDirection(mapCanvas, map, sources, undefined, "up")).toBeUndefined();
  });
});
