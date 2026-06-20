import { describe, expect, it } from "vitest";
import type { EntityResource } from "../../../atlas_sdk/src/index.js";
import { mapFeatures, trackEntities } from "./selectors.js";

const metadata = {
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-20T00:00:00Z",
  version: 1
};

function entity(value: Partial<EntityResource> & Pick<EntityResource, "entity_id" | "entity_type">): EntityResource {
  return {
    subtype: null,
    alias: null,
    components: {},
    metadata,
    ...value
  };
}

describe("Atlas selectors", () => {
  it("groups track entities", () => {
    expect(trackEntities([entity({ entity_id: "asset-1", entity_type: "asset" }), entity({ entity_id: "track-1", entity_type: "track" })]).map((item) => item.entity_id)).toEqual([
      "track-1"
    ]);
  });

  it("converts telemetry and geometry into map features", () => {
    const features = mapFeatures([
      entity({ entity_id: "asset-1", entity_type: "asset", components: { telemetry: { latitude: 40, longitude: -74 } } }),
      entity({ entity_id: "zone-1", entity_type: "geofeature", components: { geometry: { polygon: [[40, -74], [41, -74], [41, -73]] } } })
    ]);

    expect(features.map((feature) => feature.kind)).toEqual(["asset", "geofeature"]);
    expect(features[0].geometry).toEqual({ type: "Point", coordinates: [-74, 40] });
    expect(features[1].geometry.type).toBe("Polygon");
  });
});
