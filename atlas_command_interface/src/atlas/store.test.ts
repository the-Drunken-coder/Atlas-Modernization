import { describe, expect, it } from "vitest";
import type { EntityResource, TaskResource } from "../../../atlas_sdk/src/index.js";
import { applyWatchEvent, emptySnapshot, snapshotFromDataset } from "./store.js";
import { listEntities, tasksForEntity } from "./selectors.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

function entity(id: string, type = "asset"): EntityResource {
  return { entity_id: id, entity_type: type, subtype: null, alias: id.toUpperCase(), components: {}, metadata };
}

function task(id: string, entityId: string, status = "pending"): TaskResource {
  return { task_id: id, entity_id: entityId, status, components: {}, metadata };
}

describe("snapshot store", () => {
  it("builds a snapshot from a dataset", () => {
    const snapshot = snapshotFromDataset([entity("a")], [task("t1", "a")]);
    expect(Object.keys(snapshot.entities)).toEqual(["a"]);
    expect(Object.keys(snapshot.tasks)).toEqual(["t1"]);
  });

  it("upserts entities on create/update/recovered events", () => {
    let snapshot = emptySnapshot();
    snapshot = applyWatchEvent(snapshot, { event: "create", resource_type: "entity", id: "a", version: 1, resource: entity("a") });
    expect(snapshot.entities.a.alias).toBe("A");

    const renamed = { ...entity("a"), alias: "Renamed" };
    snapshot = applyWatchEvent(snapshot, { event: "update", resource_type: "entity", id: "a", version: 2, resource: renamed });
    expect(snapshot.entities.a.alias).toBe("Renamed");

    snapshot = applyWatchEvent(snapshot, { event: "recovered", resource_type: "entity", id: "b", version: 3, resource: entity("b") });
    expect(Object.keys(snapshot.entities).sort()).toEqual(["a", "b"]);
  });

  it("removes entities on delete events", () => {
    let snapshot = snapshotFromDataset([entity("a"), entity("b")], []);
    snapshot = applyWatchEvent(snapshot, { event: "delete", resource_type: "entity", id: "a", version: 4 });
    expect(Object.keys(snapshot.entities)).toEqual(["b"]);
  });

  it("ignores object events and unchanged deletes by reference", () => {
    const snapshot = snapshotFromDataset([entity("a")], []);
    const afterObject = applyWatchEvent(snapshot, { event: "update", resource_type: "object", id: "command_catalog", version: 9, resource: {} as never });
    expect(afterObject).toBe(snapshot);
    const afterMissingDelete = applyWatchEvent(snapshot, { event: "delete", resource_type: "task", id: "missing", version: 9 });
    expect(afterMissingDelete).toBe(snapshot);
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
