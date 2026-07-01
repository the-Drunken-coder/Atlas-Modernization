import { describe, expect, it } from "vitest";
import {
  boxFromDrag,
  boxFromProjectedPositions,
  boxIntersectsViewport,
  minimumBox,
  paddedBox,
  reticleForTarget,
  squareAround
} from "./map-reticle.js";

describe("map reticle helpers", () => {
  it("builds padded minimum target boxes around targets", () => {
    const reticle = reticleForTarget({ entityId: "asset-1", box: { x: 10, y: 20, width: 4, height: 8 } });

    expect(reticle).toEqual({
      x: 12,
      y: 24,
      target: { x: 1, y: 13, width: 22, height: 22 },
      targetEntityId: "asset-1",
      targeted: true
    });
  });

  it("pads boxes and keeps larger dimensions", () => {
    expect(paddedBox({ x: 10, y: 20, width: 30, height: 12 }, 5)).toEqual({ x: 5, y: 15, width: 40, height: 22 });
    expect(minimumBox({ x: 5, y: 15, width: 40, height: 22 }, 22)).toEqual({ x: 5, y: 15, width: 40, height: 22 });
  });

  it("builds stable boxes around points and drags", () => {
    expect(squareAround({ x: 50, y: 80 }, 22)).toEqual({ x: 39, y: 69, width: 22, height: 22 });
    expect(boxFromDrag({ start: { x: 120, y: 90 }, current: { x: 20, y: 140 } })).toEqual({ x: 20, y: 90, width: 100, height: 50 });
  });

  it("checks whether target boxes intersect the viewport", () => {
    const viewport = { width: 400, height: 200 };

    expect(boxIntersectsViewport({ x: 390, y: 190, width: 20, height: 20 }, viewport)).toBe(true);
    expect(boxIntersectsViewport({ x: 401, y: 50, width: 20, height: 20 }, viewport)).toBe(false);
    expect(boxIntersectsViewport({ x: 20, y: -25, width: 20, height: 20 }, viewport)).toBe(false);
  });

  it("creates boxes from projected geometry positions", () => {
    const box = boxFromProjectedPositions(
      [
        [-74, 40],
        [-73, 41],
        [-75, 42]
      ],
      ([lng, lat]) => ({ x: (lng + 80) * 10, y: (lat - 30) * 5 })
    );

    expect(box).toEqual({ x: 50, y: 50, width: 20, height: 10 });
  });
});
