import { describe, expect, it, vi } from "vitest";
import { createFakeAtlasCore } from "./fake-atlas.js";

describe("fake Atlas core", () => {
  it("keeps check-in telemetry-only and delivers pending Tasks through the runtime route", async () => {
    const core = createFakeAtlasCore();
    const client = core.factory();
    await client.entities.create({ entity_id: "asset-1", entity_type: "asset" });
    await client.runtime.begin("asset-1", { runtime_id: "runtime-1" });
    await client.runtime.ready("asset-1", { runtime_id: "runtime-1", manifest: [] });
    const first = await client.tasks.create(
      { asset_id: "asset-1", command: "fixture.queued", input: { value: "first" } },
      { idempotencyKey: "first" }
    );
    const second = await client.tasks.create(
      { asset_id: "asset-1", command: "fixture.queued", input: { value: "second" } },
      { idempotencyKey: "second" }
    );
    await client.tasks.acknowledge(second.task_id, { runtimeId: "runtime-1" });

    const checkIn = await client.entities.checkIn("asset-1");
    const delivery = await client.runtime.tasks("asset-1", { runtimeId: "runtime-1" });

    expect(checkIn).toEqual({ entity: expect.objectContaining({ entity_id: "asset-1" }) });
    expect(delivery.tasks.map((task) => task.task_id)).toEqual([first.task_id]);
  });

  it("generates command task IDs when Core owns task creation", async () => {
    const core = createFakeAtlasCore();
    const client = core.factory();

    const task = await client.tasks.create(
      { asset_id: "asset-1", command: "fixture.queued", input: { value: "test" } },
      { idempotencyKey: "generated" }
    );

    expect(task.task_id).toMatch(/^task-/);
    await expect(client.tasks.get(task.task_id)).resolves.toMatchObject({
      task_id: task.task_id,
      asset_id: "asset-1",
      command: "fixture.queued",
      input: { value: "test" }
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
