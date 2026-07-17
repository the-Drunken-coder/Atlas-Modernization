import { describe, expect, it, vi } from "vitest";
import { AtlasClient, type FeedEvent } from "../src";
import { entity, FakeCore, object, task } from "./support/fake-core.js";

describe("AtlasClient simulation", () => {
  it("matches the simulation ledger at checkpoints and run end", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
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
        // Mid-simulation task delete is dropped from sockets to force gap reconciliation.
        if (i === 10) {
          const event = core.deleteTask("task-sim-2");
          if (event) core.emit(event, { dropForSockets: true, record: false });
        }
        // Entity delete follows later so the ledger sees a live tombstone after recovery.
        if (i === 14) {
          const event = core.deleteEntity("asset-sim-2");
          if (event) core.emit(event, { record: false });
        }
        // Object delete lands near the tail to cover all resource tombstone types.
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
    for (const deletion of core.deletions) {
      if (deletion.resource_type === "entity" && !core.entities.has(deletion.id)) {
        await expect(client.entities.get(deletion.id)).rejects.toMatchObject({
          status: 404,
          errorCode: "ENTITY_NOT_FOUND"
        });
      }
      if (deletion.resource_type === "task" && !core.tasks.has(deletion.id)) {
        await expect(client.tasks.get(deletion.id)).rejects.toMatchObject({ status: 404, errorCode: "TASK_NOT_FOUND" });
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
