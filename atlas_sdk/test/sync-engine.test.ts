import { describe, expect, it, vi } from "vitest";
import { AtlasClient } from "../src";
import { parseSubscriptionKey } from "../src/subscriptions.js";
import { changedSinceToEvents, type ChangedSinceResponse } from "../src/types.js";
import { entity, FakeCore, metadata, object, task } from "./support/fake-core.js";

describe("AtlasClient sync", () => {
  it("configures sync presets without starting hydration or feed side effects", () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });

    expect(client.sync.status()).toMatchObject({
      running: false,
      healthy: false,
      degraded: false,
      lastVersion: 0,
      subscriptions: [{ filter: "all" }]
    });
    expect(core.requests).toEqual([]);
    expect(core.feedConnections).toBe(0);
  });

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

  it("emits recovered events for changed-since upserts", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-1"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "task" }, watch);

    const updated = core.upsertTask(task("task-polled", "asset-1"));
    await client.changedSince();

    await expect(client.tasks.get("task-polled")).resolves.toEqual(updated);
    expect(watch).toHaveBeenCalledWith(updated, expect.objectContaining({ event: "recovered", resource_type: "task", id: "task-polled" }));
  });

  it("emits changed-since recovery events in global version order", () => {
    const entityVersion5 = { ...entity("entity-v5"), metadata: metadata(5) };
    const taskVersion2 = { ...task("task-v2", null), metadata: metadata(2) };
    const objectVersion4 = { ...object("object-v4"), metadata: metadata(4) };
    const response: ChangedSinceResponse = {
      entities: [entityVersion5],
      tasks: [taskVersion2],
      objects: [objectVersion4],
      deleted_entities: [{ id: "entity-v1", type: "entity", version: 1 }],
      deleted_tasks: [{ id: "task-v3", type: "task", version: 3, entity_id: null }],
      deleted_objects: [],
      version: 5
    };

    expect(changedSinceToEvents(response).map((event) => event.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it("drains paginated changed-since responses before advancing the high-water mark", async () => {
    const core = new FakeCore();
    core.changedSinceLimitPerType = 1;
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "task" }, watch);

    const first = core.upsertTask(task("task-page-1", "asset-1"));
    const second = core.upsertTask(task("task-page-2", "asset-1"));
    await client.changedSince();

    expect(core.requests.some((request) => request.startsWith("/queries/changed-since?") && request.includes("task_cursor="))).toBe(true);
    expect(watch).toHaveBeenCalledWith(first, expect.objectContaining({ id: "task-page-1", version: first.metadata.version }));
    expect(watch).toHaveBeenCalledWith(second, expect.objectContaining({ id: "task-page-2", version: second.metadata.version }));
    expect(client.sync.status().lastVersion).toBe(core.version);
  });

  it("ignores in-flight changed-since results after stop", async () => {
    let resolveChangedSince!: (response: Response) => void;
    const changedSinceResponse = new Promise<Response>((resolve) => {
      resolveChangedSince = resolve;
    });
    const fetchImpl: typeof fetch = (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/queries/changed-since") {
        return changedSinceResponse;
      }
      return Promise.resolve(new Response(JSON.stringify({ success: false, message: "not found", error_code: "ENTITY_NOT_FOUND" }), { status: 404 }));
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });

    const recovery = client.changedSince();
    client.sync.stop();
    resolveChangedSince(
      new Response(
        JSON.stringify({
          entities: [{ ...entity("asset-after-stop"), metadata: metadata(1) }],
          tasks: [],
          objects: [],
          deleted_entities: [],
          deleted_tasks: [],
          deleted_objects: [],
          version: 1
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );
    await recovery;

    expect(client.sync.status().lastVersion).toBe(0);
  });

  it("does not advance the global change cursor from point reads", async () => {
    const core = new FakeCore();
    const baseline = core.upsertEntity(entity("asset-baseline-read"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();

    const unseenTask = core.upsertTask(task("task-unseen-before-read", "asset-baseline-read"));
    const newerEntity = core.upsertEntity({ ...entity("asset-point-read"), alias: "fresh" });
    core.requests = [];

    await expect(client.entities.get(newerEntity.entity_id, { fresh: true })).resolves.toEqual(newerEntity);

    expect(client.sync.status().lastVersion).toBe(baseline.metadata.version);
    await client.changedSince();
    expect(core.requests.find((request) => request.startsWith("/queries/changed-since?"))).toContain(`since_version=${baseline.metadata.version}`);
    await expect(client.tasks.get(unseenTask.task_id)).resolves.toEqual(unseenTask);
    expect(client.sync.status().lastVersion).toBe(core.version);
  });

  it("does not advance the global change cursor from optimistic local writes", async () => {
    const core = new FakeCore();
    const baseline = core.upsertEntity(entity("asset-baseline-write"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();

    const unseenTask = core.upsertTask(task("task-unseen-before-write", "asset-baseline-write"));
    core.requests = [];
    const written = await client.entities.create({ entity_id: "asset-local-write", entity_type: "asset" });

    expect(client.sync.status().lastVersion).toBe(baseline.metadata.version);
    await expect(client.entities.get(written.entity_id)).resolves.toEqual(written);
    await client.changedSince();
    expect(core.requests.find((request) => request.startsWith("/queries/changed-since?"))).toContain(`since_version=${baseline.metadata.version}`);
    await expect(client.tasks.get(unseenTask.task_id)).resolves.toEqual(unseenTask);
    expect(client.sync.status().lastVersion).toBe(core.version);
  });

  it("lets changed-since recovery replace a delete tombstone with a later recreated resource", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-recreated"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const watch = vi.fn();
    client.entities.watch("asset-recreated", watch);

    await client.entities.delete(original.entity_id);
    const recreated = core.upsertEntity({ ...entity("asset-recreated"), alias: "back" });
    await client.changedSince();

    expect(watch).toHaveBeenCalledWith(recreated, expect.objectContaining({ event: "recovered", id: "asset-recreated", version: recreated.metadata.version }));
    await expect(client.entities.get("asset-recreated")).resolves.toEqual(recreated);
  });

  it("does not let stale changed-since recovery resurrect an uncached local delete", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const live = core.upsertEntity(entity("asset-delete-race"));
    const watch = vi.fn();
    client.entities.watch(live.entity_id, watch);

    await client.entities.delete(live.entity_id);
    const deleteEvent = core.deletions.at(-1);
    if (!deleteEvent) throw new Error("fake core did not record delete event");
    core.events = core.events.filter((event) => event.version < deleteEvent.version);
    core.version = live.metadata.version;

    await client.changedSince();

    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch.mock.calls[0][1]).toEqual({ event: "local_delete", resource_type: "entity", id: live.entity_id });
    await expect(client.entities.get(live.entity_id)).rejects.toMatchObject({
      status: 404,
      errorCode: "ENTITY_NOT_FOUND"
    });

    core.events.push(deleteEvent);
    core.version = deleteEvent.version;
    await client.changedSince();

    expect(watch).toHaveBeenCalledTimes(1);
    await expect(client.entities.get(live.entity_id)).rejects.toMatchObject({
      status: 404,
      errorCode: "ENTITY_NOT_FOUND"
    });
  });

  it("drains paginated full-dataset hydration responses", async () => {
    const core = new FakeCore();
    core.fullLimitPerType = 1;
    core.upsertEntity(entity("asset-page-1"));
    core.upsertEntity(entity("asset-page-2"));
    core.upsertTask(task("task-hydrate-1", "asset-page-1"));
    core.upsertTask(task("task-hydrate-2", "asset-page-2"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });

    await client.sync.start();

    expect(core.requests.some((request) => request.startsWith("/queries/full?") && request.includes("entity_cursor="))).toBe(true);
    expect(core.requests.some((request) => request.startsWith("/queries/full?") && request.includes("task_cursor="))).toBe(true);
  });

  it("does not start duplicate polling intervals when sync.start is called twice sequentially", async () => {
    vi.useFakeTimers();
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 100 });

    try {
      await client.sync.start();
      await client.sync.start();
      core.requests = [];

      await vi.advanceTimersByTimeAsync(250);

      expect(core.requests.filter((request) => request.startsWith("/queries/changed-since")).length).toBe(2);
    } finally {
      client.sync.stop();
      vi.useRealTimers();
    }
  });

  it("shares one startup path across concurrent sync.start calls", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });

    try {
      const firstStart = client.sync.start();
      const secondStart = client.sync.start();

      await Promise.all([firstStart, secondStart]);

      expect(core.feedConnections).toBe(1);
      expect(core.requests.filter((request) => request.startsWith("/queries/full")).length).toBe(1);
    } finally {
      client.sync.stop();
    }
  });

  it("does not let sync.stop be undone by an in-flight sync.start", async () => {
    const core = new FakeCore();
    let releaseHydration: (() => void) | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname === "/queries/full") {
        await new Promise<void>((resolve) => {
          releaseHydration = resolve;
        });
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: fetchImpl,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });

    const start = client.sync.start();
    await vi.waitFor(() => expect(releaseHydration).toBeTypeOf("function"));
    client.sync.stop();
    releaseHydration?.();
    await start;

    expect(client.sync.status()).toMatchObject({ running: false, healthy: false, degraded: false });
    expect(core.sockets.size).toBe(0);
  });

  it("does not serve cached point reads while startup recovery is still in flight", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-startup-cache"));
    let releaseRecovery: (() => void) | undefined;
    let delayedRecovery = false;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname === "/queries/changed-since" && !delayedRecovery) {
        delayedRecovery = true;
        await new Promise<void>((resolve) => {
          releaseRecovery = resolve;
        });
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: fetchImpl,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });

    const start = client.sync.start();
    await vi.waitFor(() => expect(releaseRecovery).toBeTypeOf("function"));
    const updated = core.upsertEntity({ ...entity("asset-startup-cache"), alias: "fresh" });

    await expect(client.entities.get("asset-startup-cache")).resolves.toEqual(updated);

    releaseRecovery?.();
    await start;
  });

  it("evicts local cache entries after successful deletes", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-delete"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();

    await expect(client.entities.get("asset-delete")).resolves.toMatchObject({ entity_id: "asset-delete" });
    await client.entities.delete("asset-delete");

    await expect(client.entities.get("asset-delete")).rejects.toMatchObject({
      status: 404,
      errorCode: "ENTITY_NOT_FOUND"
    });
  });

  it("emits a local delete notification without fabricating a feed version", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-delete-uncached"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.connectFeed();
    const watch = vi.fn();
    client.watch({ filter: "id", resource_type: "entity", id: "asset-delete-uncached" }, watch);

    await client.entities.delete("asset-delete-uncached");
    const deleteEvent = core.deletions.at(-1);
    if (!deleteEvent) throw new Error("fake core did not record delete event");
    core.emit(deleteEvent, { record: false });

    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));
    expect(watch.mock.calls[0][0]).toBeUndefined();
    expect(watch.mock.calls[0][1]).toEqual({ event: "local_delete", resource_type: "entity", id: "asset-delete-uncached" });
    expect(watch.mock.calls[0][1]).not.toHaveProperty("version");
  });

  it("keeps local delete tombstones ahead of stale feed updates", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-delete-stale"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
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
    expect(watch.mock.calls[0][1]).toMatchObject({ event: "local_delete", resource_type: "entity", id: "asset-delete-stale" });
    await expect(client.entities.get("asset-delete-stale")).rejects.toMatchObject({
      status: 404,
      errorCode: "ENTITY_NOT_FOUND"
    });
  });

  it("re-arms reconnect when a replacement socket closes during recovery", async () => {
    const core = new FakeCore();
    let delayNextChangedSince = false;
    let releaseRecovery: (() => void) | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname === "/queries/changed-since" && delayNextChangedSince) {
        delayNextChangedSince = false;
        await new Promise<void>((resolve) => {
          releaseRecovery = resolve;
        });
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: fetchImpl,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });

    try {
      await client.sync.start();
      const initialSocket = Array.from(core.sockets)[0];
      delayNextChangedSince = true;
      const recovery = client.connectAndRecoverFeed();

      await vi.waitFor(() => {
        expect(releaseRecovery).toBeTypeOf("function");
      });
      const recoverySocket = Array.from(core.sockets).find((socket) => socket !== initialSocket);
      expect(recoverySocket).toBeDefined();

      recoverySocket?.close();
      releaseRecovery?.();
      await recovery;

      expect(client.sync.status()).toMatchObject({ healthy: false, degraded: true });
      await vi.waitFor(
        () => {
          expect(client.sync.status().healthy).toBe(true);
        },
        { timeout: 2500 }
      );
      expect(core.sockets.size).toBe(1);
      expect(core.sockets.has(recoverySocket!)).toBe(false);
    } finally {
      client.sync.stop();
    }
  });

  it("fails loudly when the fake core records duplicate event versions", () => {
    const core = new FakeCore();
    const value = core.upsertEntity(entity("asset-duplicate-version"));

    expect(() =>
      core.emit({ event: "update", resource_type: "entity", id: value.entity_id, version: value.metadata.version, resource: value })
    ).toThrow("duplicate fake core event version");
  });

  it("keeps successful writes successful when watch callbacks throw", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    client.entities.watch("asset-throwing-write-watch", () => {
      throw new Error("watch failed");
    });

    try {
      await expect(client.entities.create({ entity_id: "asset-throwing-write-watch", entity_type: "asset" })).resolves.toMatchObject({ entity_id: "asset-throwing-write-watch" });
      expect(client.sync.status().degraded).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("honors selective tasks-for-entity routing across reassignment", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "selective",
      pollIntervalMs: 0
    });
    await client.sync.start();
    await client.subscribe({ filter: "tasks_for_entity", entity_id: "asset-old" });
    const watch = vi.fn();
    client.watch({ filter: "tasks_for_entity", entity_id: "asset-old" }, watch);
    await client.connectFeed();

    const first = core.upsertTask(task("task-reassign", "asset-old"));
    core.emit({ event: "create", resource_type: "task", id: first.task_id, version: first.metadata.version, resource: first }, { record: false });
    const reassigned = core.upsertTask({ ...first, entity_id: "asset-new" });
    core.emit(
      { event: "update", resource_type: "task", id: reassigned.task_id, version: reassigned.metadata.version, resource: reassigned },
      { beforeTaskEntityId: "asset-old", record: false }
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

  it("exposes typed watch helpers for all resource surfaces", () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    expect(typeof client.entities.watch("asset-watch", vi.fn())).toBe("function");
    expect(typeof client.tasks.watch("task-watch", vi.fn())).toBe("function");
    expect(typeof client.objects.watch("object-watch", vi.fn())).toBe("function");
  });

  it("stops delivering events after unwatch without affecting other watchers", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const beforeWatch = vi.fn();
    const removedWatch = vi.fn();
    const afterWatch = vi.fn();

    client.entities.watch("asset-watch-before", beforeWatch);
    const unwatch = client.entities.watch("asset-watch-prune", removedWatch);

    unwatch();
    client.entities.watch("asset-watch-after", afterWatch);

    const beforeEntity = core.upsertEntity(entity("asset-watch-before"));
    core.upsertEntity(entity("asset-watch-prune"));
    const afterEntity = core.upsertEntity(entity("asset-watch-after"));

    await client.changedSince();

    expect(beforeWatch).toHaveBeenCalledWith(beforeEntity, expect.objectContaining({ event: "recovered", id: "asset-watch-before" }));
    expect(removedWatch).not.toHaveBeenCalled();
    expect(afterWatch).toHaveBeenCalledWith(afterEntity, expect.objectContaining({ event: "recovered", id: "asset-watch-after" }));
  });

  it("rejects malformed stored subscription keys", () => {
    expect(() => parseSubscriptionKey("not-json")).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["unknown", "entity-1"]))).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["type", "not-a-type"]))).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["id", "task"]))).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["tasks_for_entity", ""]))).toThrow("invalid subscription key");
  });

});
