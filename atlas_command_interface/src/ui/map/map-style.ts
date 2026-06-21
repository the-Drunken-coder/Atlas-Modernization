import type { StyleSpecification } from "maplibre-gl";

// A dark raster basemap that needs no API key. CARTO basemaps are free to use
// with attribution. When MAP_STYLE_URL is configured the app uses that instead.
export function defaultDarkStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      "carto-dark": {
        type: "raster",
        tiles: [
          "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
        ],
        tileSize: 256,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, © <a href="https://carto.com/attributions">CARTO</a>'
      }
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#070a0f" } },
      { id: "carto-dark", type: "raster", source: "carto-dark", paint: { "raster-brightness-max": 0.85 } }
    ]
  };
}
