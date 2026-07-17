import { describe, expect, it, vi } from "vitest";
import { AtlasClient, type FeedEvent, type ResourceType, type TaskResource } from "../src";
import { ResourceCache } from "../src/cache.js";
import { parseSubscriptionKey } from "../src/subscriptions.js";
import { type ChangedSinceResponse, changedSinceToEvents, type ResourceValue } from "../src/types.js";
import { entity, FakeCore, metadata, object, task } from "./support/fake-core.js";

describe("AtlasClient sync", () => {
  it("reports initial synchronization failures in status", async () => {
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: vi.fn(async () => {
        throw new Error("initial request failed");
      }),
      sync: false,
      pollIntervalMs: 0
    });
    await expect(client.sync.start()).rejects.toThrow("initial request failed");
    expect(client.sync.status()).toHaveProperty("error", "Atlas Core initial synchronization failed");
  });

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

  it("does not report a stopped engine healthy after a manual changed-since call", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: false, pollIntervalMs: 60_000 });

    await client.changedSince();

    expect(client.sync.status()).toMatchObject({ running: false, healthy: false, degraded: false });
  });

  it("hydrates, polls changed-since, updates cache, and serves covered reads from cache", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-1"));
    core.upsertTask(task("task-1", "asset-1"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const updated = core.upsertTask({ ...task("task-1", "asset-1"), status: "acknowledged" });
    await client.changedSince();
    await expect(client.tasks.get("task-1")).resolves.toEqual(updated);
    expect(client.sync.status().healthy).toBe(true);
  });

  it("serves object details from the full-dataset cache", async () => {
    const core = new FakeCore();
    const hydrated = core.createObject({ object_id: "object-hydrated-detail", extra: { label: "hydrated" } });
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });

    await client.sync.start();
    core.requests = [];

    await expect(client.objects.get(hydrated.object_id)).resolves.toEqual(hydrated);
    expect(core.requests).toEqual([]);
  });

  it("serves recovered object details from the changed-since cache", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();

    const recovered = core.createObject({ object_id: "object-recovered-detail", extra: { label: "recovered" } });
    await client.changedSince();
    core.requests = [];

    await expect(client.objects.get(recovered.object_id)).resolves.toEqual(recovered);
    expect(core.requests).toEqual([]);
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
      has_more_entities: false,
      has_more_tasks: false,
      has_more_objects: false,
      has_more_deleted_entities: false,
      has_more_deleted_tasks: false,
      has_more_deleted_objects: false,
      version: 5
    };

    expect(changedSinceToEvents(response).map((event) => event.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it("drains paginated changed-since responses before advancing the high-water mark", async () => {
    const core = new FakeCore();
    core.changedSinceLimitPerType = 1;
    let releaseSecondPage!: () => void;
    let secondPageStarted = false;
    const secondPage = new Promise<void>((resolve) => {
      releaseSecondPage = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname === "/queries/changed-since" && requestUrl.searchParams.has("task_cursor")) {
        secondPageStarted = true;
        await secondPage;
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const initialVersion = client.sync.status().lastVersion;
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "task" }, watch);

    const first = core.upsertTask(task("task-page-1", "asset-1"));
    const second = core.upsertTask(task("task-page-2", "asset-1"));
    const recovery = client.changedSince();
    await vi.waitFor(() => expect(secondPageStarted).toBe(true));
    expect(client.sync.status().lastVersion).toBe(initialVersion);
    releaseSecondPage();
    await recovery;

    expect(core.requests.some((request) => request.startsWith("/queries/changed-since?") && request.includes("task_cursor="))).toBe(true);
    expect(watch).toHaveBeenCalledWith(first, expect.objectContaining({ id: "task-page-1", version: first.metadata.version }));
    expect(watch).toHaveBeenCalledWith(second, expect.objectContaining({ id: "task-page-2", version: second.metadata.version }));
    expect(client.sync.status().lastVersion).toBe(core.version);
  });

  it("rejects repeated changed-since cursor states", async () => {
    const core = new FakeCore();
    let changedSinceRequests = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/changed-since") return core.fetch(String(url), init);
      changedSinceRequests += 1;
      if (changedSinceRequests > 4) throw new Error("test stopped repeated changed-since pagination");
      return Response.json({
        entities: [],
        tasks: [],
        objects: [],
        deleted_entities: [],
        deleted_tasks: [],
        deleted_objects: [],
        has_more_entities: true,
        next_entity_cursor: "same-cursor",
        has_more_tasks: true,
        next_task_cursor: `task-cursor-${changedSinceRequests}`,
        has_more_objects: false,
        has_more_deleted_entities: false,
        has_more_deleted_tasks: false,
        has_more_deleted_objects: false,
        version: 0
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });

    await expect(client.changedSince()).rejects.toThrow("Atlas changed-since pagination repeated entity_cursor");
    expect(changedSinceRequests).toBe(2);
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
          has_more_entities: false,
          has_more_tasks: false,
          has_more_objects: false,
          has_more_deleted_entities: false,
          has_more_deleted_tasks: false,
          has_more_deleted_objects: false,
          version: 1
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );
    await recovery;

    expect(client.sync.status().lastVersion).toBe(0);
    expect(client.sync.snapshot().entities).not.toHaveProperty("asset-after-stop");
  });

  it("does not let a stale recovery invalidate a recovery after stop and restart", async () => {
    const core = new FakeCore();
    let secondStart = false;
    let secondStartRecoveryStarted = false;
    let releaseSecondStartRecovery!: (response: Response) => void;
    const secondStartRecovery = new Promise<Response>((resolve) => {
      releaseSecondStartRecovery = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (secondStart && path === "/queries/full") {
        return Response.json({
          entities: [],
          tasks: [],
          objects: [],
          version: 0,
          has_more_entities: false,
          has_more_tasks: false,
          has_more_objects: false
        });
      }
      if (secondStart && path === "/queries/changed-since") {
        secondStartRecoveryStarted = true;
        return secondStartRecovery;
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await client.sync.start();
    client.sync.stop();
    secondStart = true;
    const restart = client.sync.start();
    await vi.waitFor(() => expect(secondStartRecoveryStarted).toBe(true));

    const engine = (
      client as unknown as {
        engine: { activeRecoveryPromise?: Promise<boolean>; changedSinceForGeneration: (generation: number) => Promise<boolean> };
      }
    ).engine;
    const currentRecovery = engine.activeRecoveryPromise;
    expect(currentRecovery).toBeDefined();
    await engine.changedSinceForGeneration(1);
    expect(engine.activeRecoveryPromise).toBe(currentRecovery);
    releaseSecondStartRecovery(
      Response.json({
        entities: [{ ...entity("asset-after-restart"), metadata: metadata(1) }],
        tasks: [],
        objects: [],
        deleted_entities: [],
        deleted_tasks: [],
        deleted_objects: [],
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false,
        has_more_deleted_entities: false,
        has_more_deleted_tasks: false,
        has_more_deleted_objects: false,
        version: 1
      })
    );
    await restart;

    expect(client.sync.snapshot().entities).toHaveProperty("asset-after-restart");
    expect(client.sync.status().lastVersion).toBe(1);
  });

  it("ignores a stale feed completion after stop", async () => {
    let releaseFeedConnect!: () => void;
    let feedOptions!: FeedConnectOptions;
    const feedConnect = new Promise<void>((resolve) => {
      releaseFeedConnect = resolve;
    });
    const client = new AtlasClient({ baseUrl: "http://atlas.test", sync: false, pollIntervalMs: 0 });
    type FeedConnectOptions = {
      subscriptions: unknown[];
      onEvent: (event: unknown) => void | Promise<void>;
      onEventError: () => void;
      onClose: () => void;
    };
    const engine = (client as unknown as { engine: { feed: { connect: (options: FeedConnectOptions) => Promise<void> } } }).engine;
    vi.spyOn(engine.feed, "connect").mockImplementation(async (options) => {
      feedOptions = options;
      await feedConnect;
    });

    const connection = client.connectFeed();
    await vi.waitFor(() => expect(engine.feed.connect).toHaveBeenCalledOnce());
    client.sync.stop();
    await feedOptions.onEvent({
      event: "update",
      resource_type: "entity",
      id: "stale-asset",
      version: 1,
      resource: { ...entity("stale-asset"), metadata: metadata(1) }
    });
    feedOptions.onEventError();
    feedOptions.onClose();
    releaseFeedConnect();
    await connection;

    expect(client.sync.status()).toMatchObject({ running: false, healthy: false, degraded: false });
    expect(client.sync.status()).not.toHaveProperty("error");
    expect(client.sync.snapshot().entities).not.toHaveProperty("stale-asset");
  });

  it("clears a failed manual feed connection after a later successful retry", async () => {
    const client = new AtlasClient({ baseUrl: "http://atlas.test", sync: false, pollIntervalMs: 0 });
    const engine = (client as unknown as { engine: { feed: { connect: () => Promise<void> } } }).engine;
    vi.spyOn(engine.feed, "connect").mockRejectedValueOnce(new Error("first feed failure")).mockResolvedValueOnce(undefined);

    await expect(client.connectFeed()).rejects.toThrow("first feed failure");
    expect(client.sync.status()).toHaveProperty("error", "Atlas Core feed connection failed");

    await client.connectFeed();

    expect(client.sync.status()).not.toHaveProperty("error");
    expect(client.sync.status()).toMatchObject({ running: false, healthy: false, degraded: false });
  });

  it("does not let an older feed success clear a newer failure", async () => {
    let releaseOlder!: () => void;
    const olderConnect = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const client = new AtlasClient({ baseUrl: "http://atlas.test", sync: false, pollIntervalMs: 0 });
    const engine = (client as unknown as { engine: { feed: { connect: () => Promise<void> } } }).engine;
    vi.spyOn(engine.feed, "connect").mockReturnValueOnce(olderConnect).mockRejectedValueOnce(new Error("newer feed failure"));

    const older = client.connectFeed();
    await expect(client.connectFeed()).rejects.toThrow("newer feed failure");
    releaseOlder();
    await older;

    expect(client.sync.status()).toHaveProperty("error", "Atlas Core feed connection failed");
  });

  it("does not let an older feed rejection overwrite a newer success", async () => {
    let rejectOlder!: (reason: unknown) => void;
    const olderConnect = new Promise<void>((_resolve, reject) => {
      rejectOlder = reject;
    });
    const client = new AtlasClient({ baseUrl: "http://atlas.test", sync: false, pollIntervalMs: 0 });
    const engine = (client as unknown as { engine: { feed: { connect: () => Promise<void> } } }).engine;
    vi.spyOn(engine.feed, "connect").mockReturnValueOnce(olderConnect).mockResolvedValueOnce(undefined);

    const older = client.connectFeed();
    await client.connectFeed();
    rejectOlder(new Error("older feed failure"));
    await expect(older).rejects.toThrow("older feed failure");

    expect(client.sync.status()).not.toHaveProperty("error");
  });

  it("does not recover an older feed after a newer attempt fails", async () => {
    let releaseOlder!: () => void;
    const olderConnect = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });
    const engine = (
      client as unknown as {
        engine: { activeRecoveryPromise?: Promise<boolean>; feed: { connect: () => Promise<void> } };
      }
    ).engine;
    vi.spyOn(engine.feed, "connect").mockReturnValueOnce(olderConnect).mockRejectedValueOnce(new Error("newer feed failure"));

    const older = client.connectAndRecoverFeed();
    await expect(client.connectFeed()).rejects.toThrow("newer feed failure");
    releaseOlder();
    await older;

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(engine.activeRecoveryPromise).toBeUndefined();
    expect(client.sync.status()).toHaveProperty("error", "Atlas Core feed connection failed");
  });

  it("rejects a stopped feed connection without letting stale cleanup reset its replacement", async () => {
    let rejectStaleConnect!: (reason: unknown) => void;
    let releaseCurrentConnect!: () => void;
    const staleConnect = new Promise<void>((_resolve, reject) => {
      rejectStaleConnect = reject;
    });
    const currentConnect = new Promise<void>((resolve) => {
      releaseCurrentConnect = resolve;
    });
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: false, pollIntervalMs: 0 });
    const engine = (client as unknown as { engine: { feed: { connect: () => Promise<void> } } }).engine;
    const connect = vi.spyOn(engine.feed, "connect").mockReturnValueOnce(staleConnect).mockReturnValueOnce(currentConnect);

    const stale = client.connectAndRecoverFeed();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    client.sync.stop();

    const current = client.connectAndRecoverFeed();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    const originalError = new Error("stale feed failure");
    rejectStaleConnect(originalError);

    await expect(stale).rejects.toBe(originalError);
    await client.connectAndRecoverFeed();
    expect(connect).toHaveBeenCalledTimes(2);

    releaseCurrentConnect();
    await current;
    expect(client.sync.status()).toMatchObject({ running: false, healthy: false, degraded: false });
    expect(client.sync.status()).not.toHaveProperty("error");
  });

  it("rejects a stopped changed-since request without letting stale cleanup reset its replacement", async () => {
    let rejectRecovery!: (reason: unknown) => void;
    let releaseCurrentConnect!: () => void;
    let changedSinceRequests = 0;
    const pendingRecovery = new Promise<Response>((_resolve, reject) => {
      rejectRecovery = reject;
    });
    const currentConnect = new Promise<void>((resolve) => {
      releaseCurrentConnect = resolve;
    });
    const core = new FakeCore();
    const fetchImpl: typeof fetch = (url, init) => {
      if (new URL(String(url)).pathname === "/queries/changed-since") {
        changedSinceRequests++;
        if (changedSinceRequests === 1) return pendingRecovery;
      }
      return core.fetch(url, init);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });
    const engine = (client as unknown as { engine: { feed: { connect: () => Promise<void> } } }).engine;
    const connect = vi.spyOn(engine.feed, "connect").mockResolvedValueOnce(undefined).mockReturnValueOnce(currentConnect);

    const stale = client.connectAndRecoverFeed();
    await vi.waitFor(() => expect(changedSinceRequests).toBe(1));
    client.sync.stop();

    const current = client.connectAndRecoverFeed();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    const originalError = new Error("stale recovery failure");
    rejectRecovery(originalError);

    await expect(stale).rejects.toBe(originalError);
    await client.connectAndRecoverFeed();
    expect(connect).toHaveBeenCalledTimes(2);

    releaseCurrentConnect();
    await current;
    expect(changedSinceRequests).toBe(2);
    expect(client.sync.status()).toMatchObject({ running: false, healthy: false, degraded: false });
    expect(client.sync.status()).not.toHaveProperty("error");
  });

  it("keeps changed-since recovery active during a connect-only attempt", async () => {
    const core = new FakeCore();
    const recovered = core.upsertEntity(entity("asset-recovered-during-connect"));
    let releaseRecovery!: (response: Response) => void;
    const pendingRecovery = new Promise<Response>((resolve) => {
      releaseRecovery = resolve;
    });
    const fetchImpl: typeof fetch = (url, init) => (new URL(String(url)).pathname === "/queries/changed-since" ? pendingRecovery : core.fetch(url, init));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });
    const engine = (client as unknown as { engine: { feed: { connect: () => Promise<void> } } }).engine;
    vi.spyOn(engine.feed, "connect").mockResolvedValue(undefined);

    const recovery = client.changedSince();
    await client.connectFeed();
    releaseRecovery(
      Response.json({
        entities: [recovered],
        tasks: [],
        objects: [],
        deleted_entities: [],
        deleted_tasks: [],
        deleted_objects: [],
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false,
        has_more_deleted_entities: false,
        has_more_deleted_tasks: false,
        has_more_deleted_objects: false,
        version: recovered.metadata.version
      })
    );
    await recovery;

    expect(client.sync.snapshot().entities).toHaveProperty(recovered.entity_id);
    expect(client.sync.status().lastVersion).toBe(recovered.metadata.version);
  });

  it("keeps changed-since recovery active when a connect-only attempt fails", async () => {
    const core = new FakeCore();
    const recovered = core.upsertEntity(entity("asset-recovered-during-failed-connect"));
    let releaseRecovery!: (response: Response) => void;
    const pendingRecovery = new Promise<Response>((resolve) => {
      releaseRecovery = resolve;
    });
    const fetchImpl: typeof fetch = (url, init) => (new URL(String(url)).pathname === "/queries/changed-since" ? pendingRecovery : core.fetch(url, init));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });
    const engine = (client as unknown as { engine: { feed: { connect: () => Promise<void> } } }).engine;
    vi.spyOn(engine.feed, "connect").mockRejectedValue(new Error("connect-only failure"));

    const recovery = client.changedSince();
    await expect(client.connectFeed()).rejects.toThrow("connect-only failure");
    releaseRecovery(
      Response.json({
        entities: [recovered],
        tasks: [],
        objects: [],
        deleted_entities: [],
        deleted_tasks: [],
        deleted_objects: [],
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false,
        has_more_deleted_entities: false,
        has_more_deleted_tasks: false,
        has_more_deleted_objects: false,
        version: recovered.metadata.version
      })
    );
    await recovery;

    expect(client.sync.snapshot().entities).toHaveProperty(recovered.entity_id);
    expect(client.sync.status().lastVersion).toBe(recovered.metadata.version);
    expect(client.sync.status()).toHaveProperty("error", "Atlas Core feed connection failed");
  });

  it("does not apply an older feed event after its recovery outlives the connection", async () => {
    type FeedConnectOptions = { onEvent: (event: FeedEvent) => void | Promise<void> };
    const feedOptions: FeedConnectOptions[] = [];
    let releaseRecovery!: (response: Response) => void;
    const pendingRecovery = new Promise<Response>((resolve) => {
      releaseRecovery = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>((url) => {
      if (new URL(String(url)).pathname === "/queries/changed-since") return pendingRecovery;
      throw new Error(`unexpected request: ${String(url)}`);
    });
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });
    const engine = (client as unknown as { engine: { feed: { connect: (options: FeedConnectOptions) => Promise<void> } } }).engine;
    vi.spyOn(engine.feed, "connect").mockImplementation(async (options) => {
      feedOptions.push(options);
    });

    await client.connectFeed();
    const olderEvent = feedOptions[0].onEvent({
      event: "update",
      resource_type: "entity",
      id: "asset-from-older-feed",
      version: 2,
      resource: { ...entity("asset-from-older-feed"), metadata: metadata(2) }
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await client.connectFeed();
    releaseRecovery(
      Response.json({
        entities: [],
        tasks: [],
        objects: [],
        deleted_entities: [],
        deleted_tasks: [],
        deleted_objects: [],
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false,
        has_more_deleted_entities: false,
        has_more_deleted_tasks: false,
        has_more_deleted_objects: false,
        version: 1
      })
    );
    await olderEvent;

    expect(client.sync.snapshot().entities).not.toHaveProperty("asset-from-older-feed");
    expect(client.sync.status().lastVersion).toBe(1);
  });

  it("keeps a stopped engine out of degraded state after a manual feed event error", async () => {
    const client = new AtlasClient({ baseUrl: "http://atlas.test", sync: false, pollIntervalMs: 0 });
    type FeedConnectOptions = { onEventError: () => void };
    let feedOptions!: FeedConnectOptions;
    const engine = (client as unknown as { engine: { feed: { connect: (options: FeedConnectOptions) => Promise<void> } } }).engine;
    vi.spyOn(engine.feed, "connect").mockImplementation(async (options) => {
      feedOptions = options;
    });

    await client.connectFeed();
    feedOptions.onEventError();

    expect(client.sync.status()).toMatchObject({
      running: false,
      healthy: false,
      degraded: false,
      error: "Atlas Core feed event failed"
    });
  });

  it("ignores delayed events from a feed after it closes", async () => {
    type FeedConnectOptions = { onEvent: (event: FeedEvent) => void | Promise<void>; onClose: () => void };
    let feedOptions!: FeedConnectOptions;
    const client = new AtlasClient({ baseUrl: "http://atlas.test", sync: false, pollIntervalMs: 0 });
    const engine = (
      client as unknown as {
        engine: { feed: { connect: (options: FeedConnectOptions) => Promise<void> } };
      }
    ).engine;
    vi.spyOn(engine.feed, "connect").mockImplementation(async (options) => {
      feedOptions = options;
    });

    await client.connectFeed();
    feedOptions.onClose();
    await feedOptions.onEvent({
      event: "update",
      resource_type: "entity",
      id: "asset-after-close",
      version: 1,
      resource: { ...entity("asset-after-close"), metadata: metadata(1) }
    });

    expect(client.sync.snapshot().entities).not.toHaveProperty("asset-after-close");
    client.sync.stop();
  });

  it("ignores queued events from a feed after an event error", async () => {
    type FeedConnectOptions = { onEvent: (event: FeedEvent) => void | Promise<void>; onEventError: () => void };
    let feedOptions!: FeedConnectOptions;
    const client = new AtlasClient({ baseUrl: "http://atlas.test", sync: false, pollIntervalMs: 0 });
    const engine = (
      client as unknown as {
        engine: { syncRunning: boolean; feed: { connect: (options: FeedConnectOptions) => Promise<void> } };
      }
    ).engine;
    vi.spyOn(engine.feed, "connect").mockImplementation(async (options) => {
      feedOptions = options;
    });

    await client.connectFeed();
    engine.syncRunning = true;
    feedOptions.onEventError();
    await feedOptions.onEvent({
      event: "update",
      resource_type: "entity",
      id: "asset-after-event-error",
      version: 1,
      resource: { ...entity("asset-after-event-error"), metadata: metadata(1) }
    });

    expect(client.sync.snapshot().entities).not.toHaveProperty("asset-after-event-error");
    client.sync.stop();
  });

  it("keeps a closed-feed error after a socket-only reconnect", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });

    try {
      await client.sync.start();
      Array.from(core.sockets)[0]?.close();
      await vi.waitFor(() => expect(client.sync.status()).toHaveProperty("error", "Atlas Core feed connection closed"));

      await client.connectFeed();

      expect(client.sync.status()).toMatchObject({
        healthy: false,
        degraded: true,
        error: "Atlas Core feed connection closed"
      });
    } finally {
      client.sync.stop();
    }
  });

  it("stays degraded until post-connect recovery succeeds", async () => {
    const core = new FakeCore();
    let holdNextRecovery = false;
    let releaseRecovery: ((response: Response) => void) | undefined;
    let heldResponse: Promise<Response> | undefined;
    const fetchImpl: typeof fetch = (url, init) => {
      if (new URL(String(url)).pathname === "/queries/changed-since" && holdNextRecovery) {
        holdNextRecovery = false;
        heldResponse = core.fetch(String(url), init);
        return new Promise<Response>((resolve) => {
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
      Array.from(core.sockets)[0]?.close();
      await vi.waitFor(() => expect(client.sync.status()).toHaveProperty("error", "Atlas Core feed connection closed"));

      holdNextRecovery = true;
      const failedRecovery = client.connectAndRecoverFeed();
      await vi.waitFor(() => expect(releaseRecovery).toBeTypeOf("function"));
      expect(client.sync.status()).toMatchObject({
        healthy: false,
        degraded: true,
        error: "Atlas Core feed connection closed"
      });

      releaseRecovery?.(new Response("recovery unavailable", { status: 503 }));
      await expect(failedRecovery).rejects.toThrow();
      expect(client.sync.status()).toMatchObject({
        healthy: false,
        degraded: true,
        error: "Atlas Core recovery request failed"
      });

      releaseRecovery = undefined;
      heldResponse = undefined;
      holdNextRecovery = true;
      const successfulRecovery = client.connectAndRecoverFeed();
      await vi.waitFor(() => expect(releaseRecovery).toBeTypeOf("function"));
      expect(client.sync.status()).toMatchObject({
        healthy: false,
        degraded: true,
        error: "Atlas Core recovery request failed"
      });

      releaseRecovery?.(await heldResponse!);
      await successfulRecovery;
      expect(client.sync.status()).toMatchObject({ healthy: true, degraded: false });
      expect(client.sync.status()).not.toHaveProperty("error");
    } finally {
      client.sync.stop();
    }
  });

  it("starts a fresh reconnect recovery after feed close supersedes an active one", async () => {
    const core = new FakeCore();
    let holdRecovery = false;
    let releaseStaleRecovery!: (response: Response) => void;
    let recoveryRequests = 0;
    const fetchImpl: typeof fetch = (url, init) => {
      if (new URL(String(url)).pathname === "/queries/changed-since") {
        recoveryRequests++;
        if (holdRecovery) {
          holdRecovery = false;
          return new Promise<Response>((resolve) => {
            releaseStaleRecovery = resolve;
          });
        }
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
      const requestsBeforeStaleRecovery = recoveryRequests;
      holdRecovery = true;
      const staleRecovery = client.changedSince();
      await vi.waitFor(() => expect(recoveryRequests).toBe(requestsBeforeStaleRecovery + 1));
      [...core.sockets][0]?.close();

      const reconnect = client.connectAndRecoverFeed();
      await vi.waitFor(() => expect(recoveryRequests).toBe(requestsBeforeStaleRecovery + 2));
      await reconnect;
      releaseStaleRecovery(await core.fetch("http://atlas.test/queries/changed-since?since_version=0"));
      await staleRecovery;

      expect(client.sync.status()).toMatchObject({ running: true, healthy: true, degraded: false });
    } finally {
      client.sync.stop();
    }
  });

  it("ignores an in-flight recovery from a previous lifecycle after restart", async () => {
    const core = new FakeCore();
    let stage: "normal" | "old" | "old-in-flight" | "new" = "normal";
    let oldRecoveryStarted = false;
    let newRecoveryStarted = false;
    let releaseOldRecovery!: (response: Response) => void;
    let releaseNewRecovery!: (response: Response) => void;
    const oldRecovery = new Promise<Response>((resolve) => {
      releaseOldRecovery = resolve;
    });
    const newRecovery = new Promise<Response>((resolve) => {
      releaseNewRecovery = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (stage === "new" && path === "/queries/full") {
        return Response.json({
          entities: [],
          tasks: [],
          objects: [],
          version: 0,
          has_more_entities: false,
          has_more_tasks: false,
          has_more_objects: false
        });
      }
      if (path === "/queries/changed-since") {
        if (stage === "old") {
          stage = "old-in-flight";
          oldRecoveryStarted = true;
          return oldRecovery;
        }
        if (stage === "new") {
          newRecoveryStarted = true;
          return newRecovery;
        }
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await client.sync.start();
    stage = "old";
    const old = client.changedSince();
    await vi.waitFor(() => expect(oldRecoveryStarted).toBe(true));
    client.sync.stop();
    stage = "new";
    const restart = client.sync.start();
    await vi.waitFor(() => expect(newRecoveryStarted).toBe(true));
    releaseNewRecovery(
      Response.json({
        entities: [{ ...entity("asset-new-lifecycle"), metadata: metadata(1) }],
        tasks: [],
        objects: [],
        deleted_entities: [],
        deleted_tasks: [],
        deleted_objects: [],
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false,
        has_more_deleted_entities: false,
        has_more_deleted_tasks: false,
        has_more_deleted_objects: false,
        version: 1
      })
    );
    await restart;
    releaseOldRecovery(
      Response.json({
        entities: [{ ...entity("asset-old-lifecycle"), metadata: metadata(2) }],
        tasks: [],
        objects: [],
        deleted_entities: [],
        deleted_tasks: [],
        deleted_objects: [],
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false,
        has_more_deleted_entities: false,
        has_more_deleted_tasks: false,
        has_more_deleted_objects: false,
        version: 2
      })
    );
    await old;

    expect(client.sync.snapshot().entities).toHaveProperty("asset-new-lifecycle");
    expect(client.sync.snapshot().entities).not.toHaveProperty("asset-old-lifecycle");
    expect(client.sync.status().lastVersion).toBe(1);
  });

  it("shares startup recovery with a concurrent changed-since request", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const core = new FakeCore();
    let changedSinceRequests = 0;
    let releaseStartupRecovery!: (response: Response) => void;
    let startupRecoveryUrl = "";
    let startupRecoveryInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = (url, init) => {
      if (new URL(String(url)).pathname === "/queries/changed-since") {
        changedSinceRequests++;
        if (changedSinceRequests === 1) {
          startupRecoveryUrl = String(url);
          startupRecoveryInit = init;
          return new Promise<Response>((resolve) => {
            releaseStartupRecovery = resolve;
          });
        }
        throw new Error("started a duplicate recovery request");
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    try {
      const startup = client.sync.start();
      await vi.waitFor(() => expect(releaseStartupRecovery).toBeTypeOf("function"));
      const concurrentRecovery = client.changedSince();
      expect(changedSinceRequests).toBe(1);
      releaseStartupRecovery(await core.fetch(startupRecoveryUrl, startupRecoveryInit));

      await Promise.all([startup, concurrentRecovery]);
      expect(changedSinceRequests).toBe(1);
      expect(client.sync.status()).toMatchObject({ running: true, healthy: false, degraded: true });
    } finally {
      client.sync.stop();
      vi.unstubAllGlobals();
    }
  });

  it("runs post-hydration catch-up when an earlier recovery uses a different cursor", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const core = new FakeCore();
    let fullRequested = false;
    let releaseFull!: (response: Response) => void;
    let releaseEarlyRecovery!: (response: Response) => void;
    const pendingFull = new Promise<Response>((resolve) => {
      releaseFull = resolve;
    });
    const pendingEarlyRecovery = new Promise<Response>((resolve) => {
      releaseEarlyRecovery = resolve;
    });
    const changedSinceVersions: string[] = [];
    const fetchImpl: typeof fetch = (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/queries/full") {
        fullRequested = true;
        return pendingFull;
      }
      if (parsed.pathname === "/queries/changed-since") {
        const sinceVersion = parsed.searchParams.get("since_version") ?? "";
        changedSinceVersions.push(sinceVersion);
        if (sinceVersion === "0") return pendingEarlyRecovery;
        return Response.json({
          entities: [],
          tasks: [],
          objects: [],
          deleted_entities: [],
          deleted_tasks: [],
          deleted_objects: [],
          has_more_entities: false,
          has_more_tasks: false,
          has_more_objects: false,
          has_more_deleted_entities: false,
          has_more_deleted_tasks: false,
          has_more_deleted_objects: false,
          version: 5
        });
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    try {
      const startup = client.sync.start();
      await vi.waitFor(() => expect(fullRequested).toBe(true));
      const earlyRecovery = client.changedSince();
      await vi.waitFor(() => expect(changedSinceVersions).toContain("0"));
      releaseFull(
        Response.json({
          entities: [],
          tasks: [],
          objects: [],
          version: 5,
          has_more_entities: false,
          has_more_tasks: false,
          has_more_objects: false
        })
      );
      await vi.waitFor(() => expect(changedSinceVersions).toContain("5"));
      releaseEarlyRecovery(
        Response.json({
          entities: [],
          tasks: [],
          objects: [],
          deleted_entities: [],
          deleted_tasks: [],
          deleted_objects: [],
          has_more_entities: false,
          has_more_tasks: false,
          has_more_objects: false,
          has_more_deleted_entities: false,
          has_more_deleted_tasks: false,
          has_more_deleted_objects: false,
          version: 0
        })
      );

      await Promise.all([startup, earlyRecovery]);
      expect(changedSinceVersions).toEqual(["0", "5"]);
      expect(client.sync.status().lastVersion).toBe(5);
    } finally {
      client.sync.stop();
      vi.unstubAllGlobals();
    }
  });

  it("shares matching in-flight changed-since recovery outside startup", async () => {
    let releaseRecovery!: (response: Response) => void;
    const pendingRecovery = new Promise<Response>((resolve) => {
      releaseRecovery = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(() => pendingRecovery.then((response) => response.clone()));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });

    const first = client.changedSince();
    const second = client.changedSince();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    releaseRecovery(
      Response.json({
        entities: [],
        tasks: [],
        objects: [],
        deleted_entities: [],
        deleted_tasks: [],
        deleted_objects: [],
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false,
        has_more_deleted_entities: false,
        has_more_deleted_tasks: false,
        has_more_deleted_objects: false,
        version: 0
      })
    );

    await Promise.all([first, second]);
  });

  it("does not apply a gapped feed event after its recovery is superseded by a failed recovery", async () => {
    const core = new FakeCore();
    let gapRecovery = false;
    let gapRecoveryStarted = false;
    let releaseGapRecovery!: (response: Response) => void;
    const gapResponse = new Promise<Response>((resolve) => {
      releaseGapRecovery = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (gapRecovery && path === "/queries/changed-since") {
        if (!gapRecoveryStarted) {
          gapRecoveryStarted = true;
          return gapResponse;
        }
        return new Response(JSON.stringify({ error_code: "CORE_UNAVAILABLE", message: "retry failed" }), { status: 503 });
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
    const engine = (
      client as unknown as {
        engine: { lifecycleGeneration: number; changedSinceForGeneration: (generation: number, sinceVersion: number) => Promise<boolean> };
      }
    ).engine;

    let unsubscribe: (() => void) | undefined;
    try {
      await client.sync.start();
      gapRecovery = true;
      const socket = [...core.sockets][0];
      if (!socket) throw new Error("expected a connected fake websocket");
      socket.receive({
        event: "update",
        resource_type: "entity",
        id: "asset-gapped-feed",
        version: 2,
        resource: { ...entity("asset-gapped-feed"), metadata: metadata(2) }
      });
      await vi.waitFor(() => expect(gapRecoveryStarted).toBe(true));
      expect(client.sync.status()).toMatchObject({ running: true, healthy: false, degraded: true });
      await expect(engine.changedSinceForGeneration(engine.lifecycleGeneration, 1)).rejects.toThrow("503");
      let resolveFollowUp!: () => void;
      const followUp = new Promise<void>((resolve) => {
        resolveFollowUp = resolve;
      });
      unsubscribe = client.entities.watch("asset-after-gap", () => resolveFollowUp());
      releaseGapRecovery(
        Response.json({
          entities: [],
          tasks: [],
          objects: [],
          deleted_entities: [],
          deleted_tasks: [],
          deleted_objects: [],
          has_more_entities: false,
          has_more_tasks: false,
          has_more_objects: false,
          has_more_deleted_entities: false,
          has_more_deleted_tasks: false,
          has_more_deleted_objects: false,
          version: 0
        })
      );
      socket.receive({
        event: "update",
        resource_type: "entity",
        id: "asset-after-gap",
        version: 1,
        resource: { ...entity("asset-after-gap"), metadata: metadata(1) }
      });
      await followUp;

      expect(client.sync.snapshot().entities).not.toHaveProperty("asset-gapped-feed");
      expect(client.sync.status()).toHaveProperty("error", "Atlas Core recovery request failed");
      expect(client.sync.status().lastVersion).toBe(1);
    } finally {
      unsubscribe?.();
      client.sync.stop();
    }
  });

  it("keeps a gapped feed recovery failure as the public error", async () => {
    const core = new FakeCore();
    let failRecovery = false;
    let recoveryRequests = 0;
    const fetchImpl: typeof fetch = (url, init) => {
      if (failRecovery && new URL(String(url)).pathname === "/queries/changed-since") {
        recoveryRequests++;
        return Promise.resolve(new Response("recovery unavailable", { status: 503 }));
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
      failRecovery = true;
      const socket = [...core.sockets][0];
      if (!socket) throw new Error("expected a connected fake websocket");
      socket.receive({
        event: "update",
        resource_type: "entity",
        id: "asset-gap-recovery-failure",
        version: 2,
        resource: { ...entity("asset-gap-recovery-failure"), metadata: metadata(2) }
      });
      await vi.waitFor(() => expect(recoveryRequests).toBe(1));
      await vi.waitFor(() =>
        expect(client.sync.status()).toMatchObject({
          running: true,
          healthy: false,
          degraded: true,
          error: "Atlas Core recovery request failed"
        })
      );
    } finally {
      client.sync.stop();
    }
  });

  it("retries a failed recovery while the sync engine remains running", async () => {
    const core = new FakeCore();
    let failNextRecovery = false;
    let recoveryRequests = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname === "/queries/changed-since") {
        recoveryRequests++;
        if (failNextRecovery) {
          failNextRecovery = false;
          return new Response(JSON.stringify({ error_code: "CORE_UNAVAILABLE", message: "recovery failed" }), { status: 503 });
        }
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
      failNextRecovery = true;
      await expect(client.changedSince()).rejects.toThrow("503");
      const requestsBeforeRetry = recoveryRequests;

      await vi.waitFor(
        () => {
          expect(recoveryRequests).toBeGreaterThan(requestsBeforeRetry);
          const status = client.sync.status();
          expect(status).toMatchObject({ running: true, healthy: true, degraded: false });
          expect(status).not.toHaveProperty("error");
        },
        { timeout: 2_500 }
      );
    } finally {
      client.sync.stop();
    }
  });

  it("does not let a feed close clear a newer feed failure", async () => {
    const core = new FakeCore();
    let delayNextRecovery = false;
    let releaseRecovery!: (response: Response) => void;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (delayNextRecovery && new URL(String(url)).pathname === "/queries/changed-since") {
        delayNextRecovery = false;
        return new Promise<Response>((resolve) => {
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
      delayNextRecovery = true;
      const recovery = client.changedSince();
      await vi.waitFor(() => expect(releaseRecovery).toBeTypeOf("function"));

      const socket = [...core.sockets][0];
      if (!socket) throw new Error("expected a connected fake websocket");
      socket.close();
      releaseRecovery(await core.fetch("http://atlas.test/queries/changed-since?since_version=0"));
      await expect(recovery).resolves.toBeUndefined();
      expect(client.sync.status()).toMatchObject({
        running: true,
        healthy: false,
        degraded: true,
        error: "Atlas Core feed connection closed"
      });
    } finally {
      client.sync.stop();
    }
  });

  it("rejects an older recovery failure without overwriting a newer retry", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-newer-recovery"));
    let releaseOlder!: (reason?: unknown) => void;
    let changedSinceRequests = 0;
    const fetchImpl: typeof fetch = (url, init) => {
      if (new URL(String(url)).pathname === "/queries/changed-since") {
        changedSinceRequests++;
        if (changedSinceRequests === 1) return Promise.reject(new Error("initial recovery failed"));
        if (changedSinceRequests === 2) {
          return new Promise<Response>((_resolve, reject) => {
            releaseOlder = reject;
          });
        }
        return core.fetch(String(url), init);
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });
    const engine = (
      client as unknown as {
        engine: { lifecycleGeneration: number; changedSinceForGeneration: (generation: number, sinceVersion: number) => Promise<boolean> };
      }
    ).engine;

    await expect(client.changedSince()).rejects.toThrow("initial recovery failed");
    const older = client.changedSince();
    await vi.waitFor(() => expect(changedSinceRequests).toBe(2));
    await engine.changedSinceForGeneration(engine.lifecycleGeneration, 1);
    const originalError = new Error("stale recovery failed");
    releaseOlder(originalError);
    await expect(older).rejects.toBe(originalError);

    expect(client.sync.status()).not.toHaveProperty("error");
  });

  it("does not let an older recovery success clear a newer retry error", async () => {
    const core = new FakeCore();
    let releaseOlder!: (response: Response) => void;
    let changedSinceRequests = 0;
    const fetchImpl: typeof fetch = (url, init) => {
      if (new URL(String(url)).pathname === "/queries/changed-since") {
        changedSinceRequests++;
        if (changedSinceRequests === 1) return core.fetch(String(url), init);
        if (changedSinceRequests === 2) {
          return new Promise<Response>((resolve) => {
            releaseOlder = resolve;
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ error_code: "CORE_UNAVAILABLE", message: "retry failed" }), { status: 503 }));
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });
    const engine = (
      client as unknown as {
        engine: { lifecycleGeneration: number; changedSinceForGeneration: (generation: number, sinceVersion: number) => Promise<boolean> };
      }
    ).engine;

    await client.changedSince();
    const older = client.changedSince();
    await vi.waitFor(() => expect(changedSinceRequests).toBe(2));
    await expect(engine.changedSinceForGeneration(engine.lifecycleGeneration, 1)).rejects.toThrow("503");
    releaseOlder(
      Response.json({
        entities: [],
        tasks: [],
        objects: [],
        deleted_entities: [],
        deleted_tasks: [],
        deleted_objects: [],
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false,
        has_more_deleted_entities: false,
        has_more_deleted_tasks: false,
        has_more_deleted_objects: false,
        version: 0
      })
    );
    await older;

    expect(client.sync.status()).toHaveProperty("error", "Atlas Core recovery request failed");
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

  it("replaces pre-start point-read cache state at the hydration watermark", async () => {
    const core = new FakeCore();
    const cached = core.upsertEntity(entity("asset-deleted-before-hydration"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });

    await expect(client.entities.get(cached.entity_id)).resolves.toEqual(cached);
    expect(client.sync.snapshot().entities).toEqual({ [cached.entity_id]: cached });
    const deletion = core.deleteEntity(cached.entity_id);
    if (!deletion) throw new Error("fake core did not delete the hydration fixture");

    await client.sync.start();

    const snapshot = client.sync.snapshot();
    expect(snapshot.entities).toEqual({});
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entities)).toBe(true);
    expect(client.sync.status().lastVersion).toBe(deletion.version);
    expect(core.requests).toContain(`/queries/changed-since?since_version=${deletion.version}`);
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

  it("recovers changes after the initial full-dataset watermark instead of advancing from later pages", async () => {
    const core = new FakeCore();
    core.version = 1000;
    const staleEntity = core.upsertEntity(entity("asset-hydration-race"));
    const snapshotVersion = staleEntity.metadata.version;
    const fullDatasetRequests: string[] = [];
    const changedSinceVersions: string[] = [];
    let concurrentUpdate!: EntityResource;
    let laterPageTask!: TaskResource;
    const fetchImpl: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/queries/full") {
        fullDatasetRequests.push(parsed.pathname + parsed.search);
        if (fullDatasetRequests.length === 1) {
          concurrentUpdate = core.upsertEntity({ ...staleEntity, alias: "updated between full pages" });
          laterPageTask = core.upsertTask(task("task-hydration-later-page", staleEntity.entity_id));
          return Response.json({
            entities: [staleEntity],
            tasks: [],
            objects: [],
            version: snapshotVersion,
            has_more_tasks: true,
            has_more_entities: false,
            has_more_objects: false,
            next_task_cursor: "later-task-page"
          });
        }
        expect(parsed.searchParams.get("task_cursor")).toBe("later-task-page");
        return Response.json({
          entities: [],
          tasks: [laterPageTask],
          objects: [],
          version: snapshotVersion,
          has_more_entities: false,
          has_more_tasks: false,
          has_more_objects: false
        });
      }
      if (parsed.pathname === "/queries/changed-since") {
        changedSinceVersions.push(parsed.searchParams.get("since_version") ?? "");
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

      expect(fullDatasetRequests).toHaveLength(2);
      expect(changedSinceVersions[0]).toBe(String(snapshotVersion));
      expect(concurrentUpdate.metadata.version).toBe(1002);
      expect(laterPageTask.metadata.version).toBe(1003);
      expect(client.sync.snapshot().entities[staleEntity.entity_id]).toEqual(concurrentUpdate);
      expect(client.sync.snapshot().tasks[laterPageTask.task_id]).toEqual(laterPageTask);
      expect(client.sync.status().lastVersion).toBe(1003);
    } finally {
      client.sync.stop();
    }
  });

  it("rejects missing full-dataset version watermarks", async () => {
    const core = new FakeCore();
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/full") return core.fetch(String(url), init);
      return Response.json({ entities: [], tasks: [], objects: [], has_more_entities: false, has_more_tasks: false, has_more_objects: false });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await expect(client.sync.start()).rejects.toThrow("Atlas response failed validation for GET /queries/full");
    expect(client.sync.snapshot()).toEqual({ entities: {}, tasks: {}, objects: {} });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid full-dataset version watermark %s", async (version) => {
    const core = new FakeCore();
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/full") return core.fetch(String(url), init);
      return Response.json({ entities: [], tasks: [], objects: [], version, has_more_entities: false, has_more_tasks: false, has_more_objects: false });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await expect(client.sync.start()).rejects.toThrow("Atlas response failed validation for GET /queries/full");
  });

  it("rejects changing full-dataset version watermarks", async () => {
    const core = new FakeCore();
    let fullDatasetRequests = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/full") return core.fetch(String(url), init);
      fullDatasetRequests += 1;
      return Response.json({
        entities: [],
        tasks: [],
        objects: [],
        version: fullDatasetRequests,
        has_more_entities: fullDatasetRequests === 1,
        has_more_tasks: false,
        has_more_objects: false,
        next_entity_cursor: fullDatasetRequests === 1 ? "next-page" : undefined
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await expect(client.sync.start()).rejects.toThrow("changed version watermark from 1 to 2");
    expect(fullDatasetRequests).toBe(2);
    expect(client.sync.snapshot()).toEqual({ entities: {}, tasks: {}, objects: {} });
  });

  it("rejects repeated full-dataset cursor states", async () => {
    const core = new FakeCore();
    let fullDatasetRequests = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/full") return core.fetch(String(url), init);
      fullDatasetRequests += 1;
      if (fullDatasetRequests > 4) throw new Error("test stopped repeated full-dataset pagination");
      return Response.json({
        entities: [],
        tasks: [],
        objects: [],
        version: 0,
        has_more_entities: true,
        next_entity_cursor: "same-cursor",
        has_more_tasks: true,
        next_task_cursor: `task-cursor-${fullDatasetRequests}`,
        has_more_objects: false
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await expect(client.sync.start()).rejects.toThrow("Atlas full-dataset pagination repeated entity_cursor");
    expect(fullDatasetRequests).toBe(2);
  });

  it("allows advancing full-dataset pagination beyond 100 pages", async () => {
    const core = new FakeCore();
    let fullDatasetRequests = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/full") return core.fetch(String(url), init);
      fullDatasetRequests += 1;
      return Response.json({
        entities: [],
        tasks: [],
        objects: [],
        version: 0,
        has_more_entities: fullDatasetRequests <= 100,
        next_entity_cursor: fullDatasetRequests <= 100 ? `cursor-${fullDatasetRequests}` : undefined,
        has_more_tasks: false,
        has_more_objects: false
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await expect(client.sync.start()).resolves.toBeUndefined();
    expect(fullDatasetRequests).toBe(101);
  });

  it("does not expose partial hydration when pagination fails", async () => {
    const core = new FakeCore();
    const existing = core.upsertEntity(entity("asset-before-failed-hydration"));
    let failHydration = false;
    let fullDatasetRequests = 0;
    const partial = { ...entity("asset-partial-hydration"), metadata: metadata(1) };
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/full") return core.fetch(String(url), init);
      if (!failHydration) return core.fetch(String(url), init);
      fullDatasetRequests += 1;
      return Response.json({
        entities: fullDatasetRequests === 1 ? [partial] : [],
        tasks: [],
        objects: [],
        version: core.version,
        has_more_entities: true,
        next_entity_cursor: "same-cursor",
        has_more_tasks: true,
        next_task_cursor: `task-cursor-${fullDatasetRequests}`,
        has_more_objects: false
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await client.sync.start();
    const snapshot = client.sync.snapshot();
    client.sync.stop();
    failHydration = true;

    await expect(client.sync.start()).rejects.toThrow("Atlas full-dataset pagination repeated entity_cursor");
    expect(client.sync.snapshot()).toBe(snapshot);
    expect(client.sync.snapshot().entities).toEqual({ [existing.entity_id]: existing });
  });

  it("falls through to Core when no automatic update path exists", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-without-updates"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });

    try {
      await client.sync.start();
      expect(client.sync.status()).toMatchObject({ running: true, healthy: false, degraded: true });

      const updated = core.upsertEntity({ ...original, alias: "fresh from Core" });
      core.requests = [];

      await expect(client.entities.get(original.entity_id)).resolves.toEqual(updated);
      expect(core.requests).toContain(`/entities/${original.entity_id}`);
    } finally {
      client.sync.stop();
      vi.unstubAllGlobals();
    }
  });

  it("treats polling as the update path when WebSocket is unavailable", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 60_000 });

    try {
      await client.sync.start();
      expect(client.sync.status()).toMatchObject({ running: true, healthy: true, degraded: false });
    } finally {
      client.sync.stop();
      vi.unstubAllGlobals();
    }
  });

  it("treats polling as the update path while WebSocket is disconnected", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 60_000
    });

    try {
      await client.sync.start();
      const socket = [...core.sockets][0];
      if (!socket) throw new Error("expected an initial feed socket");
      socket.close();
      await client.changedSince();

      expect(client.sync.status()).toMatchObject({ running: true, healthy: true, degraded: false });
    } finally {
      client.sync.stop();
    }
  });

  it("returns pure live cache snapshots after paginated hydration and deletes", async () => {
    const core = new FakeCore();
    core.fullLimitPerType = 1;
    const firstEntity = core.upsertEntity(entity("asset-snapshot-1"));
    const secondEntity = core.upsertEntity(entity("asset-snapshot-2"));
    const firstTask = core.upsertTask(task("task-snapshot-1", firstEntity.entity_id));
    const deletedTask = core.upsertTask(task("task-snapshot-deleted", secondEntity.entity_id));
    const cachedObject = core.upsertObject(object("object-snapshot"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });

    await client.sync.start();
    const requestCount = core.requests.length;
    const first = client.sync.snapshot();
    const second = client.sync.snapshot();

    expect(first).toEqual({
      entities: { [firstEntity.entity_id]: firstEntity, [secondEntity.entity_id]: secondEntity },
      tasks: { [firstTask.task_id]: firstTask, [deletedTask.task_id]: deletedTask },
      objects: { [cachedObject.object_id]: { ...cachedObject, extra: {} } }
    });
    expect(second).toEqual(first);
    expect(second).toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.entities)).toBe(true);
    expect(Object.isFrozen(second.entities[firstEntity.entity_id])).toBe(true);
    expect(core.requests).toHaveLength(requestCount);

    expect(() => {
      first.entities[firstEntity.entity_id].alias = "caller mutation";
    }).toThrow(TypeError);
    expect(second.entities[firstEntity.entity_id]).toEqual(firstEntity);
    expect(client.sync.snapshot().entities[firstEntity.entity_id]).toEqual(firstEntity);
    await expect(client.entities.get(firstEntity.entity_id)).resolves.toEqual(firstEntity);

    core.deleteTask(deletedTask.task_id);
    await client.changedSince();

    const afterDelete = client.sync.snapshot();
    expect(afterDelete).not.toBe(first);
    expect(afterDelete.entities).toBe(first.entities);
    expect(afterDelete.objects).toBe(first.objects);
    expect(afterDelete.tasks).not.toBe(first.tasks);
    expect(afterDelete.tasks).toEqual({ [firstTask.task_id]: firstTask });
  });

  it("uses one immutable resource value for cache reads and snapshots", () => {
    const cache = new ResourceCache();
    const source = {
      ...entity("asset-cache-owned"),
      alias: "server value",
      components: { health: { battery_percent: 87 } },
      metadata: metadata(1)
    };

    expect(cache.cacheResource("entity", source.entity_id, source)).toBe(true);
    const cached = cache.value("entity", source.entity_id);
    const snapshot = cache.snapshot();

    expect(cached).toBe(snapshot.entities[source.entity_id]);
    expect(cached).not.toBe(source);
    expect(Object.isFrozen(cached)).toBe(true);
    expect(Object.isFrozen(cached?.components.health)).toBe(true);

    Reflect.set(source, "alias", "source mutation");
    Reflect.set(source.components.health, "battery_percent", 1);
    if (cached) {
      Reflect.set(cached, "alias", "read mutation");
      if (cached.components.health) Reflect.set(cached.components.health, "battery_percent", 0);
    }

    expect(cache.value("entity", source.entity_id)?.alias).toBe("server value");
    expect(cache.value("entity", source.entity_id)?.components.health?.battery_percent).toBe(87);
    expect(cache.snapshot()).toBe(snapshot);
    expect(cache.snapshot().entities[source.entity_id].alias).toBe("server value");
  });

  it("preserves snapshot references and version guards across object detail upgrades", () => {
    const cache = new ResourceCache();
    const cachedEntity = { ...entity("asset-detail-reference"), metadata: metadata(1) };
    const summary = { ...object("object-detail-upgrade"), metadata: metadata(2) };
    cache.cacheResource("entity", cachedEntity.entity_id, cachedEntity);
    cache.cacheResource("object", summary.object_id, summary);
    const beforeDetail = cache.snapshot();
    const detail = { ...summary, extra: { nested: { confidence: 0.91 } } };

    expect(cache.objectDetail(summary.object_id)).toBeUndefined();

    expect(cache.cacheResource("object", detail.object_id, detail, { detail: true })).toBe(true);
    const afterDetail = cache.snapshot();

    expect(afterDetail).not.toBe(beforeDetail);
    expect(afterDetail.entities).toBe(beforeDetail.entities);
    expect(afterDetail.objects).not.toBe(beforeDetail.objects);
    expect(cache.value("object", detail.object_id)).toBe(afterDetail.objects[detail.object_id]);
    expect(cache.entry("object", detail.object_id)).toMatchObject({ version: 2, detail: true });
    expect(cache.objectDetail(detail.object_id)).toBe(afterDetail.objects[detail.object_id]);
    expect(afterDetail.objects[detail.object_id]).toMatchObject({ extra: detail.extra });
    expect(Object.isFrozen(Reflect.get(afterDetail.objects[detail.object_id], "extra").nested)).toBe(true);

    const stale = { ...summary, type: "stale", metadata: metadata(1) };
    expect(cache.cacheResource("object", stale.object_id, stale, { detail: true })).toBe(false);
    expect(cache.cacheResource("object", summary.object_id, summary)).toBe(false);
    expect(cache.cacheResource("object", detail.object_id, detail, { detail: true })).toBe(false);
    expect(cache.snapshot()).toBe(afterDetail);
    expect(cache.value("object", detail.object_id)).toMatchObject({ type: summary.type, extra: detail.extra });
  });

  it("projects feed, recovery, remote-delete, and local-delete changes through snapshots", async () => {
    const core = new FakeCore();
    const localTask = core.upsertTask(task("task-snapshot-local-delete", "asset-snapshot-feed"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const snapshots = vi.fn(() => client.sync.snapshot());
    client.watch({ filter: "all" }, snapshots);

    const fedEntity = core.upsertEntity(entity("asset-snapshot-feed"));
    core.emit(
      { event: "create", resource_type: "entity", id: fedEntity.entity_id, version: fedEntity.metadata.version, resource: fedEntity },
      { record: false }
    );
    await vi.waitFor(() => expect(snapshots).toHaveReturnedWith(expect.objectContaining({ entities: { [fedEntity.entity_id]: fedEntity } })));

    const recoveredTask = core.upsertTask(task("task-snapshot-recovered", fedEntity.entity_id));
    await client.changedSince();
    expect(snapshots).toHaveReturnedWith(expect.objectContaining({ tasks: expect.objectContaining({ [recoveredTask.task_id]: recoveredTask }) }));

    core.deleteEntity(fedEntity.entity_id);
    await client.changedSince();
    expect(client.sync.snapshot().entities).not.toHaveProperty(fedEntity.entity_id);

    await client.tasks.delete(localTask.task_id);
    expect(client.sync.snapshot().tasks).not.toHaveProperty(localTask.task_id);
  });

  it("does not let a stale write response regress a newer cached resource", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-stale-write"));
    let resolveWrite!: (response: Response) => void;
    const staleWrite = new Promise<Response>((resolve) => {
      resolveWrite = resolve;
    });
    const fetchImpl: typeof fetch = (url, init) => {
      if (new URL(String(url)).pathname === `/entities/${original.entity_id}` && init?.method === "PATCH") return staleWrite;
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: fetchImpl,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();

    const write = client.entities.update(original.entity_id, { alias: "stale response" });
    const newer = core.upsertEntity({ ...original, alias: "newer feed value" });
    core.emit({ event: "update", resource_type: "entity", id: newer.entity_id, version: newer.metadata.version, resource: newer }, { record: false });
    await vi.waitFor(() => expect(client.sync.snapshot().entities[original.entity_id]).toEqual(newer));

    resolveWrite(Response.json(original));
    await expect(write).resolves.toEqual(original);
    expect(client.sync.snapshot().entities[original.entity_id]).toEqual(newer);
  });

  it("keeps cached previous values intact for tasks-for-entity routing", async () => {
    const core = new FakeCore();
    const original = core.upsertTask(task("task-owned-previous", "asset-old"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const cached = await client.tasks.get(original.task_id);
    Reflect.set(cached, "entity_id", "asset-caller-mutation");
    const watch = vi.fn();
    client.watch({ filter: "tasks_for_entity", entity_id: "asset-old" }, watch);

    const reassigned = core.upsertTask({ ...original, entity_id: "asset-new" });
    core.emit(
      { event: "update", resource_type: "task", id: reassigned.task_id, version: reassigned.metadata.version, resource: reassigned },
      { record: false }
    );

    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledWith(reassigned, expect.objectContaining({ event: "update", id: reassigned.task_id }));
    });
    expect(client.sync.snapshot().tasks[original.task_id].entity_id).toBe("asset-new");
  });

  it("does not start duplicate polling intervals when sync.start is called twice sequentially", async () => {
    vi.useFakeTimers();
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 100 });

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
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 100 });

    try {
      await client.sync.start();
      holdRecovery = true;
      pollRequests = 0;
      core.requests = [];

      await vi.advanceTimersByTimeAsync(250);

      expect(pollRequests).toBe(1);
      releaseRecovery(
        Response.json({
          entities: [],
          tasks: [],
          objects: [],
          deleted_entities: [],
          deleted_tasks: [],
          deleted_objects: [],
          has_more_entities: false,
          has_more_tasks: false,
          has_more_objects: false,
          has_more_deleted_entities: false,
          has_more_deleted_tasks: false,
          has_more_deleted_objects: false,
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

    expect(() => core.emit({ event: "update", resource_type: "entity", id: value.entity_id, version: value.metadata.version, resource: value })).toThrow(
      "duplicate fake core event version"
    );
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
      await expect(client.entities.create({ entity_id: "asset-throwing-write-watch", entity_type: "asset" })).resolves.toMatchObject({
        entity_id: "asset-throwing-write-watch"
      });
      expect(client.sync.status().degraded).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
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
    core.emit({ event: "update", resource_type: "entity", id, version: updated.metadata.version, resource: updated }, { record: false });

    await vi.waitFor(() => {
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({ alias: "server value" }), expect.objectContaining({ id }));
    });
    expect(mutationResults).toEqual([false]);
    expect(client.sync.snapshot().entities[id].alias).toBe("server value");
    await expect(client.entities.get(id)).resolves.toMatchObject({ alias: "server value" });
  });

  it("honors explicit tasks-for-entity subscriptions across reassignment", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: false,
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
    core.emit({ event: "create", resource_type: "task", id: first.task_id, version: first.metadata.version, resource: first }, { record: false });
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));

    await client.unsubscribe(filter);
    removeWatch();

    expect(client.sync.status().subscriptions).toEqual([]);
    expect(socket.sentMessages).toContainEqual({ action: "unsubscribe", filter: "type", resource_type: "task" });
    const second = core.upsertTask(task("task-unsubscribe-after", "asset-1"));
    core.emit({ event: "create", resource_type: "task", id: second.task_id, version: second.metadata.version, resource: second }, { record: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("returns isolated buffers while caching object content by version", async () => {
    const core = new FakeCore();
    core.upsertObject(object("object-1"));
    const fetchSpy = vi.fn(core.fetch);
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchSpy, sync: "all", pollIntervalMs: 0, objectContentCacheEntries: 4 });
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

  it("rejects resources written into the wrong cache bucket", () => {
    const cache = new ResourceCache();
    const cacheResource = cache.cacheResource.bind(cache) as (type: ResourceType, id: string, value: ResourceValue) => boolean;
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
    core.emit({ event: "update", resource_type: "entity", id: valid.entity_id, version: valid.metadata.version, resource: valid }, { record: false });

    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledWith(valid, expect.objectContaining({ resource_type: "entity", id: valid.entity_id }));
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
