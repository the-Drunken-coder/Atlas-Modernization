import { describe, expect, it } from "vitest";
import { defaultMapStyle } from "./map-style.js";

describe("defaultMapStyle", () => {
  it("uses the TileMux MapTiler OpenStreetMap dark basemap by default", () => {
    const style = defaultMapStyle();

    expect(style.sources["maptiler-osm-dark"]).toMatchObject({
      type: "raster",
      tiles: ["/map-tiles/maptiler-osm-dark/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 22,
      attribution: '&copy; <a href="https://www.maptiler.com/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    });
    expect(style.layers.map((layer) => layer.id)).toEqual(["background", "maptiler-osm-dark-raster"]);
  });
});
