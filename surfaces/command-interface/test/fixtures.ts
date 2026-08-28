import type { EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import type { StyleSpecification } from "maplibre-gl";

const timestamp = "2026-06-20T00:00:00Z";
type PendingTaskResource = Extract<TaskResource, { status: "pending" }>;

export function metadataFixture(version = 1): EntityResource["metadata"] {
  return { created_at: timestamp, updated_at: timestamp, version };
}

export function entityFixture(overrides: Partial<EntityResource> = {}): EntityResource {
  return {
    entity_id: "entity-1",
    entity_type: "asset",
    subtype: null,
    alias: null,
    components: {},
    metadata: metadataFixture(),
    ...overrides
  };
}

export function taskFixture(overrides: Partial<PendingTaskResource> = {}): PendingTaskResource {
  return {
    task_id: "task-1",
    asset_id: "entity-1",
    command: "fixture.queued",
    input: {},
    status: "pending",
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides
  };
}

export function styleFixture(id: string): StyleSpecification {
  return { version: 8, sources: {}, layers: [], metadata: { id } };
}
