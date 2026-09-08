import type { Map as MlMap } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import {
  clampResizedRect,
  keyboardDelta,
  regionAfterTransform,
  regionFromScreenRect,
  type ScreenRect
} from "./map-region-geometry.js";

describe("map region geometry", () => {
  it.each([
    ["ArrowLeft", false, "move", { x: -10, y: 0 }],
    ["ArrowRight", true, "move", { x: 40, y: 0 }],
    ["ArrowUp", true, "move", { x: 0, y: -40 }],
    ["ArrowDown", false, "move", { x: 0, y: 10 }],
    ["ArrowRight", true, "width", { x: 40, y: 0 }],
    ["ArrowDown", false, "width", null],
    ["ArrowLeft", false, "height", null],
    ["ArrowDown", true, "height", { x: 0, y: 40 }],
    ["ArrowLeft", false, "both", { x: -10, y: 0 }],
    ["ArrowUp", true, "both", { x: 0, y: -40 }],
    ["Enter", false, "both", null]
  ] as const)("maps %s with Shift=%s for %s", (key, shiftKey, transform, expected) => {
    expect(keyboardDelta(key, shiftKey, transform)).toEqual(expected);
  });

  it.each([
    ["move", { x: 200, y: 200 }, { west: 68, south: 68, east: 108, north: 118 }],
    ["width", { x: -100, y: -100 }, { west: 20, south: 30, east: 52, north: 80 }],
    ["height", { x: -100, y: -100 }, { west: 20, south: 30, east: 60, north: 62 }],
    ["both", { x: -100, y: -100 }, { west: 20, south: 30, east: 52, north: 62 }]
  ] as const)("clamps and projects a %s transform", (transform, delta, expected) => {
    const map = {
      unproject: ([x, y]: [number, number]) => ({ lng: x, lat: y })
    } as unknown as MlMap;

    expect(
      regionAfterTransform(map, { left: 20, top: 30, width: 40, height: 50 }, delta, transform, {
        width: 100,
        height: 100
      })
    ).toEqual(expected);
  });

  it("rejects a move into a date-line crossing", () => {
    const map = {
      unproject: ([x, y]: [number, number]) => ({ lng: x < 100 ? 179.8 : -179.8, lat: y })
    } as unknown as MlMap;

    expect(
      regionAfterTransform(map, { left: 40, top: 20, width: 40, height: 40 }, { x: 30, y: 0 }, "move", {
        width: 200,
        height: 100
      })
    ).toBeNull();
  });

  it("preserves a wide non-crossing screen selection", () => {
    const map = {
      unproject: ([x, y]: [number, number]) => ({ lng: x - 120, lat: y })
    } as unknown as MlMap;

    expect(regionFromScreenRect(map, { left: 0, top: 0, width: 240, height: 100 })).toEqual({
      west: -120,
      south: 0,
      east: 120,
      north: 100
    });
  });

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
