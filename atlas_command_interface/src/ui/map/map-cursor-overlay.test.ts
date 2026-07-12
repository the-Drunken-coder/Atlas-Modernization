import { describe, expect, it } from "vitest";
import { formatImperialDistance, geographicBearingDegrees, geographicDistanceMeters, tetherSegment } from "./map-cursor-overlay.js";

describe("map cursor overlay helpers", () => {
  it("clips the tether to the selected box and leaves a gap around the pointer X", () => {
    expect(tetherSegment({ x: 40, y: 40, width: 20, height: 20 }, { x: 100, y: 50 })).toEqual({
      start: { x: 60, y: 50 },
      end: { x: 91, y: 50 }
    });
    expect(tetherSegment({ x: 40, y: 40, width: 20, height: 20 }, { x: 50, y: 100 })).toEqual({
      start: { x: 50, y: 60 },
      end: { x: 50, y: 91 }
    });
    const diagonal = tetherSegment({ x: 40, y: 40, width: 20, height: 20 }, { x: 100, y: 100 });
    expect(diagonal?.start).toEqual({ x: 60, y: 60 });
    expect(Math.hypot(100 - (diagonal?.end.x ?? 0), 100 - (diagonal?.end.y ?? 0))).toBeCloseTo(9);
    expect(tetherSegment({ x: 40, y: 40, width: 20, height: 20 }, { x: 65, y: 50 })).toBeNull();
  });

  it("measures geographic distance", () => {
    expect(geographicDistanceMeters({ lng: 0, lat: 0 }, { lng: 0, lat: 1 })).toBeCloseTo(111_195.08, 1);
    const nearAntipodal = geographicDistanceMeters({ lng: 0, lat: 0 }, { lng: 179.999999, lat: 0 });
    expect(Number.isFinite(nearAntipodal)).toBe(true);
    expect(nearAntipodal).toBeCloseTo(Math.PI * 6_371_008.8, 0);
  });

  it("measures geographic bearing clockwise from north", () => {
    const origin = { lng: 0, lat: 0 };
    expect(geographicBearingDegrees(origin, { lng: 0, lat: 1 })).toBeCloseTo(0);
    expect(geographicBearingDegrees(origin, { lng: 1, lat: 0 })).toBeCloseTo(90);
    expect(geographicBearingDegrees(origin, { lng: 0, lat: -1 })).toBeCloseTo(180);
    expect(geographicBearingDegrees(origin, { lng: -1, lat: 0 })).toBeCloseTo(270);
  });

  it("formats imperial distance as feet below one mile and miles above it", () => {
    expect(formatImperialDistance(100)).toBe("328 ft");
    expect(formatImperialDistance(1_609.344)).toBe("1.00 mi");
  });
});
