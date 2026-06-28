import { describe, expect, it } from "vitest";
import { createFakeAtlasCore } from "./fake-atlas.js";

describe("fake Atlas core", () => {
  it("returns pending entity tasks from check-in", async () => {
    const core = createFakeAtlasCore();
    const client = core.factory();
    await client.entities.create({ entity_id: "asset-1", entity_type: "asset" });
    await client.tasks.create({ task_id: "task-1", entity_id: "asset-1" });
    await client.tasks.create({ task_id: "task-2", entity_id: "asset-1", status: "acknowledged" });

    const checkIn = await client.entities.checkIn("asset-1");

    expect(checkIn.tasks.map((task) => task.task_id)).toEqual(["task-1"]);
    expect(checkIn.task_count).toBe(1);
    expect(checkIn.task_limit).toBe(10);
    expect(checkIn.has_more_tasks).toBe(false);
  });

  it("advances running sync client snapshots when status is polled", async () => {
    const core = createFakeAtlasCore();
    const writer = core.factory();
    const reader = core.factory({ sync: "all" });
    await reader.sync.start();

    await writer.entities.create({ entity_id: "asset-1", entity_type: "asset" });

    await expect(reader.entities.get("asset-1")).rejects.toMatchObject({ status: 404 });
    await reader.sync.status();
    await expect(reader.entities.get("asset-1")).resolves.toMatchObject({ entity_id: "asset-1" });
    await expect(reader.queries.full()).resolves.toMatchObject({ entities: [expect.objectContaining({ entity_id: "asset-1" })] });
  });

  it("enforces conflicts, tombstone reads, deletion logging, and re-create", async () => {
    const core = createFakeAtlasCore();
    const client = core.factory();
    await client.entities.create({ entity_id: "asset-1", entity_type: "asset" });

    await expect(client.entities.create({ entity_id: "asset-1", entity_type: "asset" })).rejects.toMatchObject({ status: 409 });
    await client.entities.delete("asset-1");
    await expect(client.entities.get("asset-1")).rejects.toMatchObject({ status: 404 });
    expect(core.state.deleted).toEqual(["entity:asset-1"]);
    await client.entities.create({ entity_id: "asset-1", entity_type: "asset" });

    await expect(client.entities.get("asset-1")).resolves.toMatchObject({ entity_id: "asset-1" });
  });
});
