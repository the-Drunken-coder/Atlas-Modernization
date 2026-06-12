import { describe, expect, it, vi } from "vitest";
import { AtlasClient, ConflictError, ProtocolMismatchError, type FeedEvent } from "../src";
import { entity, FakeCore, object, task } from "./fake-core";

describe("AtlasClient HTTP", () => {
  it("fails loudly on protocol revision mismatch", async () => {
    const core = new FakeCore();
    core.revision = "sha256:mismatch";
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });
    await expect(client.handshake()).rejects.toBeInstanceOf(ProtocolMismatchError);
  });

  it("applies writes to cache and exposes precondition conflicts as ConflictError", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const created = await client.entities.create(entity("asset-1"));
    await expect(client.entities.get("asset-1")).resolves.toEqual(created);
    await expect(client.entities.update("asset-1", { alias: "new" }, { ifMatchVersion: 0 })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("AtlasClient sync", () => {
  it("hydrates, polls changed-since, updates watches, and serves covered reads from cache", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-1"));
    core.upsertTask(task("task-1", "asset-1"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const watch = vi.fn();
    client.tasks.watch("task-1", watch);
    const updated = core.upsertTask({ ...task("task-1", "asset-1"), status: "acknowledged" });
    await client.changedSince();
    await expect(client.tasks.get("task-1")).resolves.toEqual(updated);
    expect(watch).toHaveBeenCalled();
    expect(client.sync.status().healthy).toBe(true);
  });

  it("uses websocket feed events and converges through changed-since after a forced gap", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal() as any,
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    await client.connectFeed();

    const first = core.upsertTask(task("task-gap", "asset-1"));
    core.emit({ event: "update", resource_type: "task", id: first.task_id, version: first.metadata.version, resource: first }, { dropForSockets: true });
    const second = core.upsertTask({ ...first, status: "acknowledged" });
    const event: FeedEvent = { event: "update", resource_type: "task", id: second.task_id, version: second.metadata.version, resource: second };
    core.emit(event);

    await vi.waitFor(async () => {
      await expect(client.tasks.get("task-gap")).resolves.toEqual(second);
    });
    expect(client.sync.status().degraded).toBe(false);
  });

  it("matches the simulation ledger at checkpoints and run end", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal() as any,
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    await client.connectFeed();

    for (let i = 0; i < 24; i++) {
      const id = `task-sim-${i % 4}`;
      const value = core.upsertTask({ ...task(id, `asset-${i % 3}`), status: i % 2 === 0 ? "pending" : "acknowledged" });
      const event: FeedEvent = { event: "update", resource_type: "task", id, version: value.metadata.version, resource: value };
      core.emit(event, i === 7 ? { dropForSockets: true } : undefined);
      if (i % 6 === 5) {
        await assertClientMatchesLedger(client, core);
      }
    }
    await assertClientMatchesLedger(client, core);
  });

  it("caches object content by object version with an LRU cap", async () => {
    const core = new FakeCore();
    core.upsertObject(object("object-1"));
    const fetchSpy = vi.fn(core.fetch);
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchSpy, sync: "all", pollIntervalMs: 0, objectContentCacheEntries: 1 });
    await client.sync.start();
    await client.objects.content("object-1");
    await client.objects.content("object-1");
    const downloads = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/download"));
    expect(downloads).toHaveLength(1);
  });
});

async function assertClientMatchesLedger(client: AtlasClient, core: FakeCore): Promise<void> {
  await vi.waitFor(async () => {
    for (const taskValue of core.tasks.values()) {
      await expect(client.tasks.get(taskValue.task_id)).resolves.toEqual(taskValue);
    }
  });
}
