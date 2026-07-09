import { describe, expect, it } from "vitest";
import type { EntityResource, TaskResource } from "../../../atlas_sdk/src/index.js";
import { emptySnapshot, type AtlasSnapshot } from "./store.js";
import { listEntities, tasksForEntity } from "./selectors.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

function entity(id: string, type = "asset", version = 1): EntityResource {
  return { entity_id: id, entity_type: type, subtype: null, alias: id.toUpperCase(), components: {}, metadata: { ...metadata, version } };
}

function task(id: string, entityId: string, status = "pending", version = 1): TaskResource {
  return { task_id: id, entity_id: entityId, status, components: {}, metadata: { ...metadata, version } };
}

describe("snapshot store", () => {
  it("provides an empty UI projection", () => {
    expect(emptySnapshot).toEqual({ entities: {}, tasks: {} });
  });

  it("derives sorted entities and per-entity task history from an SDK snapshot", () => {
    const snapshot: AtlasSnapshot = {
      entities: { z: entity("z"), a: entity("a") },
      tasks: {
        t1: { ...task("t1", "a"), metadata: { ...metadata, updated_at: "2026-06-20T00:00:01Z" } },
        t2: { ...task("t2", "a"), metadata: { ...metadata, updated_at: "2026-06-20T00:00:05Z" } },
        t3: task("t3", "b")
      }
    };
    expect(listEntities(snapshot).map((entry) => entry.entity_id)).toEqual(["a", "z"]);
    expect(tasksForEntity(snapshot, "a").map((entry) => entry.task_id)).toEqual(["t2", "t1"]);
  });
});
