import type { EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { activeTasks, listEntities, queuedTasks, tasksForAsset } from "./selectors.js";
import { type AtlasSnapshot, emptySnapshot } from "./store.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

function entity(id: string): EntityResource {
  return { entity_id: id, entity_type: "asset", subtype: null, alias: id.toUpperCase(), components: {}, metadata };
}

function task(id: string, entityId: string): TaskResource {
  return {
    task_id: id,
    asset_id: entityId,
    command: "fixture.queued",
    input: {},
    status: "pending",
    created_at: metadata.created_at,
    updated_at: metadata.updated_at
  };
}

describe("snapshot store", () => {
  it("provides an empty UI projection", () => {
    expect(emptySnapshot()).toEqual({ entities: {}, tasks: {} });
  });

  it("derives sorted entities and per-entity task history from an SDK snapshot", () => {
    const first = { ...task("t1", "a"), updated_at: "2026-06-20T00:00:01Z" };
    const second = { ...task("t2", "a"), updated_at: "2026-06-20T00:00:05Z" };
    const unrelated = task("t3", "b");
    const snapshot: AtlasSnapshot = {
      entities: { z: entity("z"), a: entity("a") },
      tasks: { [first.task_id]: first, [second.task_id]: second, [unrelated.task_id]: unrelated }
    };

    expect(listEntities(snapshot).map((entry) => entry.entity_id)).toEqual(["a", "z"]);
    expect(tasksForAsset(snapshot, "a").map((entry) => entry.task_id)).toEqual(["t2", "t1"]);
  });

  it("derives every active Task and the authoritative queue order", () => {
    const asset = entity("a");
    const activeLater = {
      ...task("active-2", asset.entity_id),
      status: "in_progress" as const,
      created_at: "2026-06-20T00:00:02Z"
    };
    const activeEarlier = {
      ...task("active-1", asset.entity_id),
      status: "in_progress" as const,
      created_at: "2026-06-20T00:00:01Z"
    };
    const queuedLater = {
      ...task("queued-2", asset.entity_id),
      status: "acknowledged" as const,
      created_at: "2026-06-20T00:00:04Z",
      updated_at: "2026-06-20T00:00:10Z"
    };
    const queuedEarlier = {
      ...task("queued-1", asset.entity_id),
      created_at: "2026-06-20T00:00:03Z",
      updated_at: "2026-06-20T00:00:11Z"
    };
    const snapshot: AtlasSnapshot = {
      entities: { [asset.entity_id]: asset },
      tasks: {
        [activeLater.task_id]: activeLater,
        [queuedLater.task_id]: queuedLater,
        [activeEarlier.task_id]: activeEarlier,
        [queuedEarlier.task_id]: queuedEarlier
      }
    };

    expect(activeTasks(snapshot, asset).map((entry) => entry.task_id)).toEqual(["active-1", "active-2"]);
    expect(queuedTasks(snapshot, asset).map((entry) => entry.task_id)).toEqual(["queued-1", "queued-2"]);
  });
});
