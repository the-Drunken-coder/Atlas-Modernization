import { describe, expect, it } from "vitest";
import type { EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { emptySnapshot, type AtlasSnapshot } from "./store.js";
import { listEntities, tasksForEntity } from "./selectors.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

function entity(id: string): EntityResource {
  return { entity_id: id, entity_type: "asset", subtype: null, alias: id.toUpperCase(), components: {}, metadata };
}

function task(id: string, entityId: string): TaskResource {
  return { task_id: id, entity_id: entityId, status: "pending", components: {}, metadata };
}

describe("snapshot store", () => {
  it("provides an empty UI projection", () => {
    expect(emptySnapshot()).toEqual({ entities: {}, tasks: {} });
  });

  it("derives sorted entities and per-entity task history from an SDK snapshot", () => {
    const first = { ...task("t1", "a"), metadata: { ...metadata, updated_at: "2026-06-20T00:00:01Z" } };
    const second = { ...task("t2", "a"), metadata: { ...metadata, updated_at: "2026-06-20T00:00:05Z" } };
    const unrelated = task("t3", "b");
    const snapshot: AtlasSnapshot = {
      entities: { z: entity("z"), a: entity("a") },
      tasks: { [first.task_id]: first, [second.task_id]: second, [unrelated.task_id]: unrelated }
    };

    expect(listEntities(snapshot).map((entry) => entry.entity_id)).toEqual(["a", "z"]);
    expect(tasksForEntity(snapshot, "a").map((entry) => entry.task_id)).toEqual(["t2", "t1"]);
  });
});
