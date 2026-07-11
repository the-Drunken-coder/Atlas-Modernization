import { describe, expect, it, vi } from "vitest";
import { AtlasClient } from "../src";
import type { FeedEvent } from "../src";
import { FeedConnectionManager } from "../src/feed-connection.js";
import { entity, FakeCore, metadata, task } from "./support/fake-core.js";

describe("AtlasClient feed connection", () => {
  it("does not reconnect after an intentional sync.stop feed close", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });

    await client.sync.start();
    expect(core.feedConnections).toBe(1);

    vi.useFakeTimers();
    try {
      client.sync.stop();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(core.feedConnections).toBe(1);
      expect(client.sync.status()).toMatchObject({ running: false, healthy: false, degraded: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes async feed event delivery", async () => {
    const core = new FakeCore();
    const manager = new FeedConnectionManager({
      baseUrl: "http://atlas.test",
      WebSocketImpl: core.attachWebSocketGlobal(),
      feedHandshakeTimeoutMs: 1_000
    });
    const delivery: string[] = [];
    let releaseFirst: (() => void) | undefined;

    await manager.connect({
      subscriptions: [{ filter: "all" }],
      onEvent: async (event) => {
        delivery.push(`start:${event.id}`);
        if (event.id === "entity-ordered-1") {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        delivery.push(`done:${event.id}`);
      },
      onEventError: () => {
        throw new Error("feed event delivery failed");
      },
      onClose: () => undefined
    });

    const first = { ...entity("entity-ordered-1"), metadata: metadata(1) };
    const second = { ...entity("entity-ordered-2"), metadata: metadata(2) };
    core.emit({ event: "create", resource_type: "entity", id: first.entity_id, version: first.metadata.version, resource: first }, { record: false });
    core.emit({ event: "create", resource_type: "entity", id: second.entity_id, version: second.metadata.version, resource: second }, { record: false });

    await vi.waitFor(() => expect(delivery).toEqual(["start:entity-ordered-1"]));
    releaseFirst?.();
    await vi.waitFor(() => expect(delivery).toEqual(["start:entity-ordered-1", "done:entity-ordered-1", "start:entity-ordered-2", "done:entity-ordered-2"]));
    manager.close();
  });

  it("keeps socket close dispatch isolated when the close callback throws", async () => {
    const core = new FakeCore();
    const manager = new FeedConnectionManager({
      baseUrl: "http://atlas.test",
      WebSocketImpl: core.attachWebSocketGlobal(),
      feedHandshakeTimeoutMs: 1_000
    });
    await manager.connect({
      subscriptions: [{ filter: "all" }],
      onEvent: () => undefined,
      onEventError: () => undefined,
      onClose: () => {
        throw new Error("close callback failed");
      }
    });
    const socket = Array.from(core.sockets)[0];

    expect(() => socket.close()).not.toThrow();
  });

  it("uses websocket feed events and converges through changed-since after a forced gap", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    await client.connectFeed();

    const first = core.upsertTask(task("task-gap", "asset-1"));
    core.emit({ event: "update", resource_type: "task", id: first.task_id, version: first.metadata.version, resource: first }, { dropForSockets: true, record: false });
    const second = core.upsertTask({ ...first, status: "acknowledged" });
    const event: FeedEvent = { event: "update", resource_type: "task", id: second.task_id, version: second.metadata.version, resource: second };
    core.emit(event, { record: false });

    await vi.waitFor(async () => {
      await expect(client.tasks.get("task-gap")).resolves.toEqual(second);
    });
    await vi.waitFor(() => expect(client.sync.status().degraded).toBe(false));
  });

  it("starts the websocket feed when sync starts and a WebSocket implementation is available", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    const watch = vi.fn();
    client.entities.watch("asset-auto-feed", watch);

    await client.sync.start();
    const value = core.upsertEntity(entity("asset-auto-feed"));
    core.emit({ event: "update", resource_type: "entity", id: value.entity_id, version: value.metadata.version, resource: value }, { record: false });

    expect(core.sockets.size).toBe(1);
    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledWith(value, expect.objectContaining({ id: "asset-auto-feed", version: value.metadata.version }));
    });
  });

  it("sends API key auth frames before accepting feed events", async () => {
    const core = new FakeCore();
    core.expectedFeedApiKey = "feed-key";
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      apiKey: "feed-key",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });

    await client.connectFeed();

    expect(core.feedAuthFrames).toEqual([{ apiKey: "feed-key" }]);
    const socket = Array.from(core.sockets)[0];
    expect(socket.sentMessages).toContainEqual({ action: "auth", api_key: "feed-key" });
  });

  it("rejects feed connections when the auth frame has the wrong API key", async () => {
    const core = new FakeCore();
    core.expectedFeedApiKey = "right-key";
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      apiKey: "wrong-key",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0,
      feedHandshakeTimeoutMs: 50
    });

    await expect(client.connectFeed()).rejects.toThrow("before protocol hello");
    expect(core.feedAuthFrames).toEqual([{ apiKey: "wrong-key" }]);
    expect(core.sockets.size).toBe(0);
  });

  it("rejects feed connections that close before the protocol hello", async () => {
    const core = new FakeCore();
    core.rejectFeedAuth = true;
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      apiKey: "wrong",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
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
      WebSocket: core.attachWebSocketGlobal(),
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
      WebSocket: core.attachWebSocketGlobal(),
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
      WebSocket: core.attachWebSocketGlobal(),
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
      WebSocket: firstWebSocket,
      sync: "all",
      pollIntervalMs: 0
    });

    await client.connectFeed();

    expect(firstCore.sockets.size).toBe(1);
    expect(secondCore.sockets.size).toBe(0);
  });

  it("retries after feed gap recovery fails", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    await client.connectFeed();

    try {
      core.upsertTask(task("task-gap-fail", "asset-1"));
      const second = core.upsertTask({ ...task("task-gap-fail", "asset-1"), status: "acknowledged" });
      core.failChangedSince = true;
      core.emit({ event: "update", resource_type: "task", id: second.task_id, version: second.metadata.version, resource: second }, { record: false });

      await vi.waitFor(() => {
        expect(client.sync.status().degraded).toBe(true);
        expect(client.sync.status().healthy).toBe(false);
      });

      core.failChangedSince = false;
      await vi.waitFor(() => expect(core.feedConnections).toBe(2), { timeout: 2_000 });
      await vi.waitFor(() => expect(client.sync.snapshot().tasks[second.task_id]).toEqual(second), { timeout: 2_000 });
      expect(client.sync.status()).toMatchObject({ healthy: true, degraded: false, lastVersion: second.metadata.version });
    } finally {
      client.sync.stop();
    }
  });

  it("recovers explicit subscription gaps through changed-since", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: false,
      pollIntervalMs: 0
    });
    await client.subscribe({ filter: "type", resource_type: "task" });
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "task" }, watch);
    await client.sync.start();
    core.requests = [];

    const dropped = core.upsertTask(task("task-explicit-dropped", "asset-1"));
    core.emit({ event: "update", resource_type: "task", id: dropped.task_id, version: dropped.metadata.version, resource: dropped }, { dropForSockets: true, record: false });
    const delivered = core.upsertTask(task("task-explicit-delivered", "asset-1"));
    core.emit({ event: "update", resource_type: "task", id: delivered.task_id, version: delivered.metadata.version, resource: delivered }, { record: false });

    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledWith(dropped, expect.objectContaining({ event: "recovered", id: "task-explicit-dropped" }));
      expect(watch).toHaveBeenCalledWith(delivered, expect.objectContaining({ event: "recovered", id: "task-explicit-delivered" }));
    });
    expect(core.requests.some((request) => request.startsWith("/queries/changed-since?"))).toBe(true);
    expect(client.sync.status().degraded).toBe(false);
  });

  it("keeps feed healthy when watch callbacks throw", async () => {
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
    client.entities.watch("asset-throwing-feed-watch", () => {
      throw new Error("watch failed");
    });

    try {
      const value = core.upsertEntity(entity("asset-throwing-feed-watch"));
      core.emit({ event: "update", resource_type: "entity", id: value.entity_id, version: value.metadata.version, resource: value }, { record: false });

      await vi.waitFor(() => {
        expect(client.sync.status().lastVersion).toBe(value.metadata.version);
      });
      expect(client.sync.status().degraded).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

});
