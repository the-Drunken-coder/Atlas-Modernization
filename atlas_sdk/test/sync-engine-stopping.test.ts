import { describe, expect, it, vi } from "vitest";
import { AtlasClient } from "../src";
import { entity, FakeCore, metadata } from "./support/fake-core.js";

describe("AtlasClient sync: stopping and lifecycle generations", () => {
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
      return Promise.resolve(
        new Response(JSON.stringify({ success: false, message: "not found", error_code: "ENTITY_NOT_FOUND" }), {
          status: 404
        })
      );
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
        engine: {
          activeRecoveryPromise?: Promise<boolean>;
          changedSinceForGeneration: (generation: number) => Promise<boolean>;
        };
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
    const engine = (
      client as unknown as { engine: { feed: { connect: (options: FeedConnectOptions) => Promise<void> } } }
    ).engine;
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
    vi.spyOn(engine.feed, "connect")
      .mockRejectedValueOnce(new Error("first feed failure"))
      .mockResolvedValueOnce(undefined);

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
    vi.spyOn(engine.feed, "connect")
      .mockReturnValueOnce(olderConnect)
      .mockRejectedValueOnce(new Error("newer feed failure"));

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
    vi.spyOn(engine.feed, "connect")
      .mockReturnValueOnce(olderConnect)
      .mockRejectedValueOnce(new Error("newer feed failure"));

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
    const connect = vi
      .spyOn(engine.feed, "connect")
      .mockReturnValueOnce(staleConnect)
      .mockReturnValueOnce(currentConnect);

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
    const connect = vi
      .spyOn(engine.feed, "connect")
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(currentConnect);

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

  it("does not mutate recovery state after a watcher stops the final recovery event", async () => {
    const core = new FakeCore();
    const recovered = core.upsertEntity(entity("asset-stop-during-recovery"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      sync: false,
      pollIntervalMs: 0
    });
    const engine = (
      client as unknown as {
        engine: {
          activeRecoveryPromise?: Promise<boolean>;
          changedSinceForGeneration: (generation: number) => Promise<boolean>;
          lifecycleGeneration: number;
          markSynchronized: () => void;
        };
      }
    ).engine;
    const markSynchronized = vi.spyOn(engine, "markSynchronized");
    let statusAtStop!: ReturnType<typeof client.sync.status>;
    let snapshotAtStop!: ReturnType<typeof client.sync.snapshot>;
    const stop = vi.fn(() => {
      client.sync.stop();
      statusAtStop = client.sync.status();
      snapshotAtStop = client.sync.snapshot();
    });
    client.watch({ filter: "id", resource_type: "entity", id: recovered.entity_id }, stop);

    const recovery = engine.changedSinceForGeneration(engine.lifecycleGeneration);

    await expect(recovery).resolves.toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(client.sync.status()).toEqual(statusAtStop);
    expect(client.sync.snapshot()).toBe(snapshotAtStop);
    expect(markSynchronized).not.toHaveBeenCalled();
    expect(client.sync.status()).toMatchObject({
      running: false,
      healthy: false,
      degraded: false,
      lastVersion: recovered.metadata.version
    });
    expect(client.sync.snapshot().entities).toHaveProperty(recovered.entity_id, recovered);
    expect(engine.activeRecoveryPromise).toBeUndefined();
  });
});
