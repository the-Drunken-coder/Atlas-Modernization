import { describe, expect, it } from "vitest";
import type { EntityResource, TaskResource } from "../../../atlas_sdk/src/index.js";
import { emptySnapshot, snapshotFromDataset } from "./store.js";
import { listEntities, tasksForEntity } from "./selectors.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

function entity(id: string, type = "asset"): EntityResource {
  return { entity_id: id, entity_type: type, subtype: null, alias: id.toUpperCase(), components: {}, metadata };
}

function task(id: string, entityId: string, status = "pending"): TaskResource {
  return { task_id: id, entity_id: entityId, status, components: {}, metadata };
}

describe("snapshot store", () => {
  it("provides an empty UI snapshot", () => {
    expect(emptySnapshot()).toEqual({ entities: {}, tasks: {} });
  });

  it("builds a snapshot from a dataset", () => {
    const snapshot = snapshotFromDataset([entity("a")], [task("t1", "a")]);
    expect(Object.keys(snapshot.entities)).toEqual(["a"]);
    expect(Object.keys(snapshot.tasks)).toEqual(["t1"]);
  });

  it("derives sorted entities and per-entity task history", () => {
    const snapshot = snapshotFromDataset(
      [entity("z"), entity("a")],
      [
        { ...task("t1", "a"), metadata: { ...metadata, updated_at: "2026-06-20T00:00:01Z" } },
        { ...task("t2", "a"), metadata: { ...metadata, updated_at: "2026-06-20T00:00:05Z" } },
        task("t3", "b")
      ]
    );
    expect(listEntities(snapshot).map((entry) => entry.entity_id)).toEqual(["a", "z"]);
    expect(tasksForEntity(snapshot, "a").map((entry) => entry.task_id)).toEqual(["t2", "t1"]);
  });
});
