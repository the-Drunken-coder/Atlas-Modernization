import type { StyleSpecification } from "maplibre-gl";

// Local fallback used when MAP_STYLE_URL is not configured. It keeps MapLibre
// available for overlays without making an implicit public tile-provider choice.
export function defaultBlankStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#070a0f" } }]
  };
}
