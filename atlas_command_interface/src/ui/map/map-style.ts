import type { StyleSpecification } from "maplibre-gl";

export function defaultMapStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      openstreetmap: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#070a0f" } },
      {
        id: "openstreetmap",
        type: "raster",
        source: "openstreetmap",
        paint: {
          "raster-opacity": 0.72,
          "raster-saturation": -0.6,
          "raster-contrast": 0.15
        }
      }
    ]
  };
}
