import type { StyleSpecification } from "maplibre-gl";

export type MapStyleOption = {
  id: string;
  label: string;
  style: StyleSpecification;
};

export const TILEMUX_MAP_STYLES: MapStyleOption[] = [
  {
    id: "maptiler-osm-dark",
    label: "MapTiler OSM Dark",
    style: tilemuxRasterStyle({
      id: "maptiler-osm-dark",
      ext: "png",
      maxzoom: 22,
      attribution: '&copy; <a href="https://www.maptiler.com/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    })
  },
  {
    id: "esri-world-imagery",
    label: "Esri World Imagery",
    style: tilemuxRasterStyle({
      id: "esri-world-imagery",
      ext: "png",
      maxzoom: 19,
      attribution: '&copy; <a href="https://www.esri.com/">Esri</a>'
    })
  },
  {
    id: "usgs-topo",
    label: "USGS Topo",
    style: tilemuxRasterStyle({
      id: "usgs-topo",
      ext: "png",
      maxzoom: 16,
      attribution: "Tiles courtesy of the U.S. Geological Survey"
    })
  }
];

export function defaultMapStyle(): StyleSpecification {
  return TILEMUX_MAP_STYLES[0].style;
}

function tilemuxRasterStyle(options: { id: string; ext: string; maxzoom: number; attribution: string }): StyleSpecification {
  return {
    version: 8,
    sources: {
      [options.id]: {
        type: "raster",
        tiles: [`/map-tiles/${options.id}/{z}/{x}/{y}.${options.ext}`],
        tileSize: 256,
        maxzoom: options.maxzoom,
        attribution: options.attribution
      }
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#070a0f" } },
      {
        id: `${options.id}-raster`,
        type: "raster",
        source: options.id,
        paint: {
          "raster-opacity": options.id === "maptiler-osm-dark" ? 0.92 : 0.82,
          "raster-saturation": options.id === "esri-world-imagery" ? -0.18 : 0,
          "raster-contrast": options.id === "usgs-topo" ? 0.08 : 0
        }
      }
    ]
  };
}
