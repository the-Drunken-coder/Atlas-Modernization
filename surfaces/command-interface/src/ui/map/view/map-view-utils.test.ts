import type { Map as MlMap } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import { geographicBoundsFromScreenRect } from "./map-view-utils.js";

describe("geographicBoundsFromScreenRect", () => {
  it("preserves a wide non-crossing screen selection", () => {
    const map = mapForLongitude((x) => x - 120);

    expect(
      geographicBoundsFromScreenRect(map, {
        left: 0,
        top: 0,
        width: 240,
        height: 100
      })
    ).toEqual({ west: -120, south: 0, east: 120, north: 100 });
  });

  it("unwraps a narrow selection across the antimeridian", () => {
    const map = mapForLongitude((x) => {
      const unwrapped = 179 + x / 50;
      return ((unwrapped + 180) % 360) - 180;
    });

    expect(
      geographicBoundsFromScreenRect(map, {
        left: 0,
        top: 10,
        width: 100,
        height: 20
      })
    ).toEqual({ west: 179, south: 10, east: 181, north: 30 });
  });
});

function mapForLongitude(longitudeAtX: (x: number) => number): Pick<MlMap, "unproject"> {
  const unproject = vi.fn((point: [number, number] | { x: number; y: number }) => {
    const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
    return { lng: longitudeAtX(x), lat: y };
  });
  return { unproject } as unknown as Pick<MlMap, "unproject">;
}
