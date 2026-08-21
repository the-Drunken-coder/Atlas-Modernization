import { describe, expect, it, vi } from "vitest";
import { AtlasClient, type FeedEvent } from "../src";
import { createAtlasClient } from "./support/client.js";
import { entity, FakeCore, object, task } from "./support/fake-core.js";

describe("AtlasClient simulation", () => {
  it("matches the simulation ledger at checkpoints and run end", async () => {
    const core = new FakeCore();
    const client = createAtlasClient(core, {
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    try {
      await client.connectFeed();

      for (let i = 0; i < 24; i++) {
        if (i % 3 === 0) {
          const entityID = `asset-sim-${i % 5}`;
          const value = core.upsertEntity({ ...entity(entityID), alias: `asset ${i}` });
          const event: FeedEvent = {
            event: "update",
            resource_type: "entity",
            id: entityID,
            version: value.metadata.version,
            resource: value
          };
          core.emit(event, { dropForSockets: i === 6, record: false });
        }
        const id = `task-sim-${i % 4}`;
        const value = core.upsertTask({
          ...task(id, `asset-${i % 3}`),
          status: i % 2 === 0 ? "pending" : "acknowledged"
        });
        const event: FeedEvent = {
          event: "update",
          resource_type: "task",
          id,
          version: value.metadata.version,
          resource: value
        };
        core.emit(event, { dropForSockets: i === 7, record: false });
        if (i % 4 === 0) {
          const objectID = `object-sim-${i % 3}`;
          const value = core.upsertObject({ ...object(objectID), type: i % 8 === 0 ? "image" : "log" });
          const objectEvent: FeedEvent = {
            event: "update",
            resource_type: "object",
            id: objectID,
            version: value.metadata.version,
            resource: value
          };
          core.emit(objectEvent, { dropForSockets: i === 12, record: false });
        }
        // A dropped terminal Task update forces gap reconciliation.
        if (i === 10) {
          const failed = core.upsertTask({
            ...core.tasks.get("task-sim-2")!,
            status: "failed",
            failure: { code: "execution_failed", message: "simulated failure" },
            finished_at: "2026-06-12T12:01:00Z"
          });
          core.emit(
            {
              event: "update",
              resource_type: "task",
              id: failed.task_id,
              version: failed.metadata.version,
              resource: failed
            },
            { dropForSockets: true, record: false }
          );
        }
        // Entity delete follows later so the ledger sees a live delete event after recovery.
        if (i === 14) {
          const event = core.deleteEntity("asset-sim-2");
          if (event) core.emit(event, { record: false });
        }
        // Object delete lands near the tail to cover every resource delete-event type.
        if (i === 18) {
          const event = core.deleteObject("object-sim-1");
          if (event) core.emit(event, { record: false });
        }
        if (i % 6 === 5) {
          await assertClientMatchesLedger(client, core);
        }
      }
      await assertClientMatchesLedger(client, core);
    } finally {
      client.sync.stop();
    }
  });
});

async function assertClientMatchesLedger(client: AtlasClient, core: FakeCore): Promise<void> {
  await vi.waitFor(async () => {
    for (const entityValue of core.entities.values()) {
      await expect(client.entities.get(entityValue.entity_id)).resolves.toEqual(entityValue);
    }
    for (const taskValue of core.tasks.values()) {
      await expect(client.tasks.get(taskValue.task_id)).resolves.toEqual(taskValue);
    }
    for (const objectValue of core.objects.values()) {
      await expect(client.objects.get(objectValue.object_id)).resolves.toEqual({
        ...objectValue,
        extra: { ...(core.objectExtras.get(objectValue.object_id) ?? {}) }
      });
    }
    for (const deletion of core.deleteEvents) {
      if (deletion.resource_type === "entity" && !core.entities.has(deletion.id)) {
        await expect(client.entities.get(deletion.id)).rejects.toMatchObject({
          status: 404,
          errorCode: "ENTITY_NOT_FOUND"
        });
      }
      if (deletion.resource_type === "object" && !core.objects.has(deletion.id)) {
        await expect(client.objects.get(deletion.id)).rejects.toMatchObject({
          status: 404,
          errorCode: "OBJECT_NOT_FOUND"
        });
      }
    }
  });
}
