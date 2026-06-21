import { describe, expect, it } from "vitest";
import type { EntityResource, ObjectResource, TaskResource } from "../../../atlas_sdk/src/index.js";
import {
  assetEntities,
  entityDisplayName,
  entityStatus,
  entityTasks,
  geofeatureEntities,
  mapFeatures,
  objectSummary,
  trackEntities
} from "./selectors.js";

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
  it("groups entities by known map-facing types", () => {
    const entities = [
      entity({ entity_id: "asset-1", entity_type: "asset" }),
      entity({ entity_id: "track-1", entity_type: "track" }),
      entity({ entity_id: "zone-1", entity_type: "geofeature" })
    ];

    expect(assetEntities(entities).map((item) => item.entity_id)).toEqual(["asset-1"]);
    expect(trackEntities(entities).map((item) => item.entity_id)).toEqual(["track-1"]);
    expect(geofeatureEntities(entities).map((item) => item.entity_id)).toEqual(["zone-1"]);
  });

  it("formats entity, task, and object display values", () => {
    const rover = entity({ entity_id: "asset-1", entity_type: "asset", alias: "Rover One", components: { status: { value: "ready" } } });
    const linked = entity({ entity_id: "asset-2", entity_type: "asset", components: { communications: { link_state: "degraded" } } });
    const firstTask = task("task-1", "asset-1", 2);
    const secondTask = task("task-2", "asset-1", 4);

    expect(entityDisplayName(rover)).toBe("Rover One");
    expect(entityDisplayName(linked)).toBe("asset-2");
    expect(entityStatus(rover)).toBe("ready");
    expect(entityStatus(linked)).toBe("degraded");
    expect(entityStatus(entity({ entity_id: "asset-3", entity_type: "asset" }))).toBe("unknown");
    expect(entityTasks(rover, [firstTask, task("other-task", "asset-2", 5), secondTask]).map((item) => item.task_id)).toEqual(["task-2", "task-1"]);
    expect(entityTasks(undefined, [firstTask])).toEqual([]);
    expect(objectSummary(object({ type: "image", content_type: "image/png", size_bytes: 1024 }))).toBe("image · image/png · 1024 bytes");
    expect(objectSummary(object({ type: null, content_type: null, size_bytes: null }))).toBe("object");
  });

  it("converts telemetry and legacy polygon geometry into map features", () => {
    const features = mapFeatures([
      entity({ entity_id: "asset-1", entity_type: "asset", components: { telemetry: { latitude: 40, longitude: -74 } } }),
      entity({ entity_id: "zone-1", entity_type: "geofeature", components: { geometry: { polygon: [[40, -74], [41, -74], [41, -73]] } } })
    ]);

    expect(features.map((feature) => feature.kind)).toEqual(["asset", "geofeature"]);
    expect(features[0].geometry).toEqual({ type: "Point", coordinates: [-74, 40] });
    expect(features[1].geometry).toEqual({
      type: "Polygon",
      coordinates: [[[-73, 41], [-74, 41], [-74, 40], [-73, 41]]]
    });
  });

  it("converts GeoJSON geometry into map features and normalizes polygon winding", () => {
    const features = mapFeatures([
      entity({ entity_id: "point-1", entity_type: "asset", components: { geometry: { type: "Point", coordinates: [-74, 40] } } }),
      entity({ entity_id: "line-1", entity_type: "track", components: { geometry: { type: "LineString", coordinates: [[-74, 40], [-73, 41]] } } }),
      entity({
        entity_id: "poly-1",
        entity_type: "geofeature",
        components: {
          geometry: {
            type: "Polygon",
            coordinates: [
              [[0, 0], [0, 1], [1, 1], [1, 0]],
              [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]
            ]
          }
        }
      })
    ]);

    expect(features.map((feature) => feature.geometry.type)).toEqual(["Point", "LineString", "Polygon"]);
    expect(features[0].geometry).toEqual({ type: "Point", coordinates: [-74, 40] });
    expect(features[1].geometry).toEqual({ type: "LineString", coordinates: [[-74, 40], [-73, 41]] });
    expect(features[2].geometry).toEqual({
      type: "Polygon",
      coordinates: [
        [[1, 0], [1, 1], [0, 1], [0, 0], [1, 0]],
        [[0.2, 0.8], [0.8, 0.8], [0.8, 0.2], [0.2, 0.2], [0.2, 0.8]]
      ]
    });
  });

  it("converts legacy point and line geometry into longitude-latitude order", () => {
    const features = mapFeatures([
      entity({ entity_id: "point-1", entity_type: "asset", components: { geometry: { point_lat: 40, point_lng: -74 } } }),
      entity({ entity_id: "line-1", entity_type: "track", components: { geometry: { line: [[40, -74], [41, -73]] } } })
    ]);

    expect(features[0].geometry).toEqual({ type: "Point", coordinates: [-74, 40] });
    expect(features[1].geometry).toEqual({ type: "LineString", coordinates: [[-74, 40], [-73, 41]] });
  });

  it("drops unsupported entity types and invalid geometry", () => {
    const features = mapFeatures([
      entity({ entity_id: "unknown-1", entity_type: "operator", components: { telemetry: { latitude: 40, longitude: -74 } } }),
      entity({ entity_id: "bad-point", entity_type: "asset", components: { geometry: { type: "Point", coordinates: [Infinity, 40] } } }),
      entity({ entity_id: "bad-bounds", entity_type: "asset", components: { geometry: { point_lat: 95, point_lng: -74 } } }),
      entity({ entity_id: "short-line", entity_type: "track", components: { geometry: { type: "LineString", coordinates: [[-74, 40]] } } }),
      entity({ entity_id: "empty-polygon", entity_type: "geofeature", components: { geometry: { polygon: [] } } }),
      entity({ entity_id: "degenerate-polygon", entity_type: "geofeature", components: { geometry: { polygon: [[40, -74], [40, -74], [40, -74]] } } })
    ]);

    expect(features).toEqual([]);
  });
});

function task(taskId: string, entityId: string, version: number): TaskResource {
  return {
    task_id: taskId,
    status: "pending",
    entity_id: entityId,
    components: {},
    metadata: { ...metadata, version }
  };
}

function object(value: Pick<ObjectResource, "type" | "content_type" | "size_bytes">): ObjectResource {
  return {
    object_id: "object-1",
    path: null,
    usage_hints: [],
    bucket: null,
    metadata,
    ...value
  };
}
