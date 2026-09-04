import type { Map as MlMap } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { clampResizedRect, regionFromScreenRect, type ScreenRect } from "./map-region-geometry.js";

describe("map region geometry", () => {
  it("rejects a rectangle that crosses the date line instead of swapping its longitudes", () => {
    const map = {
      unproject: ([x, y]: [number, number]) => ({ lng: x === 0 ? 179.8 : -179.8, lat: y })
    } as unknown as MlMap;

    expect(regionFromScreenRect(map, { left: 0, top: 0, width: 32, height: 32 })).toBeNull();
  });

  it("rejects unwrapped longitude endpoints outside the geographic range", () => {
    const map = {
      unproject: ([x, y]: [number, number]) => ({ lng: x + 200, lat: y })
    } as unknown as MlMap;

    expect(regionFromScreenRect(map, { left: 0, top: 0, width: 32, height: 32 })).toBeNull();
  });

  it("uses the same clipped resize minimum for either selector", () => {
    const clippedRect: ScreenRect = { left: -10, top: -8, width: 20, height: 18 };
    const expected: ScreenRect = { left: -10, top: -8, width: 42, height: 40 };

    expect(clampResizedRect(clippedRect, { x: -100, y: -100 }, "both")).toEqual(expected);
  });
});
