import type { Map as MlMap } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import type { UiRawGeometry } from "../../../atlas/geometry.js";
import { reticleForLiteralTarget } from "./map-targets.js";

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
