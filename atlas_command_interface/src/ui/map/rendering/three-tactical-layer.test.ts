import { describe, expect, it } from "vitest";
import { mercatorPoint } from "./three-tactical-layer.js";

describe("Three tactical layer projection", () => {
  it("projects geographic coordinates into MapLibre's normalized Mercator world", () => {
    expect(mercatorPoint(0, 0)).toEqual({ x: 0.5, y: 0.5 });
    expect(mercatorPoint(-180, 0).x).toBe(0);
    expect(mercatorPoint(180, 0).x).toBe(1);
  });

  it("clamps polar coordinates to the Web Mercator latitude limit", () => {
    expect(mercatorPoint(0, 90).y).toBeCloseTo(0, 6);
    expect(mercatorPoint(0, -90).y).toBeCloseTo(1, 6);
  });
});
