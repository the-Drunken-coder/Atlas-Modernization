import { describe, expect, it } from "vitest";
import { defaultMapStyle } from "./map-style.js";

describe("defaultMapStyle", () => {
  it("uses an OpenStreetMap raster basemap by default", () => {
    const style = defaultMapStyle();

    expect(style.sources.openstreetmap).toMatchObject({
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256
    });
    expect(style.layers.map((layer) => layer.id)).toEqual(["background", "openstreetmap"]);
  });
});
