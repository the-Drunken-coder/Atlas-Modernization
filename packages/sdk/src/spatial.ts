import type { MapArea } from "./protocol.js";

/** Returns the spherical surface area represented by a non-crossing map rectangle. */
export function mapAreaSquareMeters(area: MapArea): number {
  const radians = Math.PI / 180;
  const earthRadiusMeters = 6_371_008.8;
  return (
    earthRadiusMeters ** 2 *
    (area.east - area.west) *
    radians *
    (Math.sin(area.north * radians) - Math.sin(area.south * radians))
  );
}
