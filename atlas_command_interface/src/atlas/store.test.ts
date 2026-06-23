import { describe, expect, it } from "vitest";
import type { EntityResource, TaskResource } from "../../../atlas_sdk/src/index.js";
import { applyWatchEvent, emptySnapshot, snapshotFromDataset } from "./store.js";
import { listEntities, tasksForEntity } from "./selectors.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

function entity(id: string, type = "asset", version = 1): EntityResource {
  return { entity_id: id, entity_type: type, subtype: null, alias: id.toUpperCase(), components: {}, metadata: { ...metadata, version } };
}

function task(id: string, entityId: string, status = "pending", version = 1): TaskResource {
  return { task_id: id, entity_id: entityId, status, components: {}, metadata: { ...metadata, version } };
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

    const renamed = { ...entity("a", "asset", 2), alias: "Renamed" };
    snapshot = applyWatchEvent(snapshot, { event: "update", resource_type: "entity", id: "a", version: 2, resource: renamed });
    expect(snapshot.entities.a.alias).toBe("Renamed");

    snapshot = applyWatchEvent(snapshot, { event: "recovered", resource_type: "entity", id: "b", version: 3, resource: entity("b", "asset", 3) });
    expect(Object.keys(snapshot.entities).sort()).toEqual(["a", "b"]);
  });

  it("ignores stale entity and task events by resource version", () => {
    const snapshot = snapshotFromDataset([entity("a", "asset", 3)], [task("t1", "a", "pending", 3)]);
    const staleEntity = { ...entity("a", "asset", 2), alias: "Stale" };
    const afterEntity = applyWatchEvent(snapshot, { event: "update", resource_type: "entity", id: "a", version: 2, resource: staleEntity });
    expect(afterEntity).toBe(snapshot);

    const staleTask = task("t1", "a", "acked", 2);
    const afterTask = applyWatchEvent(snapshot, { event: "update", resource_type: "task", id: "t1", version: 2, resource: staleTask });
    expect(afterTask).toBe(snapshot);

    const afterDelete = applyWatchEvent(snapshot, { event: "delete", resource_type: "entity", id: "a", version: 2 });
    expect(afterDelete).toBe(snapshot);
  });

  it("ignores delete events with invalid versions", () => {
    const snapshot = snapshotFromDataset([entity("a", "asset", 3)], [task("t1", "a", "pending", 3)]);

    expect(applyWatchEvent(snapshot, { event: "delete", resource_type: "entity", id: "a" } as never)).toBe(snapshot);
    expect(applyWatchEvent(snapshot, { event: "delete", resource_type: "entity", id: "a", version: Number.NaN })).toBe(snapshot);
    expect(applyWatchEvent(snapshot, { event: "delete", resource_type: "task", id: "t1" } as never)).toBe(snapshot);
    expect(applyWatchEvent(snapshot, { event: "delete", resource_type: "task", id: "t1", version: Number.NaN })).toBe(snapshot);
  });

  it("removes entities on delete events", () => {
    let snapshot = snapshotFromDataset([entity("a"), entity("b")], []);
    snapshot = applyWatchEvent(snapshot, { event: "delete", resource_type: "entity", id: "a", version: 4 });
    expect(Object.keys(snapshot.entities)).toEqual(["b"]);
  });

  it("removes resources on local delete events", () => {
    let snapshot = snapshotFromDataset([entity("a")], [task("t1", "a")]);
    snapshot = applyWatchEvent(snapshot, { event: "local_delete", resource_type: "entity", id: "a" });
    snapshot = applyWatchEvent(snapshot, { event: "local_delete", resource_type: "task", id: "t1" });
    expect(snapshot).toEqual(emptySnapshot());
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
