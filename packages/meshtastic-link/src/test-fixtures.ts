import type { ResourceStatePublication } from "./types.js";

export function positionPublication(version: number): Extract<ResourceStatePublication, { resource_type: "entity" }> {
  const timestamp = `2026-09-02T12:00:${String(version).padStart(2, "0")}Z`;
  return {
    type: "state",
    resource_type: "entity",
    resource: {
      alias: "Alpha",
      entity_id: "asset-alpha",
      entity_type: "asset",
      subtype: null,
      components: { geometry: { type: "Point", coordinates: [-71.8, 42.2, 100 + version] } },
      metadata: { created_at: "2026-09-02T12:00:00Z", updated_at: timestamp, version }
    },
    observation_time: timestamp,
    path: "field",
    confirmation: "awaiting_core",
    operation_id: `position-${version}`,
    runtime_id: "runtime-alpha"
  };
}
