import { describe, expect, it, vi } from "vitest";
import { AtlasAPIError, AtlasClient, ConflictError, ProtocolMismatchError, isTaskCreateRequest, type FeedEvent } from "../src";
import { RESOURCE_TYPE_VALUES, isResourceType, parseFilter, runCLI, type CLIIO } from "../src/cli.js";
import { FeedConnectionManager } from "../src/feed-connection.js";
import { parseSubscriptionKey } from "../src/subscriptions.js";
import { changedSinceToEvents, type ChangedSinceResponse } from "../src/types.js";
import { entity, FakeCore, metadata, object, task } from "./fake-core";

async function crossRealmTaskCreateRequest(): Promise<Record<string, unknown>> {
  if (typeof document !== "undefined" && document.body) {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    try {
      const objectCtor = iframe.contentWindow?.Object;
      if (!objectCtor) {
        throw new Error("iframe Object constructor unavailable");
      }
      const value = new objectCtor() as Record<string, unknown>;
      value.task_id = "task-cross-realm";
      return value;
    } finally {
      iframe.remove();
    }
  }

  const { runInNewContext } = await import(/* @vite-ignore */ "node:vm");
  return runInNewContext("({ task_id: 'task-cross-realm' })") as Record<string, unknown>;
}

describe("AtlasClient HTTP", () => {
  it("fails loudly on protocol revision mismatch", async () => {
    const core = new FakeCore();
    core.revision = "sha256:mismatch";
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });
    await expect(client.handshake()).rejects.toBeInstanceOf(ProtocolMismatchError);
  });

  it("aborts stalled HTTP requests with a clear timeout error", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, requestTimeoutMs: 50 });

    try {
      const handshake = expect(client.handshake()).rejects.toThrow("Atlas request timed out after 50ms");
      await vi.advanceTimersByTimeAsync(50);
      await handshake;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects non-positive request timeouts", () => {
    const core = new FakeCore();

    expect(() => new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, requestTimeoutMs: 0 })).toThrow("positive finite");
  });

  it("accepts plain records and rejects non-plain records in task create requests", async () => {
    const nullPrototypeRequest = Object.assign(Object.create(null) as Record<string, unknown>, { task_id: "task-null-proto" });
    const crossRealmRequest = await crossRealmTaskCreateRequest();

    expect(isTaskCreateRequest({ task_id: "task-plain", components: {}, extra: {} })).toBe(true);
    expect(isTaskCreateRequest(nullPrototypeRequest)).toBe(true);
    expect(isTaskCreateRequest(crossRealmRequest)).toBe(true);
    expect(isTaskCreateRequest({ task_id: "task-date", components: new Date() })).toBe(false);
    expect(isTaskCreateRequest({ task_id: "task-map", extra: new Map([["priority", "high"]]) })).toBe(false);
  });

  it("applies writes to cache and exposes precondition conflicts as ConflictError", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const created = await client.entities.create({ entity_id: "asset-1", entity_type: "asset" });
    await expect(client.entities.get("asset-1")).resolves.toEqual(created);
    await expect(client.entities.update("asset-1", { alias: "new" }, { ifMatchVersion: 0 })).rejects.toBeInstanceOf(ConflictError);
  });

  it("matches Core duplicate-create conflicts in the fake transport", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    await client.entities.create({ entity_id: "asset-conflict", entity_type: "asset" });
    await expect(client.entities.create({ entity_id: "asset-conflict", entity_type: "asset" })).rejects.toMatchObject({
      status: 409,
      errorCode: "ENTITY_ALREADY_EXISTS"
    });

    await client.tasks.create({ task_id: "task-conflict" });
    await expect(client.tasks.create({ task_id: "task-conflict" })).rejects.toMatchObject({
      status: 409,
      errorCode: "TASK_ALREADY_EXISTS"
    });

    await client.objects.create({ object_id: "object-conflict" });
    await expect(client.objects.create({ object_id: "object-conflict" })).rejects.toMatchObject({
      status: 409,
      errorCode: "OBJECT_ALREADY_EXISTS"
    });
  });

  it("rejects response-shaped write payloads with protocol error details", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    await expect(client.entities.create(entity("asset-with-metadata") as any)).rejects.toMatchObject({
      status: 400,
      errorCode: "INVALID_JSON"
    });
    await expect(client.objects.create({ ...object("object-with-bucket"), bucket: "client-owned" } as any)).rejects.toMatchObject({
      status: 400,
      errorCode: "INVALID_JSON"
    });
  });

  it("exposes object payload on object detail and write responses", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    const created = await client.objects.create({
      object_id: "object-with-payload",
      type: "image",
      extra: { label: "thermal", nested: { confidence: 0.91 } }
    });
    expect(created.payload).toEqual({ label: "thermal", nested: { confidence: 0.91 } });

    const fetched = await client.objects.get("object-with-payload", { fresh: true });
    expect(fetched.payload).toEqual(created.payload);

    const updated = await client.objects.update("object-with-payload", {
      extra: { reviewed: true, label: "visual" }
    });
    expect(updated.payload).toEqual({ label: "visual", nested: { confidence: 0.91 }, reviewed: true });
  });

  it("refetches object detail when the sync cache only has a feed object", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();

    await expect(
      client.objects.create({
        object_id: "object-feed-cache",
        type: "image",
        extra: { label: "thermal" }
      })
    ).resolves.toMatchObject({ payload: { label: "thermal" } });

    const feedObject = core.upsertObject({ ...object("object-feed-cache"), type: "log" });
    core.emit({ event: "update", resource_type: "object", id: feedObject.object_id, version: feedObject.metadata.version, resource: feedObject }, { record: false });

    await vi.waitFor(() => {
      expect(client.sync.status().lastVersion).toBeGreaterThanOrEqual(feedObject.metadata.version);
    });

    const detailRequestsBeforeRead = core.requests.filter((request) => request === "/objects/object-feed-cache").length;
    const fetched = await client.objects.get("object-feed-cache");

    expect(fetched).toMatchObject({
      object_id: "object-feed-cache",
      type: "log",
      payload: { label: "thermal" }
    });
    expect(core.requests.filter((request) => request === "/objects/object-feed-cache")).toHaveLength(detailRequestsBeforeRead + 1);
  });

  it("rejects write payloads with missing required fields or invalid shapes", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    await expect(client.tasks.create({} as any)).rejects.toMatchObject({
      status: 400,
      errorCode: "INVALID_JSON"
    });
    await expect(client.objects.create({ object_id: "object-invalid-ref", referenced_by: [{}] } as any)).rejects.toMatchObject({
      status: 400,
      errorCode: "INVALID_JSON"
    });
    core.upsertEntity(entity("asset-empty-update"));
    await expect(client.entities.update("asset-empty-update", {} as any)).rejects.toMatchObject({
      status: 400,
      errorCode: "INVALID_JSON"
    });
  });

  it("rejects cyclic JSON values in task create extra payloads", () => {
    const extra: Record<string, unknown> = {};
    extra.self = extra;

    expect(isTaskCreateRequest({ task_id: "task-cycle", extra })).toBe(false);
  });

  it("returns protocol errors for malformed fake Core request JSON", async () => {
    const core = new FakeCore();

    const response = await core.fetch("http://atlas.test/tasks", { method: "POST", body: "{" });

    await expect(response.json()).resolves.toEqual({
      success: false,
      message: "Invalid JSON body",
      error_code: "INVALID_JSON"
    });
    expect(response.status).toBe(400);
  });

  it("returns protocol errors for invalid fake Core changed-since query params", async () => {
    const core = new FakeCore();

    const response = await core.fetch("http://atlas.test/queries/changed-since?since_version=invalid");

    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error_code: "VALIDATION_ERROR"
    });
    expect(response.status).toBe(400);
  });

  it("returns protocol errors when downloading missing fake Core objects", async () => {
    const core = new FakeCore();

    const response = await core.fetch("http://atlas.test/objects/missing-object/download");

    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error_code: "OBJECT_NOT_FOUND"
    });
    expect(response.status).toBe(404);
  });

  it("preserves structured protocol errors for non-conflict failures", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    await expect(client.entities.get("missing-entity")).rejects.toMatchObject({
      status: 404,
      errorCode: "ENTITY_NOT_FOUND",
      response: expect.objectContaining({ success: false, error_code: "ENTITY_NOT_FOUND" })
    });
    await expect(client.entities.get("missing-entity")).rejects.toBeInstanceOf(AtlasAPIError);
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

  it("fails loudly when the fake core records duplicate event versions", () => {
    const core = new FakeCore();
    const value = core.upsertEntity(entity("asset-duplicate-version"));

    expect(() =>
      core.emit({ event: "update", resource_type: "entity", id: value.entity_id, version: value.metadata.version, resource: value })
    ).toThrow("duplicate fake core event version");
  });

  it("marks the sync engine degraded when feed gap recovery fails", async () => {
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

    core.upsertTask(task("task-gap-fail", "asset-1"));
    const second = core.upsertTask({ ...task("task-gap-fail", "asset-1"), status: "acknowledged" });
    core.failChangedSince = true;
    core.emit({ event: "update", resource_type: "task", id: second.task_id, version: second.metadata.version, resource: second }, { record: false });

    await vi.waitFor(() => {
      expect(client.sync.status().degraded).toBe(true);
      expect(client.sync.status().healthy).toBe(false);
    });
  });

  it("recovers selective subscription gaps through changed-since", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "selective",
      pollIntervalMs: 0
    });
    await client.subscribe({ filter: "type", resource_type: "task" });
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "task" }, watch);
    await client.sync.start();
    core.requests = [];

    const dropped = core.upsertTask(task("task-selective-dropped", "asset-1"));
    core.emit({ event: "update", resource_type: "task", id: dropped.task_id, version: dropped.metadata.version, resource: dropped }, { dropForSockets: true, record: false });
    const delivered = core.upsertTask(task("task-selective-delivered", "asset-1"));
    core.emit({ event: "update", resource_type: "task", id: delivered.task_id, version: delivered.metadata.version, resource: delivered }, { record: false });

    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledWith(dropped, expect.objectContaining({ event: "recovered", id: "task-selective-dropped" }));
      expect(watch).toHaveBeenCalledWith(delivered, expect.objectContaining({ event: "recovered", id: "task-selective-delivered" }));
    });
    expect(core.requests.some((request) => request.startsWith("/queries/changed-since?"))).toBe(true);
    expect(client.sync.status().degraded).toBe(false);
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

  it("matches the simulation ledger at checkpoints and run end", async () => {
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

    for (let i = 0; i < 24; i++) {
      if (i % 3 === 0) {
        const entityID = `asset-sim-${i % 5}`;
        const value = core.upsertEntity({ ...entity(entityID), alias: `asset ${i}` });
        const event: FeedEvent = { event: "update", resource_type: "entity", id: entityID, version: value.metadata.version, resource: value };
        core.emit(event, { dropForSockets: i === 6, record: false });
      }
      const id = `task-sim-${i % 4}`;
      const value = core.upsertTask({ ...task(id, `asset-${i % 3}`), status: i % 2 === 0 ? "pending" : "acknowledged" });
      const event: FeedEvent = { event: "update", resource_type: "task", id, version: value.metadata.version, resource: value };
      core.emit(event, { dropForSockets: i === 7, record: false });
      if (i % 4 === 0) {
        const objectID = `object-sim-${i % 3}`;
        const value = core.upsertObject({ ...object(objectID), type: i % 8 === 0 ? "image" : "log" });
        const objectEvent: FeedEvent = { event: "update", resource_type: "object", id: objectID, version: value.metadata.version, resource: value };
        core.emit(objectEvent, { dropForSockets: i === 12, record: false });
      }
      // Mid-simulation task delete is dropped from sockets to force gap reconciliation.
      if (i === 10) {
        const event = core.deleteTask("task-sim-2");
        if (event) core.emit(event, { dropForSockets: true, record: false });
      }
      // Entity delete follows later so the ledger sees a live tombstone after recovery.
      if (i === 14) {
        const event = core.deleteEntity("asset-sim-2");
        if (event) core.emit(event, { record: false });
      }
      // Object delete lands near the tail to cover all resource tombstone types.
      if (i === 18) {
        const event = core.deleteObject("object-sim-1");
        if (event) core.emit(event, { record: false });
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

  it("prunes empty watcher buckets after unwatch", () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });
    const engine = (client as unknown as { engine: { watchers: Map<string, Set<unknown>> } }).engine;

    const unwatch = client.entities.watch("asset-watch-prune", vi.fn());
    expect(engine.watchers.size).toBe(1);

    unwatch();

    expect(engine.watchers.size).toBe(0);
  });

  it("rejects malformed stored subscription keys", () => {
    expect(() => parseSubscriptionKey("not-json")).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["unknown", "entity-1"]))).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["type", "not-a-type"]))).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["id", "task"]))).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["tasks_for_entity", ""]))).toThrow("invalid subscription key");
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

    const invalidTask = captureIO();
    await expect(runCLI(["tasks", "create", '{"task_id":"","status":"pending","entity_id":null,"components":{},"metadata":{"created_at":"2026-06-12T12:00:00Z","updated_at":"2026-06-12T12:00:00Z","version":0}}'], invalidTask.io)).resolves.toBe(2);
    expect(invalidTask.stderr()).toContain("invalid task JSON");

    const badFilter = captureIO();
    await expect(runCLI(["watch", "--subscribe", "id:not-a-type:x"], badFilter.io)).resolves.toBe(2);
    expect(badFilter.stderr()).toContain("invalid subscription filter");
  });

  it("creates tasks with Core request payloads and server defaults", async () => {
    const core = new FakeCore();
    const minimal = captureIO();
    minimal.io.fetch = core.fetch;

    await expect(runCLI(["--base-url", "http://atlas.test", "tasks", "create", '{"task_id":"task-minimal"}'], minimal.io)).resolves.toBe(0);

    expect(JSON.parse(minimal.stdout())).toMatchObject({
      task_id: "task-minimal",
      status: "pending",
      entity_id: null,
      components: {}
    });

    const expanded = captureIO();
    expanded.io.fetch = core.fetch;
    await expect(
      runCLI(
        [
          "--base-url",
          "http://atlas.test",
          "tasks",
          "create",
          '{"task_id":"task-expanded","status":"acknowledged","entity_id":"asset-1","components":{"parameters":{"latitude":1}},"extra":{"priority":"high"}}'
        ],
        expanded.io
      )
    ).resolves.toBe(0);

    expect(JSON.parse(expanded.stdout())).toMatchObject({
      task_id: "task-expanded",
      status: "acknowledged",
      entity_id: "asset-1",
      components: { parameters: { latitude: 1 } },
      extra: { priority: "high" }
    });
  });

  it.each([
    '{"task_id":""}',
    '{"task_id":"task-invalid","entity_id":""}',
    '{"task_id":"task-invalid","components":[]}',
    '{"task_id":"task-invalid","extra":[]}',
    '{"task_id":"task-invalid","metadata":{"created_at":"2026-06-12T12:00:00Z","updated_at":"2026-06-12T12:00:00Z","version":1}}'
  ])("rejects invalid task create request %s before handshake", async (body) => {
    const io = captureIO();

    await expect(runCLI(["tasks", "create", body], io.io)).resolves.toBe(2);

    expect(io.stderr()).toContain("invalid task JSON");
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
    expect(parseFilter("id:task:::id")).toEqual({ filter: "id", resource_type: "task", id: "::id" });
    expect(parseFilter("tasks_for_entity:asset-1")).toEqual({ filter: "tasks_for_entity", entity_id: "asset-1" });
    expect(parseFilter("tasks_for_entity:asset:with:colons")).toEqual({ filter: "tasks_for_entity", entity_id: "asset:with:colons" });
  });

  it("rejects invalid subscription filters", () => {
    expect(isResourceType("invalid")).toBe(false);
    expect(() => parseFilter("unknown_filter")).toThrow("invalid subscription filter");
    expect(() => parseFilter("type:invalid")).toThrow("invalid subscription filter");
    expect(() => parseFilter("id:task")).toThrow("invalid subscription filter");
    expect(() => parseFilter("id:task:")).toThrow("invalid subscription filter");
    expect(() => parseFilter("tasks_for_entity")).toThrow("invalid subscription filter");
  });

  it("requires --follow for watch subscriptions", async () => {
    const io = captureIO();

    await expect(runCLI(["watch", "--subscribe", "all"], io.io)).resolves.toBe(2);

    expect(io.stderr()).toContain("watch requires --follow");
  });

  it("runs watch mode through the sync engine and recovers dropped matching events", async () => {
    const core = new FakeCore();
    const captured = captureIO();
    captured.io.fetch = core.fetch;
    captured.io.WebSocket = core.attachWebSocketGlobal();
    captured.io.waitForExitSignal = async () => {
      const dropped = core.upsertTask(task("task-cli-dropped", "asset-1"));
      core.emit({ event: "update", resource_type: "task", id: dropped.task_id, version: dropped.metadata.version, resource: dropped }, { dropForSockets: true, record: false });
      const delivered = core.upsertTask(task("task-cli-delivered", "asset-1"));
      core.emit({ event: "update", resource_type: "task", id: delivered.task_id, version: delivered.metadata.version, resource: delivered }, { record: false });

      await vi.waitFor(() => {
        expect(captured.stdout()).toContain('"id":"task-cli-dropped"');
        expect(captured.stdout()).toContain('"id":"task-cli-delivered"');
      });
    };

    await expect(runCLI(["--base-url", "http://atlas.test", "watch", "--subscribe", "type:task", "--follow"], captured.io)).resolves.toBe(0);

    expect(core.requests.some((request) => request.startsWith("/queries/full"))).toBe(true);
    expect(core.requests.some((request) => request.startsWith("/queries/changed-since?"))).toBe(true);
  });

  it("stops watch sync when follow exits with an error", async () => {
    const core = new FakeCore();
    const captured = captureIO();
    captured.io.fetch = core.fetch;
    captured.io.WebSocket = core.attachWebSocketGlobal();
    captured.io.waitForExitSignal = async () => {
      throw new Error("follow failed");
    };

    await expect(runCLI(["--base-url", "http://atlas.test", "watch", "--subscribe", "type:task", "--follow"], captured.io)).resolves.toBe(1);

    expect(captured.stderr()).toContain("follow failed");
    expect(core.sockets.size).toBe(0);
  });

  it("prints non-Error failures without crashing", async () => {
    const core = new FakeCore();
    const captured = captureIO();
    captured.io.fetch = core.fetch;
    captured.io.WebSocket = core.attachWebSocketGlobal();
    captured.io.waitForExitSignal = async () => {
      throw "raw follow failure";
    };

    await expect(runCLI(["--base-url", "http://atlas.test", "watch", "--subscribe", "all", "--follow"], captured.io)).resolves.toBe(1);

    expect(captured.stderr()).toContain("raw follow failure");
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
