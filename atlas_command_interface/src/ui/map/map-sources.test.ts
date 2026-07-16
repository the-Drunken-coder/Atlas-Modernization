import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { buildMapSources } from "./map-sources.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

function entity(overrides: Partial<EntityResource>): EntityResource {
  return { entity_id: "e", entity_type: "asset", subtype: null, alias: null, components: {}, metadata, ...overrides };
}

describe("buildMapSources", () => {
  it("renders assets from telemetry as point features", () => {
    const sources = buildMapSources(
      [
        entity({
          entity_id: "asset-1",
          subtype: "ground_rover",
          components: {
            custom_symbol: { model_id: "Atlas-Rover-01" },
            telemetry: { latitude: 40.1, longitude: -74.2, heading_deg: 90 }
          }
        })
      ],
      undefined
    );
    expect(sources.assets.features).toHaveLength(1);
    expect(sources.assets.features[0].geometry).toEqual({ type: "Point", coordinates: [-74.2, 40.1] });
    expect(sources.assets.features[0].properties.heading).toBe(90);
    expect(sources.assets.features[0].properties.subtype).toBe("ground_rover");
    expect(sources.assets.features[0].properties.modelId).toBe("Atlas-Rover-01");
  });

  it("renders tracks as read-only point features", () => {
    const sources = buildMapSources(
      [entity({ entity_id: "track-1", entity_type: "track", components: { telemetry: { latitude: 1, longitude: 2 } } })],
      undefined
    );
    expect(sources.tracks.features).toHaveLength(1);
    expect(sources.tracks.features[0].properties.kind).toBe("track");
  });

  it("renders geofeature Point, LineString and Polygon geometries", () => {
    const sources = buildMapSources(
      [
        entity({ entity_id: "geo-point", entity_type: "geofeature", components: { geometry: { type: "Point", coordinates: [1, 2] } } }),
        entity({
          entity_id: "geo-line",
          entity_type: "geofeature",
          components: {
            geometry: {
              type: "LineString",
              coordinates: [
                [1, 2],
                [3, 4]
              ]
            }
          }
        }),
        entity({
          entity_id: "geo-poly",
          entity_type: "geofeature",
          components: {
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0]
                ]
              ]
            }
          }
        })
      ],
      "geo-line"
    );
    expect(sources.geofeatures.features.map((f) => f.geometry.type)).toEqual(["Point", "LineString", "Polygon"]);
    expect(sources.geofeatures.features.find((f) => f.id === "geo-line")?.properties.selected).toBe(true);
  });

  it("renders circle Features as display polygons", () => {
    const sources = buildMapSources(
      [
        entity({
          entity_id: "geo-circle",
          entity_type: "geofeature",
          components: {
            geometry: {
              type: "Feature",
              geometry: { type: "Point", coordinates: [-74.2, 40.1] },
              properties: { shape: "circle", radius_m: 500 }
            }
          }
        })
      ],
      undefined
    );
    expect(sources.geofeatures.features).toHaveLength(1);
    expect(sources.geofeatures.features[0].geometry.type).toBe("Polygon");
  });

  it("skips entities without a usable position and non-console kinds", () => {
    const sources = buildMapSources([entity({ entity_id: "asset-blind", components: {} }), entity({ entity_id: "sensor", entity_type: "sensor" })], undefined);
    expect(sources.assets.features).toHaveLength(0);
    expect(sources.tracks.features).toHaveLength(0);
    expect(sources.geofeatures.features).toHaveLength(0);
  });
});
