import { describe, expect, it, vi } from "vitest";
import { AtlasClient, type FeedEvent } from "../src";
import { createAtlasClient } from "./support/client.js";
import { entity, FakeCore, metadata } from "./support/fake-core.js";

describe("AtlasClient sync: feed connections and recovery handoff", () => {
  it("drops and recovers when sustained reconnect traffic exceeds the bounded handoff queue", async () => {
    const core = new FakeCore();
    let holdRecovery = false;
    let releaseRecovery: ((response: Response) => void) | undefined;
    const fetchImpl: typeof fetch = (url, init) => {
      if (holdRecovery && new URL(String(url)).pathname === "/queries/changed-since") {
        holdRecovery = false;
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
    await client.sync.start();

    holdRecovery = true;
    const reconnect = client.connectAndRecoverFeed();
    await vi.waitFor(() => expect(releaseRecovery).toBeTypeOf("function"));
    let latest = entity("buffer-overflow-0");
    for (let index = 0; index <= 100; index++) {
      latest = core.upsertEntity(entity(`buffer-overflow-${index}`));
      core.emit(entityUpdateEvent(latest), { record: false });
    }

    await vi.waitFor(() => expect(core.sockets.size).toBe(0));

    releaseRecovery?.(
      Response.json({
        events: [],
        has_more: false,
        version: 0
      })
    );
    await reconnect;
    await vi.waitFor(() => expect(core.feedConnections).toBeGreaterThanOrEqual(3), { timeout: 3_000 });
    await vi.waitFor(() => expect(client.sync.status().lastVersion).toBe(latest.metadata.version), { timeout: 3_000 });

    expect(client.sync.snapshot().entities[latest.entity_id]).toEqual(latest);
    const live = core.upsertEntity(entity("after-buffer-recovery"));
    core.emit(entityUpdateEvent(live), { record: false });
    await vi.waitFor(() => expect(client.sync.snapshot().entities[live.entity_id]).toEqual(live));
    client.sync.stop();
  }, 10_000);

  it("buffers and deduplicates a live mutation received before subscriptions are acknowledged", async () => {
    const core = new FakeCore();
    const client = createAtlasClient(core, {
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const watch = vi.fn();
    client.entities.watch("asset-before-subscriptions-ready", watch);

    let activateAndAcknowledge: (() => void) | undefined;
    core.onFeedSubscriptionBarrier = (release) => {
      core.onFeedSubscriptionBarrier = undefined;
      activateAndAcknowledge = release;
    };
    const reconnect = client.connectAndRecoverFeed();
    await vi.waitFor(() => expect(activateAndAcknowledge).toBeTypeOf("function"));

    const value = core.upsertEntity(entity("asset-before-subscriptions-ready"));
    const event = entityUpdateEvent(value);
    expect(Array.from(core.sockets)[0].subscribedTo(event)).toBe(true);
    core.emit(event, { record: false });
    activateAndAcknowledge?.();
    await reconnect;

    expect(client.sync.status()).toMatchObject({ healthy: true, lastVersion: value.metadata.version });
    expect(client.sync.snapshot().entities[value.entity_id]).toEqual(value);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledWith(value, expect.objectContaining({ version: value.metadata.version }));
    client.sync.stop();
  });

  it("deduplicates a live event buffered behind reconnect recovery", async () => {
    const core = new FakeCore();
    let holdRecovery = false;
    let releaseRecovery: ((response: Response) => void) | undefined;
    let heldResponse: Promise<Response> | undefined;
    const fetchImpl: typeof fetch = (url, init) => {
      if (holdRecovery && new URL(String(url)).pathname === "/queries/changed-since") {
        holdRecovery = false;
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
    await client.sync.start();
    const watch = vi.fn();
    client.entities.watch("asset-overlapping-recovery", watch);
    const value = core.upsertEntity(entity("asset-overlapping-recovery"));

    holdRecovery = true;
    const reconnect = client.connectAndRecoverFeed();
    await vi.waitFor(() => expect(releaseRecovery).toBeTypeOf("function"));
    core.emit(entityUpdateEvent(value), { record: false });
    releaseRecovery?.(await heldResponse!);
    await reconnect;

    expect(client.sync.snapshot().entities[value.entity_id]).toEqual(value);
    expect(watch).toHaveBeenCalledTimes(1);
    client.sync.stop();
  });

  it("keeps changed-since recovery active during a connect-only attempt", async () => {
    const core = new FakeCore();
    const recovered = core.upsertEntity(entity("asset-recovered-during-connect"));
    let releaseRecovery!: (response: Response) => void;
    const pendingRecovery = new Promise<Response>((resolve) => {
      releaseRecovery = resolve;
    });
    const fetchImpl: typeof fetch = (url, init) =>
      new URL(String(url)).pathname === "/queries/changed-since" ? pendingRecovery : core.fetch(url, init);
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });
    const engine = (client as unknown as { engine: { feed: { connect: () => Promise<void> } } }).engine;
    vi.spyOn(engine.feed, "connect").mockResolvedValue(undefined);

    const recovery = client.changedSince();
    await client.connectFeed();
    releaseRecovery(
      Response.json({
        events: [entityUpdateEvent(recovered)],
        has_more: false,
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
    const fetchImpl: typeof fetch = (url, init) =>
      new URL(String(url)).pathname === "/queries/changed-since" ? pendingRecovery : core.fetch(url, init);
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });
    const engine = (client as unknown as { engine: { feed: { connect: () => Promise<void> } } }).engine;
    vi.spyOn(engine.feed, "connect").mockRejectedValue(new Error("connect-only failure"));

    const recovery = client.changedSince();
    await expect(client.connectFeed()).rejects.toThrow("connect-only failure");
    releaseRecovery(
      Response.json({
        events: [entityUpdateEvent(recovered)],
        has_more: false,
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
    const engine = (
      client as unknown as { engine: { feed: { connect: (options: FeedConnectOptions) => Promise<void> } } }
    ).engine;
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
        events: [],
        has_more: false,
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
    const engine = (
      client as unknown as { engine: { feed: { connect: (options: FeedConnectOptions) => Promise<void> } } }
    ).engine;
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
    const client = createAtlasClient(core, {
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
        events: [entityUpdateEvent({ ...entity("asset-new-lifecycle"), metadata: metadata(1) })],
        has_more: false,
        version: 1
      })
    );
    await restart;
    releaseOldRecovery(
      Response.json({
        events: [entityUpdateEvent({ ...entity("asset-old-lifecycle"), metadata: metadata(2) })],
        has_more: false,
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
          events: [],
          has_more: false,
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
          events: [],
          has_more: false,
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
        events: [],
        has_more: false,
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
        return new Response(JSON.stringify({ error_code: "CORE_UNAVAILABLE", message: "retry failed" }), {
          status: 503
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
    const engine = (
      client as unknown as {
        engine: {
          lifecycleGeneration: number;
          changedSinceForGeneration: (generation: number, sinceVersion: number) => Promise<boolean>;
        };
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
          events: [],
          has_more: false,
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
          return new Response(JSON.stringify({ error_code: "CORE_UNAVAILABLE", message: "recovery failed" }), {
            status: 503
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
        engine: {
          lifecycleGeneration: number;
          changedSinceForGeneration: (generation: number, sinceVersion: number) => Promise<boolean>;
        };
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
        return Promise.resolve(
          new Response(JSON.stringify({ error_code: "CORE_UNAVAILABLE", message: "retry failed" }), { status: 503 })
        );
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });
    const engine = (
      client as unknown as {
        engine: {
          lifecycleGeneration: number;
          changedSinceForGeneration: (generation: number, sinceVersion: number) => Promise<boolean>;
        };
      }
    ).engine;

    await client.changedSince();
    const older = client.changedSince();
    await vi.waitFor(() => expect(changedSinceRequests).toBe(2));
    await expect(engine.changedSinceForGeneration(engine.lifecycleGeneration, 1)).rejects.toThrow("503");
    releaseOlder(
      Response.json({
        events: [],
        has_more: false,
        version: 0
      })
    );
    await older;

    expect(client.sync.status()).toHaveProperty("error", "Atlas Core recovery request failed");
  });
});

function entityUpdateEvent(resource: ReturnType<typeof entity>) {
  return {
    event: "update",
    resource_type: "entity",
    id: resource.entity_id,
    version: resource.metadata.version,
    resource
  } as const;
}
