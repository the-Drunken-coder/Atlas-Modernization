import { describe, expect, it, vi } from "vitest";
import { AtlasClient, ConflictError, ProtocolMismatchError, type FeedEvent } from "../src";
import { RESOURCE_TYPE_VALUES, isResourceType, parseFilter, runCLI, type CLIIO } from "../src/cli.js";
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
  it("hydrates, polls changed-since, updates cache, and serves covered reads from cache", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-1"));
    core.upsertTask(task("task-1", "asset-1"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const updated = core.upsertTask({ ...task("task-1", "asset-1"), status: "acknowledged" });
    await client.changedSince();
    await expect(client.tasks.get("task-1")).resolves.toEqual(updated);
    expect(client.sync.status().healthy).toBe(true);
  });

  it("does not emit synthetic update events for changed-since upserts", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-1"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "task" }, watch);

    const updated = core.upsertTask(task("task-polled", "asset-1"));
    await client.changedSince();

    await expect(client.tasks.get("task-polled")).resolves.toEqual(updated);
    expect(watch).not.toHaveBeenCalled();
  });

  it("evicts local cache entries after successful deletes", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-delete"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();

    await expect(client.entities.get("asset-delete")).resolves.toMatchObject({ entity_id: "asset-delete" });
    await client.entities.delete("asset-delete");

    await expect(client.entities.get("asset-delete")).rejects.toThrow("Atlas request failed: 404");
  });

  it("keeps local delete tombstones ahead of stale feed updates", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-delete-stale"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal() as any,
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    await client.connectFeed();
    const watch = vi.fn();
    client.watch({ filter: "id", resource_type: "entity", id: "asset-delete-stale" }, watch);

    await client.entities.delete("asset-delete-stale");
    core.emit(
      {
        event: "update",
        resource_type: "entity",
        id: "asset-delete-stale",
        version: Number.MAX_SAFE_INTEGER - 1,
        // The stale payload uses a huge safe version to prove newer-looking updates cannot override deletes.
        resource: { ...original, alias: "stale", metadata: { ...original.metadata, version: Number.MAX_SAFE_INTEGER - 1 } }
      },
      { record: false }
    );

    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));
    expect(watch.mock.calls[0][0]).toBeUndefined();
    expect(watch.mock.calls[0][1]).toMatchObject({ event: "delete", resource_type: "entity", id: "asset-delete-stale" });
    await expect(client.entities.get("asset-delete-stale")).rejects.toThrow("Atlas request failed: 404");
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

  it("rejects feed connections that close before the protocol hello", async () => {
    const core = new FakeCore();
    core.rejectFeedAuth = true;
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      apiKey: "wrong",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal() as any,
      sync: "all",
      pollIntervalMs: 0,
      feedHandshakeTimeoutMs: 50
    });

    await expect(client.connectFeed()).rejects.toThrow("before protocol hello");
    expect(core.sockets.size).toBe(0);
  });

  it("can retry feed startup after a failed tentative socket", async () => {
    const core = new FakeCore();
    core.rejectFeedAuth = true;
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      apiKey: "wrong",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal() as any,
      sync: "all",
      pollIntervalMs: 0,
      feedHandshakeTimeoutMs: 50
    });

    await expect(client.connectFeed()).rejects.toThrow("before protocol hello");
    core.rejectFeedAuth = false;

    await expect(client.connectFeed()).resolves.toBeUndefined();
    expect(core.sockets.size).toBe(1);
  });

  it("replaces an existing feed socket on repeated connect calls", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal() as any,
      sync: "all",
      pollIntervalMs: 0
    });

    await client.connectFeed();
    const firstSocket = Array.from(core.sockets)[0];
    await client.connectFeed();
    const secondSocket = Array.from(core.sockets)[0];

    expect(core.sockets.size).toBe(1);
    expect(secondSocket).not.toBe(firstSocket);
  });

  it("lets the latest concurrent feed connection own the socket", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal() as any,
      sync: "all",
      pollIntervalMs: 0
    });

    const firstConnect = client.connectFeed();
    const secondConnect = client.connectFeed();

    await expect(firstConnect).rejects.toThrow("feed connection was replaced");
    await expect(secondConnect).resolves.toBeUndefined();
    expect(core.sockets.size).toBe(1);
  });

  it("binds fake websockets to the FakeCore that created them", async () => {
    const firstCore = new FakeCore();
    const firstWebSocket = firstCore.attachWebSocketGlobal();
    const secondCore = new FakeCore();
    // Attach a second core after capturing the first constructor to prove the first stays bound.
    secondCore.attachWebSocketGlobal();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: firstCore.fetch,
      WebSocket: firstWebSocket as any,
      sync: "all",
      pollIntervalMs: 0
    });

    await client.connectFeed();

    expect(firstCore.sockets.size).toBe(1);
    expect(secondCore.sockets.size).toBe(0);
  });

  it("marks the sync engine degraded when feed gap recovery fails", async () => {
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

    core.upsertTask(task("task-gap-fail", "asset-1"));
    const second = core.upsertTask({ ...task("task-gap-fail", "asset-1"), status: "acknowledged" });
    core.failChangedSince = true;
    core.emit({ event: "update", resource_type: "task", id: second.task_id, version: second.metadata.version, resource: second });

    await vi.waitFor(() => {
      expect(client.sync.status().degraded).toBe(true);
      expect(client.sync.status().healthy).toBe(false);
    });
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
      if (i % 3 === 0) {
        const entityID = `asset-sim-${i % 5}`;
        const value = core.upsertEntity({ ...entity(entityID), alias: `asset ${i}` });
        const event: FeedEvent = { event: "update", resource_type: "entity", id: entityID, version: value.metadata.version, resource: value };
        core.emit(event, i === 6 ? { dropForSockets: true } : undefined);
      }
      const id = `task-sim-${i % 4}`;
      const value = core.upsertTask({ ...task(id, `asset-${i % 3}`), status: i % 2 === 0 ? "pending" : "acknowledged" });
      const event: FeedEvent = { event: "update", resource_type: "task", id, version: value.metadata.version, resource: value };
      core.emit(event, i === 7 ? { dropForSockets: true } : undefined);
      if (i % 4 === 0) {
        const objectID = `object-sim-${i % 3}`;
        const value = core.upsertObject({ ...object(objectID), type: i % 8 === 0 ? "image" : "log" });
        const objectEvent: FeedEvent = { event: "update", resource_type: "object", id: objectID, version: value.metadata.version, resource: value };
        core.emit(objectEvent, i === 12 ? { dropForSockets: true } : undefined);
      }
      // Mid-simulation task delete is dropped from sockets to force gap reconciliation.
      if (i === 10) {
        const event = core.deleteTask("task-sim-2");
        if (event) core.emit(event, { dropForSockets: true });
      }
      // Entity delete follows later so the ledger sees a live tombstone after recovery.
      if (i === 14) {
        const event = core.deleteEntity("asset-sim-2");
        if (event) core.emit(event);
      }
      // Object delete lands near the tail to cover all resource tombstone types.
      if (i === 18) {
        const event = core.deleteObject("object-sim-1");
        if (event) core.emit(event);
      }
      if (i % 6 === 5) {
        await assertClientMatchesLedger(client, core);
      }
    }
    await assertClientMatchesLedger(client, core);
  });

  it("honors selective tasks-for-entity routing across reassignment", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal() as any,
      sync: "selective",
      pollIntervalMs: 0
    });
    await client.sync.start();
    await client.subscribe({ filter: "tasks_for_entity", entity_id: "asset-old" });
    const watch = vi.fn();
    client.watch({ filter: "tasks_for_entity", entity_id: "asset-old" }, watch);
    await client.connectFeed();

    const first = core.upsertTask(task("task-reassign", "asset-old"));
    core.emit({ event: "create", resource_type: "task", id: first.task_id, version: first.metadata.version, resource: first });
    const reassigned = core.upsertTask({ ...first, entity_id: "asset-new" });
    core.emit(
      { event: "update", resource_type: "task", id: reassigned.task_id, version: reassigned.metadata.version, resource: reassigned },
      { beforeTaskEntityId: "asset-old" }
    );

    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledWith(reassigned, expect.objectContaining({ id: "task-reassign", version: reassigned.metadata.version }));
    });
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

  it("retries object content download when metadata changes mid-flight", async () => {
    const core = new FakeCore();
    core.upsertObject(object("object-1"));
    let raced = false;
    core.onObjectDownload = (id) => {
      if (!raced) {
        raced = true;
        core.upsertObject({ ...object(id), type: "log" });
      }
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0, objectContentCacheEntries: 4 });
    await client.sync.start();

    await expect(client.objects.content("object-1")).resolves.toBeInstanceOf(ArrayBuffer);
    expect(core.objectDownloadCount).toBe(2);

    await expect(client.objects.content("object-1")).resolves.toBeInstanceOf(ArrayBuffer);
    expect(core.objectDownloadCount).toBe(2);
  });
});

describe("Atlas CLI", () => {
  it("prints help without opening a network connection", async () => {
    const io = captureIO();
    await expect(runCLI(["--help"], io.io)).resolves.toBe(0);
    expect(io.stdout()).toContain("usage: atlas");
    expect(io.stderr()).toBe("");
  });

  it("rejects malformed commands and arguments before handshake", async () => {
    const missingID = captureIO();
    await expect(runCLI(["entities", "get"], missingID.io)).resolves.toBe(2);
    expect(missingID.stderr()).toContain("usage: invalid command");

    const badJSON = captureIO();
    await expect(runCLI(["tasks", "create", "{bad"], badJSON.io)).resolves.toBe(2);
    expect(badJSON.stderr()).toContain("invalid task JSON");

    const badFilter = captureIO();
    await expect(runCLI(["watch", "--subscribe", "id:not-a-type:x"], badFilter.io)).resolves.toBe(2);
    expect(badFilter.stderr()).toContain("invalid subscription filter");
  });

  it("parses valid subscription filters", () => {
    expect(parseFilter("all")).toEqual({ filter: "all" });
    for (const resourceType of RESOURCE_TYPE_VALUES) {
      expect(isResourceType(resourceType)).toBe(true);
      expect(parseFilter(`type:${resourceType}`)).toEqual({ filter: "type", resource_type: resourceType });
      expect(parseFilter(`id:${resourceType}:${resourceType}-1`)).toEqual({
        filter: "id",
        resource_type: resourceType,
        id: `${resourceType}-1`
      });
    }
    expect(parseFilter("id:task:task:with:colons")).toEqual({ filter: "id", resource_type: "task", id: "task:with:colons" });
    expect(parseFilter("tasks_for_entity:asset-1")).toEqual({ filter: "tasks_for_entity", entity_id: "asset-1" });
    expect(parseFilter("tasks_for_entity:asset:with:colons")).toEqual({ filter: "tasks_for_entity", entity_id: "asset:with:colons" });
  });

  it("rejects invalid subscription filters", () => {
    expect(isResourceType("invalid")).toBe(false);
    expect(() => parseFilter("unknown_filter")).toThrow("invalid subscription filter");
    expect(() => parseFilter("type:invalid")).toThrow("invalid subscription filter");
    expect(() => parseFilter("id:task")).toThrow("invalid subscription filter");
    expect(() => parseFilter("tasks_for_entity")).toThrow("invalid subscription filter");
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
      await expect(client.objects.get(objectValue.object_id)).resolves.toEqual(objectValue);
    }
    for (const deletion of core.deletions) {
      if (deletion.resource_type === "entity" && !core.entities.has(deletion.id)) {
        await expect(client.entities.get(deletion.id)).rejects.toThrow(/404/);
      }
      if (deletion.resource_type === "task" && !core.tasks.has(deletion.id)) {
        await expect(client.tasks.get(deletion.id)).rejects.toThrow(/404/);
      }
      if (deletion.resource_type === "object" && !core.objects.has(deletion.id)) {
        await expect(client.objects.get(deletion.id)).rejects.toThrow(/404/);
      }
    }
  });
}

function captureIO(): { io: CLIIO; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (data: string) => (stdout += data) },
      stderr: { write: (data: string) => (stderr += data) },
      env: {}
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}
