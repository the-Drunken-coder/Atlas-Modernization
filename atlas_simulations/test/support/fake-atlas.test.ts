import { describe, expect, it, vi } from "vitest";
import { createFakeAtlasCore } from "./fake-atlas.js";

describe("fake Atlas core", () => {
  it("returns pending entity tasks from check-in", async () => {
    const core = createFakeAtlasCore();
    const client = core.factory();
    await client.entities.create({ entity_id: "asset-1", entity_type: "asset" });
    await client.tasks.create({ task_id: "task-1", entity_id: "asset-1" });
    await client.tasks.create({ task_id: "task-2", entity_id: "asset-1" });
    await client.tasks.acknowledge("task-2");

    const checkIn = await client.entities.checkIn("asset-1");

    expect(checkIn.tasks.map((task) => task.task_id)).toEqual(["task-1"]);
    expect(checkIn.task_count).toBe(1);
    expect(checkIn.task_limit).toBe(10);
    expect(checkIn.has_more_tasks).toBe(false);
  });

  it("generates command task IDs when Core owns task creation", async () => {
    const core = createFakeAtlasCore();
    const client = core.factory();

    const task = await client.tasks.create({
      entity_id: "asset-1",
      components: { command: { type: "goto" } }
    });

    expect(task.task_id).toMatch(/^command-/);
    await expect(client.tasks.get(task.task_id)).resolves.toMatchObject({
      task_id: task.task_id,
      entity_id: "asset-1",
      components: { command: { type: "goto" } }
    });
  });

  it("advances running sync client snapshots when status is polled", async () => {
    const core = createFakeAtlasCore();
    const writer = core.factory();
    const reader = core.factory({ sync: "all" });
    const watch = vi.fn();
    reader.watch({ filter: "type", resource_type: "entity" }, watch);
    await reader.sync.start();

    await writer.entities.create({ entity_id: "asset-1", entity_type: "asset" });

    await expect(reader.entities.get("asset-1")).rejects.toMatchObject({ status: 404 });
    await reader.sync.status();
    await expect(reader.entities.get("asset-1")).resolves.toMatchObject({ entity_id: "asset-1" });
    await expect(reader.queries.full()).resolves.toMatchObject({
      entities: [expect.objectContaining({ entity_id: "asset-1" })]
    });
    expect(watch).toHaveBeenCalledWith(
      expect.objectContaining({ entity_id: "asset-1" }),
      expect.objectContaining({ event: "create", id: "asset-1" })
    );
  });

  it("enforces conflicts, tombstone reads, deletion logging, and re-create", async () => {
    const core = createFakeAtlasCore();
    const client = core.factory();
    await client.entities.create({ entity_id: "asset-1", entity_type: "asset" });

    await expect(client.entities.create({ entity_id: "asset-1", entity_type: "asset" })).rejects.toMatchObject({
      status: 409
    });
    await client.entities.delete("asset-1");
    await expect(client.entities.get("asset-1")).rejects.toMatchObject({ status: 404 });
    expect(core.state.deleted).toEqual(["entity:asset-1"]);
    await client.entities.create({ entity_id: "asset-1", entity_type: "asset" });

    await expect(client.entities.get("asset-1")).resolves.toMatchObject({ entity_id: "asset-1" });
  });

  it("emits a re-created resource as a create event", async () => {
    const core = createFakeAtlasCore();
    const writer = core.factory();
    const reader = core.factory({ sync: "all" });
    const watch = vi.fn();
    reader.watch({ filter: "type", resource_type: "entity" }, watch);
    await reader.sync.start();

    await writer.entities.create({ entity_id: "asset-recreated", entity_type: "asset" });
    await reader.sync.status();
    await writer.entities.delete("asset-recreated");
    await reader.sync.status();
    watch.mockClear();
    await writer.entities.create({ entity_id: "asset-recreated", entity_type: "asset" });
    await reader.sync.status();

    expect(watch).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledWith(
      expect.objectContaining({ entity_id: "asset-recreated" }),
      expect.objectContaining({ event: "create", id: "asset-recreated" })
    );
  });
});
