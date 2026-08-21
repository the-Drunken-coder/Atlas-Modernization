import { describe, expect, it, vi } from "vitest";
import { AtlasClient, type ResourceType } from "../src";
import { ResourceCache } from "../src/cache.js";
import { parseSubscriptionKey } from "../src/subscriptions.js";
import { type ResourceValue } from "../src/types.js";
import { entity, FakeCore, metadata, object, task } from "./support/fake-core.js";

describe("AtlasClient sync: polling, reconnect timers, and cleanup", () => {
  it("rejects polling intervals outside the supported timer range while allowing zero", () => {
    const core = new FakeCore();
    for (const pollIntervalMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, pollIntervalMs })).toThrow(
        "Atlas polling interval"
      );
    }
    expect(() => new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, pollIntervalMs: 0 })).not.toThrow();
    expect(
      () => new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, pollIntervalMs: 2_147_483_647 })
    ).not.toThrow();
  });

  it("does not start duplicate polling intervals when sync.start is called twice sequentially", async () => {
    vi.useFakeTimers();
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      sync: "all",
      pollIntervalMs: 100
    });

    try {
      await client.sync.start();
      await client.sync.start();
      core.requests = [];

      await vi.advanceTimersByTimeAsync(150);

      const pollRequests = core.requests.filter((request) => request.startsWith("/queries/changed-since")).length;
      expect(pollRequests).toBe(1);
    } finally {
      client.sync.stop();
      vi.useRealTimers();
    }
  });

  it("coalesces polling while changed-since recovery is in flight", async () => {
    vi.useFakeTimers();
    const core = new FakeCore();
    let holdRecovery = false;
    let pollRequests = 0;
    let releaseRecovery!: (response: Response) => void;
    const pendingRecovery = new Promise<Response>((resolve) => {
      releaseRecovery = resolve;
    });
    const fetchImpl: typeof fetch = (url, init) => {
      if (new URL(String(url)).pathname === "/queries/changed-since") {
        pollRequests++;
        if (holdRecovery) {
          holdRecovery = false;
          return pendingRecovery;
        }
      }
      return core.fetch(url, init);
    };
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: fetchImpl,
      sync: "all",
      pollIntervalMs: 100
    });

    try {
      await client.sync.start();
      holdRecovery = true;
      pollRequests = 0;
      core.requests = [];

      await vi.advanceTimersByTimeAsync(250);

      expect(pollRequests).toBe(1);
      releaseRecovery(
        Response.json({
          events: [],
          has_more: false,
          version: core.version
        })
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);

      expect(pollRequests).toBe(2);
    } finally {
      client.sync.stop();
      vi.useRealTimers();
    }
  });

  it("ignores a stale polling failure after same-generation feed recovery", async () => {
    vi.useFakeTimers();
    const core = new FakeCore();
    let holdPoll = false;
    let rejectPoll!: (reason: unknown) => void;
    let changedSinceRequests = 0;
    const pendingPoll = new Promise<Response>((_resolve, reject) => {
      rejectPoll = reject;
    });
    const fetchImpl: typeof fetch = (url, init) => {
      if (new URL(String(url)).pathname === "/queries/changed-since") {
        changedSinceRequests++;
        if (holdPoll) {
          holdPoll = false;
          return pendingPoll;
        }
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: fetchImpl,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 10_000
    });

    try {
      const start = client.sync.start();
      await vi.advanceTimersByTimeAsync(0);
      await start;
      const startupChangedSinceRequests = changedSinceRequests;
      expect(startupChangedSinceRequests).toBeGreaterThan(0);
      expect(core.feedConnections).toBe(1);

      holdPoll = true;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(changedSinceRequests).toBe(startupChangedSinceRequests + 1);

      const socket = [...core.sockets][0];
      if (!socket) throw new Error("expected a connected fake websocket");
      socket.close();
      expect(client.sync.status()).toMatchObject({
        running: true,
        healthy: false,
        degraded: true,
        error: "Atlas Core feed connection closed"
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(changedSinceRequests).toBe(startupChangedSinceRequests + 2);
        expect(core.feedConnections).toBe(2);
        expect(client.sync.status()).toMatchObject({ running: true, healthy: true, degraded: false });
        expect(client.sync.status()).not.toHaveProperty("error");
      });

      rejectPoll(new Error("obsolete poll failed"));
      await vi.advanceTimersByTimeAsync(0);

      expect(client.sync.status()).toMatchObject({ running: true, healthy: true, degraded: false });
      expect(client.sync.status()).not.toHaveProperty("error");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(core.feedConnections).toBe(2);
    } finally {
      client.sync.stop();
      vi.useRealTimers();
    }
  });

  it("ignores an automatic reconnect failure superseded by a same-generation feed connection", async () => {
    vi.useFakeTimers();
    const core = new FakeCore();
    let rejectAutomaticConnect!: (reason: unknown) => void;
    const automaticConnect = new Promise<void>((_resolve, reject) => {
      rejectAutomaticConnect = reject;
    });
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 60_000
    });
    const engine = (client as unknown as { engine: { feed: { connect: () => Promise<void> } } }).engine;

    try {
      const start = client.sync.start();
      await vi.advanceTimersByTimeAsync(0);
      await start;
      expect(core.feedConnections).toBe(1);

      const connect = vi
        .spyOn(engine.feed, "connect")
        .mockReturnValueOnce(automaticConnect)
        .mockResolvedValueOnce(undefined);
      const socket = [...core.sockets][0];
      if (!socket) throw new Error("expected a connected fake websocket");
      socket.close();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(connect).toHaveBeenCalledOnce();

      await client.connectFeed();
      expect(connect).toHaveBeenCalledTimes(2);
      await client.changedSince();
      expect(client.sync.status()).toMatchObject({
        running: true,
        healthy: true,
        degraded: false,
        error: "Atlas Core feed connection closed"
      });

      rejectAutomaticConnect(new Error("superseded automatic reconnect failed"));
      await vi.advanceTimersByTimeAsync(0);

      expect(client.sync.status()).toMatchObject({
        running: true,
        healthy: true,
        degraded: false,
        error: "Atlas Core feed connection closed"
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      client.sync.stop();
      vi.useRealTimers();
    }
  });

  it("buffers live events until automatic reconnect recovery completes", async () => {
    const core = new FakeCore();
    let holdAutomaticRecovery = false;
    let automaticRecoveryStarted = false;
    let resolveAutomaticRecovery!: (response: Response) => void;
    const automaticRecovery = new Promise<Response>((resolve) => {
      resolveAutomaticRecovery = resolve;
    });
    const fetchImpl: typeof fetch = (url, init) => {
      if (holdAutomaticRecovery && new URL(String(url)).pathname === "/queries/changed-since") {
        holdAutomaticRecovery = false;
        automaticRecoveryStarted = true;
        return automaticRecovery;
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: fetchImpl,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 60_000
    });

    try {
      await client.sync.start();
      vi.useFakeTimers();

      holdAutomaticRecovery = true;
      const initialSocket = [...core.sockets][0];
      if (!initialSocket) throw new Error("expected a connected fake websocket");
      initialSocket.close();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(automaticRecoveryStarted).toBe(true);
        expect(core.feedConnections).toBe(2);
      });

      const update = core.upsertEntity(entity("asset-during-automatic-recovery"));
      const event = {
        event: "update" as const,
        resource_type: "entity" as const,
        id: update.entity_id,
        version: update.metadata.version,
        resource: update
      };
      core.emit(event, { record: false });
      expect(client.sync.snapshot().entities).not.toHaveProperty(update.entity_id);

      resolveAutomaticRecovery(
        Response.json({
          events: [],
          has_more: false,
          version: update.metadata.version - 1
        })
      );
      await vi.waitFor(() => {
        expect(client.sync.snapshot().entities).toHaveProperty(update.entity_id);
        expect(client.sync.status().lastVersion).toBe(update.metadata.version);
      });
      expect(client.sync.status()).toMatchObject({
        running: true,
        healthy: true,
        degraded: false
      });
      expect(client.sync.status()).not.toHaveProperty("error");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(core.feedConnections).toBe(2);
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
    const deleteEvent = core.deleteEvents.at(-1);
    if (!deleteEvent) throw new Error("fake core did not record delete event");
    core.emit(deleteEvent, { record: false });

    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));
    expect(watch.mock.calls[0][0]).toBeUndefined();
    expect(watch.mock.calls[0][1]).toEqual({
      event: "local_delete",
      resource_type: "entity",
      id: "asset-delete-uncached"
    });
    expect(watch.mock.calls[0][1]).not.toHaveProperty("version");
  });

  it("keeps local delete markers ahead of stale feed updates", async () => {
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
        resource: {
          ...original,
          alias: "stale",
          metadata: { ...original.metadata, version: Number.MAX_SAFE_INTEGER - 1 }
        }
      },
      { record: false }
    );

    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));
    expect(watch.mock.calls[0][0]).toBeUndefined();
    expect(watch.mock.calls[0][1]).toMatchObject({
      event: "local_delete",
      resource_type: "entity",
      id: "asset-delete-stale"
    });
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
      core.emit({
        event: "update",
        resource_type: "entity",
        id: value.entity_id,
        version: value.metadata.version,
        resource: value
      })
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
    const secret = "watch-canary-secret";
    client.entities.watch("asset-throwing-write-watch", () => {
      throw new Error(`watch failed https://user:${secret}@core.test?api_key=${secret} Bearer ${secret} \u001b[31m`);
    });

    try {
      await expect(
        client.entities.create({ entity_id: "asset-throwing-write-watch", entity_type: "asset" })
      ).resolves.toMatchObject({
        entity_id: "asset-throwing-write-watch"
      });
      expect(client.sync.status().degraded).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
      const consoleOutput = JSON.stringify(errorSpy.mock.calls);
      expect(consoleOutput).not.toContain(secret);
      expect(consoleOutput).not.toContain("\\u001b");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("isolates cache state and later watchers from watch callback mutation", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const id = "asset-mutating-watch";
    const mutationResults: boolean[] = [];
    client.entities.watch(id, (value) => {
      if (value) mutationResults.push(Reflect.set(value, "alias", "watch mutation"));
    });
    const observer = vi.fn();
    client.entities.watch(id, observer);

    const updated = core.upsertEntity({ ...entity(id), alias: "server value" });
    core.emit(
      { event: "update", resource_type: "entity", id, version: updated.metadata.version, resource: updated },
      { record: false }
    );

    await vi.waitFor(() => {
      expect(observer).toHaveBeenCalledWith(
        expect.objectContaining({ alias: "server value" }),
        expect.objectContaining({ id })
      );
    });
    expect(mutationResults).toEqual([false]);
    expect(client.sync.snapshot().entities[id].alias).toBe("server value");
    await expect(client.entities.get(id)).resolves.toMatchObject({ alias: "server value" });
  });

  it("honors explicit tasks-for-asset subscriptions across lifecycle updates", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: false,
      pollIntervalMs: 0
    });
    await client.sync.start();
    await client.subscribe({ filter: "tasks_for_asset", asset_id: "asset-old" });
    const watch = vi.fn();
    client.watch({ filter: "tasks_for_asset", asset_id: "asset-old" }, watch);
    await client.connectFeed();

    const first = core.upsertTask(task("task-lifecycle", "asset-old"));
    core.emit(
      { event: "create", resource_type: "task", id: first.task_id, version: first.metadata.version, resource: first },
      { record: false }
    );
    const progressed = core.upsertTask({ ...first, status: "in_progress", progress: 0.5 });
    core.emit(
      {
        event: "update",
        resource_type: "task",
        id: progressed.task_id,
        version: progressed.metadata.version,
        resource: progressed
      },
      { record: false }
    );

    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledWith(
        progressed,
        expect.objectContaining({ id: "task-lifecycle", version: progressed.metadata.version })
      );
    });
  });

  it("sends unsubscribe frames and stops delivering removed watch callbacks", async () => {
    const core = new FakeCore();
    const filter = { filter: "type", resource_type: "task" } as const;
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: false,
      pollIntervalMs: 0
    });
    await client.sync.start();
    await client.subscribe(filter);
    const watch = vi.fn();
    const removeWatch = client.watch(filter, watch);
    await client.connectFeed();
    const socket = Array.from(core.sockets)[0];

    const first = core.upsertTask(task("task-unsubscribe-before", "asset-1"));
    core.emit(
      { event: "create", resource_type: "task", id: first.task_id, version: first.metadata.version, resource: first },
      { record: false }
    );
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));

    await client.unsubscribe(filter);
    removeWatch();

    expect(client.sync.status().subscriptions).toEqual([]);
    expect(socket.sentMessages).toContainEqual({ action: "unsubscribe", filter: "type", resource_type: "task" });
    const second = core.upsertTask(task("task-unsubscribe-after", "asset-1"));
    core.emit(
      {
        event: "create",
        resource_type: "task",
        id: second.task_id,
        version: second.metadata.version,
        resource: second
      },
      { record: false }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("returns isolated buffers while caching object content by version", async () => {
    const core = new FakeCore();
    core.upsertObject(object("object-1"));
    const fetchSpy = vi.fn(core.fetch);
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: fetchSpy,
      sync: "all",
      pollIntervalMs: 0,
      objectContentCacheEntries: 4
    });
    await client.sync.start();
    const first = await client.objects.content("object-1");
    new Uint8Array(first)[0] = 99;
    const second = await client.objects.content("object-1");
    new Uint8Array(second)[1] = 88;
    const third = await client.objects.content("object-1");
    const downloads = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/download"));

    expect([...new Uint8Array(second)]).toEqual([1, 88, 3]);
    expect([...new Uint8Array(third)]).toEqual([1, 2, 3]);
    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
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
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      sync: "all",
      pollIntervalMs: 0,
      objectContentCacheEntries: 4
    });
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

  it("rejects resources written into the wrong cache bucket", () => {
    const cache = new ResourceCache();
    const cacheResource = cache.cacheResource.bind(cache) as (
      type: ResourceType,
      id: string,
      value: ResourceValue
    ) => boolean;
    const taskPayload = task("task-cache-cross-type", "asset-cache-cross-type");

    expect(() => cacheResource("entity", "asset-cache-cross-type", taskPayload)).toThrow("cannot be used as entity");
    expect(cache.entry("entity", "asset-cache-cross-type")).toBeUndefined();
  });

  it("does not commit a cache entry when snapshot cloning fails", () => {
    const cache = new ResourceCache();
    const original = { ...entity("asset-cache-clone-failure"), metadata: metadata(1) };
    cache.cacheResource("entity", original.entity_id, original);
    const snapshot = cache.snapshot();
    const uncloneable = {
      ...original,
      alias: "uncloneable update",
      metadata: metadata(2),
      invalid_runtime_value: () => undefined
    };

    expect(() => cache.cacheResource("entity", original.entity_id, uncloneable)).toThrow();
    expect(cache.value("entity", original.entity_id)).toEqual(original);
    expect(cache.snapshot()).toBe(snapshot);
  });

  it("recovers when a feed event payload crosses resource types", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "entity" }, watch);

    const taskPayload = { ...task("task-watch-cross-type", null), metadata: metadata(1) };
    const socket = [...core.sockets][0];
    if (!socket) throw new Error("expected a connected fake websocket");
    socket.receive({
      event: "update",
      resource_type: "entity",
      id: "asset-watch-cross-type",
      version: 1,
      resource: taskPayload
    });

    await vi.waitFor(() => expect(client.sync.status()).toMatchObject({ healthy: false, degraded: true }));
    expect(watch).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(core.feedConnections).toBe(2), { timeout: 2_000 });
    await vi.waitFor(() => expect(client.sync.status()).toMatchObject({ healthy: true, degraded: false }));

    const valid = core.upsertEntity(entity("asset-watch-cross-type-valid"));
    core.emit(
      {
        event: "update",
        resource_type: "entity",
        id: valid.entity_id,
        version: valid.metadata.version,
        resource: valid
      },
      { record: false }
    );

    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledWith(
        valid,
        expect.objectContaining({ resource_type: "entity", id: valid.entity_id })
      );
    });
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

    expect(beforeWatch).toHaveBeenCalledWith(
      beforeEntity,
      expect.objectContaining({ event: "update", id: "asset-watch-before" })
    );
    expect(removedWatch).not.toHaveBeenCalled();
    expect(afterWatch).toHaveBeenCalledWith(
      afterEntity,
      expect.objectContaining({ event: "update", id: "asset-watch-after" })
    );
  });

  it("rejects malformed stored subscription keys", () => {
    expect(() => parseSubscriptionKey("not-json")).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["unknown", "entity-1"]))).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["type", "not-a-type"]))).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["id", "task"]))).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["tasks_for_asset", ""]))).toThrow("invalid subscription key");
  });
});
