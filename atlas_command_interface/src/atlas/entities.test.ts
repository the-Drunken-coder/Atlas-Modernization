import { describe, expect, it } from "vitest";
import type { EntityResource } from "../../../atlas_sdk/src/index.js";
import {
  entityClassification,
  entityDisplayName,
  entityKind,
  entityLinkState,
  entityPosition,
  heartbeatLevel,
  isSelectableKind
} from "./entities.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

function entity(overrides: Partial<EntityResource>): EntityResource {
  return { entity_id: "e1", entity_type: "asset", subtype: null, alias: null, components: {}, metadata, ...overrides };
}

describe("entity accessors", () => {
  it("classifies known entity kinds and ignores others", () => {
    expect(entityKind(entity({ entity_type: "asset" }))).toBe("asset");
    expect(entityKind(entity({ entity_type: "track" }))).toBe("track");
    expect(entityKind(entity({ entity_type: "geofeature" }))).toBe("geofeature");
    expect(entityKind(entity({ entity_type: "sensor" }))).toBe("other");
    expect(isSelectableKind(entity({ entity_type: "sensor" }))).toBe(false);
  });

  it("uses alias then entity_id for the display name", () => {
    expect(entityDisplayName(entity({ alias: "Rover 1" }))).toBe("Rover 1");
    expect(entityDisplayName(entity({ alias: null, entity_id: "asset-7" }))).toBe("asset-7");
  });

  it("prefers telemetry location, then geometry, for position", () => {
    expect(entityPosition(entity({ components: { telemetry: { latitude: 40.1, longitude: -74.2 } } }))).toEqual([-74.2, 40.1]);
    expect(entityPosition(entity({ components: { geometry: { type: "Point", coordinates: [-1, 2] } } }))).toEqual([-1, 2]);
    expect(entityPosition(entity({ components: {} }))).toBeUndefined();
  });

  it("rejects non-finite telemetry positions", () => {
    expect(entityPosition(entity({ components: { telemetry: { latitude: Number.NaN, longitude: -74.2 } } }))).toBeUndefined();
    expect(entityPosition(entity({ components: { telemetry: { latitude: 40.1, longitude: Infinity } } }))).toBeUndefined();
  });

  it("reads structured indicators", () => {
    expect(entityLinkState(entity({ components: { communications: { link_state: "degraded" } } }))).toBe("degraded");
    expect(entityClassification(entity({ components: { mil_view: { classification: "hostile" } } }))).toBe("hostile");
  });

  it("grades heartbeat freshness against thresholds", () => {
    const now = Date.parse("2026-06-20T00:10:00Z");
    expect(heartbeatLevel("2026-06-20T00:09:50Z", now)).toBe("fresh");
    expect(heartbeatLevel("2026-06-20T00:09:00Z", now)).toBe("stale");
    expect(heartbeatLevel("2026-06-20T00:00:00Z", now)).toBe("offline");
    expect(heartbeatLevel("2026-06-20T00:10:01Z", now)).toBeUndefined();
    expect(heartbeatLevel(undefined, now)).toBeUndefined();
  });
});
