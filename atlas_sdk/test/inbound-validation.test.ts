import { describe, expect, it, vi } from "vitest";
import {
  ATLAS_PROTOCOL_REVISION,
  AtlasClient,
  isChangedSinceResponse,
  isEntityCheckInFullResponse,
  isFullDatasetResponse
} from "../src";
import { FeedConnectionManager } from "../src/feed-connection.js";
import { entity, FakeCore, metadata, object, task } from "./support/fake-core.js";
import { FakeWebSocket } from "./support/fake-websocket.js";

const validEntity = (id: string, version: number) => ({ ...entity(id), metadata: metadata(version) });
const validTask = (id: string, assetID: string) => ({ ...task(id, assetID) });
const validObject = (id: string, version: number) => ({ ...object(id), metadata: metadata(version) });
const fullPage = (overrides: Record<string, unknown> = {}) => ({
  entities: [],
  tasks: [],
  objects: [],
  version: 0,
  has_more_entities: false,
  has_more_tasks: false,
  has_more_objects: false,
  ...overrides
});
const changedPage = (overrides: Record<string, unknown> = {}) => ({
  events: [],
  has_more: false,
  version: 4,
  ...overrides
});
const changedEntityEvent = (id: string, version: number) => ({
  event: "update",
  resource_type: "entity",
  id,
  version,
  resource: validEntity(id, version)
});

describe("AtlasClient inbound response validation", () => {
  it("requires continuation cursors in paginated response validators", () => {
    expect(isFullDatasetResponse(fullPage({ has_more_entities: true }))).toBe(false);
    expect(isChangedSinceResponse(changedPage({ has_more: true }))).toBe(false);
  });

  it("rejects a malformed HTTP handshake even when the protocol revision matches", async () => {
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async () => Response.json({ protocol_revision: ATLAS_PROTOCOL_REVISION, unexpected: true })
    });

    await expect(client.handshake()).rejects.toThrow("Atlas response failed validation for GET /protocol/revision");
  });

  it.each<[string, unknown]>([
    ["missing a required resource array", { entities: [], objects: [] }],
    ["missing its version watermark", fullPage({ version: undefined })],
    ["with a fractional version watermark", fullPage({ version: 1.5 })],
    ["containing a resource in the wrong bucket", fullPage({ entities: [validTask("task-wrong-bucket", "asset-1")] })],
    ["containing malformed resource metadata", fullPage({ entities: [validEntity("asset-zero-version", 0)] })],
    ["omitting a pagination flag", fullPage({ has_more_tasks: undefined })],
    ["declaring another page without a cursor", fullPage({ has_more_entities: true })],
    ["sending a cursor without another page", fullPage({ next_entity_cursor: "orphan" })]
  ])("rejects a malformed full-dataset envelope %s", async (_name, payload) => {
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: async () => Response.json(payload) });

    await expect(client.queries.full()).rejects.toThrow("Atlas response failed validation for GET /queries/full");
  });

  it.each<[string, unknown]>([
    ["missing its high-water version", changedPage({ version: undefined })],
    ["with a fractional high-water version", changedPage({ version: 4.5 })],
    ["whose high-water version precedes since_version", changedPage({ version: 3 })],
    ["containing a stale event version", changedPage({ events: [changedEntityEvent("asset-stale", 4)], version: 5 })],
    [
      "containing an event beyond its high-water version",
      changedPage({ events: [changedEntityEvent("asset-future", 6)], version: 5 })
    ],
    [
      "containing mismatched event resource metadata",
      changedPage({
        events: [{ ...changedEntityEvent("asset-mismatch", 5), resource: validEntity("other", 5) }],
        version: 5
      })
    ],
    [
      "containing events out of order",
      changedPage({ events: [changedEntityEvent("asset-6", 6), changedEntityEvent("asset-5", 5)], version: 6 })
    ],
    ["omitting its pagination flag", changedPage({ has_more: undefined })],
    ["declaring another page without a cursor", changedPage({ has_more: true })],
    ["declaring another page without making progress", changedPage({ has_more: true, next_cursor: "next" })],
    ["sending a cursor without another page", changedPage({ next_cursor: "orphan" })]
  ])("rejects a malformed changed-since envelope %s", async (_name, payload) => {
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: async () => Response.json(payload) });

    await expect(client.queries.changedSince(4)).rejects.toThrow(
      "Atlas response failed validation for GET /queries/changed-since?since_version=4"
    );
  });

  it("accepts a canonical delete event", async () => {
    const event = { event: "delete", resource_type: "entity", id: "entity-deleted", version: 5 };
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async () => Response.json(changedPage({ events: [event], version: 5 }))
    });

    await expect(client.queries.changedSince(4)).resolves.toMatchObject({ events: [event] });
  });

  it.each<[string, unknown]>([
    [
      "duplicate Command identifiers",
      [
        {
          command: "fixture.inspect",
          name: "Inspect",
          description: "Inspect the fixture.",
          input_schema: "atlas.tasking.EmptyObject"
        },
        {
          command: "fixture.inspect",
          name: "Inspect Again",
          description: "Inspect the fixture again.",
          input_schema: "atlas.tasking.EmptyObject"
        }
      ]
    ],
    [
      "unsupported scheduling",
      [
        {
          command: "fixture.inspect",
          name: "Inspect",
          description: "Inspect the fixture.",
          input_schema: "atlas.tasking.EmptyObject",
          scheduling: "periodic"
        }
      ]
    ]
  ])("rejects a command catalog with %s", async (_name, payload) => {
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: async () => Response.json(payload) });

    await expect(client.commandCatalog()).rejects.toThrow("Atlas response failed validation for GET /command-catalog");
  });

  it("rejects point responses for a different resource id without poisoning the cache", async () => {
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async () => Response.json(validEntity("asset-other", 1)),
      sync: "all",
      pollIntervalMs: 0
    });
    const snapshot = client.sync.snapshot();

    await expect(client.entities.get("asset-requested", { fresh: true })).rejects.toThrow(
      "Atlas entity response id asset-other does not match requested id asset-requested"
    );
    expect(client.sync.snapshot()).toBe(snapshot);
    expect(client.sync.status().lastVersion).toBe(0);
  });

  it("rejects Task lifecycle responses for a different Task id without poisoning the cache", async () => {
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async () =>
        Response.json(validTask("task-other", "asset-1"), {
          headers: { ETag: '"v1"' }
        })
    });
    const snapshot = client.sync.snapshot();

    await expect(client.tasks.start("task-requested", { runtimeId: "runtime-1" })).rejects.toThrow(
      "Atlas task response id task-other does not match requested id task-requested"
    );
    expect(client.sync.snapshot()).toBe(snapshot);
    expect(client.sync.status().lastVersion).toBe(0);
  });

  it("rejects runtime delivery for a different Asset", async () => {
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async () => Response.json({ tasks: [validTask("task-foreign", "asset-2")] })
    });

    await expect(client.runtime.tasks("asset-1", { runtimeId: "runtime-1" })).rejects.toThrow(
      "Atlas response failed validation for GET /entities/asset-1/runtime/tasks"
    );
  });

  it("keeps Task lifecycle responses isolated from watch callback mutation", async () => {
    const response = validTask("task-watched", "asset-1");
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async () => Response.json(response, { headers: { ETag: '"v1"' } })
    });
    const mutations: boolean[] = [];
    let watchedValue: unknown;
    let watchedEventResource: unknown;
    client.tasks.watch(response.task_id, (value, event) => {
      watchedValue = value;
      if (value) mutations.push(Reflect.set(value, "status", "failed"));
      if ("resource" in event) {
        watchedEventResource = event.resource;
        mutations.push(Reflect.set(event.resource, "status", "failed"));
      }
    });

    const returned = await client.tasks.start(response.task_id, { runtimeId: "runtime-1" });
    const cached = client.sync.snapshot().tasks[response.task_id];

    expect(mutations).toEqual([false, false]);
    expect(watchedValue).toBe(cached);
    expect(watchedEventResource).toBe(cached);
    expect(returned).not.toBe(cached);
    expect(returned.status).toBe(response.status);
  });

  it("requires a strong resource ETag on Task point responses", async () => {
    const response = validTask("task-without-etag", "asset-1");
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: async () => Response.json(response) });

    await expect(client.tasks.get(response.task_id, { fresh: true })).rejects.toThrow(
      "Atlas response did not include a valid resource ETag for GET /tasks/task-without-etag"
    );
    expect(client.sync.snapshot().tasks).toEqual({});
  });

  it("accepts the extra field on HTTP ObjectDetailResource values", async () => {
    const response = {
      ...validObject("object-http-extra", 1),
      extra: { label: "thermal", nested: { confidence: 0.91 }, values: [1, true, null] }
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: async () => Response.json(response) });

    await expect(client.objects.get(response.object_id, { fresh: true })).resolves.toEqual(response);
  });

  it("accepts a depth-3000 object detail extra value through normal response validation", async () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 3_000; depth++) nested = { nested };
    const response = { ...validObject("object-http-deep-extra", 1), extra: nested };
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(response) }) as Response
    });

    await expect(client.objects.get(response.object_id, { fresh: true })).resolves.toEqual(response);
  });

  it("rejects object detail sizes above JavaScript's safe integer limit", async () => {
    const response = { ...validObject("object-http-unsafe-size", 1), size_bytes: 9_007_199_254_740_992, extra: {} };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: async () => Response.json(response) });

    await expect(client.objects.get(response.object_id, { fresh: true })).rejects.toThrow("response failed validation");
  });

  it("rejects the old payload field on HTTP object detail values", async () => {
    const response = {
      ...validObject("object-http-payload", 1),
      payload: { label: "thermal" }
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: async () => Response.json(response) });

    await expect(client.objects.get(response.object_id, { fresh: true })).rejects.toThrow("response failed validation");
  });

  it("keeps hydration atomic when a later page is malformed", async () => {
    const core = new FakeCore();
    const existing = core.upsertEntity(entity("asset-hydration-baseline"));
    let malformedHydration = false;
    let page = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (!malformedHydration || new URL(String(url)).pathname !== "/queries/full")
        return core.fetch(String(url), init);
      page += 1;
      if (page === 1) {
        return Response.json(
          fullPage({
            entities: [validEntity("asset-uncommitted-page", existing.metadata.version + 1)],
            version: existing.metadata.version,
            has_more_entities: true,
            next_entity_cursor: "next"
          })
        );
      }
      return Response.json({ entities: [], objects: [] });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await client.sync.start();
    const snapshot = client.sync.snapshot();
    const cursor = client.sync.status().lastVersion;
    client.sync.stop();
    malformedHydration = true;

    await expect(client.sync.start()).rejects.toThrow(
      "Atlas response failed validation for GET /queries/full?entity_cursor=next"
    );
    expect(client.sync.snapshot()).toBe(snapshot);
    expect(client.sync.snapshot().entities).toEqual({ [existing.entity_id]: existing });
    expect(client.sync.snapshot().entities).not.toHaveProperty("asset-uncommitted-page");
    expect(client.sync.status()).toMatchObject({ running: false, lastVersion: cursor });
  });

  it("degrades a running sync without partial mutation and recovers from a later valid changed-since response", async () => {
    const core = new FakeCore();
    const existing = core.upsertEntity(entity("asset-recovery-baseline"));
    let malformedChangedSince = false;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (!malformedChangedSince || new URL(String(url)).pathname !== "/queries/changed-since")
        return core.fetch(String(url), init);
      return Response.json(
        changedPage({
          events: [
            changedEntityEvent("asset-uncommitted-recovery", existing.metadata.version + 1),
            { event: "delete", resource_type: "entity", id: "", version: existing.metadata.version + 2 }
          ],
          version: existing.metadata.version + 2
        })
      );
    };
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: fetchImpl,
      sync: "all",
      pollIntervalMs: 60_000
    });

    try {
      await client.sync.start();
      const recovered = core.upsertTask(task("task-valid-recovery", existing.entity_id));
      const snapshot = client.sync.snapshot();
      const cursor = client.sync.status().lastVersion;
      malformedChangedSince = true;

      await expect(client.changedSince()).rejects.toThrow("Atlas response failed validation");
      expect(client.sync.snapshot()).toBe(snapshot);
      expect(client.sync.snapshot().entities).not.toHaveProperty("asset-uncommitted-recovery");
      expect(client.sync.status()).toMatchObject({
        running: true,
        healthy: false,
        degraded: true,
        lastVersion: cursor
      });

      malformedChangedSince = false;
      await expect(client.changedSince()).resolves.toBeUndefined();
      expect(client.sync.snapshot().tasks[recovered.task_id]).toEqual(recovered);
      expect(client.sync.status()).toMatchObject({
        running: true,
        healthy: true,
        degraded: false,
        lastVersion: recovered.metadata.version
      });
    } finally {
      client.sync.stop();
    }
  });

  it("keeps an applied first page when a later changed-since watermark drifts", async () => {
    const core = new FakeCore();
    const existing = core.upsertEntity(entity("asset-watermark-baseline"));
    const firstPageVersion = existing.metadata.version + 1;
    let driftWatermark = false;
    let page = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (!driftWatermark || new URL(String(url)).pathname !== "/queries/changed-since")
        return core.fetch(String(url), init);
      page += 1;
      if (page === 1) {
        return Response.json(
          changedPage({
            events: [changedEntityEvent("asset-uncommitted-watermark", firstPageVersion)],
            has_more: true,
            next_cursor: "next",
            version: firstPageVersion
          })
        );
      }
      return Response.json(changedPage({ version: existing.metadata.version + 2 }));
    };
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: fetchImpl,
      sync: "all",
      pollIntervalMs: 60_000
    });

    try {
      await client.sync.start();
      const snapshot = client.sync.snapshot();
      driftWatermark = true;

      await expect(client.changedSince()).rejects.toThrow();
      expect(page).toBe(2);
      expect(client.sync.snapshot()).not.toBe(snapshot);
      expect(client.sync.snapshot().entities["asset-uncommitted-watermark"]?.metadata.version).toBe(firstPageVersion);
      expect(client.sync.status()).toMatchObject({
        running: true,
        healthy: false,
        degraded: true,
        lastVersion: firstPageVersion
      });
    } finally {
      client.sync.stop();
    }
  });

  it("validates the whole check-in envelope before mutating cache state", async () => {
    const core = new FakeCore();
    const existingEntity = core.upsertEntity(entity("asset-checkin-atomic"));
    const existingTask = core.upsertTask(task("task-checkin-atomic", existingEntity.entity_id));
    let malformedCheckIn = false;
    const contextuallyInvalidResponse = {
      entity: { ...existingEntity, entity_id: "asset-other", alias: "must not leak" }
    };
    expect(isEntityCheckInFullResponse(contextuallyInvalidResponse)).toBe(true);
    const fetchImpl: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (!malformedCheckIn || path !== `/entities/${existingEntity.entity_id}/checkin`)
        return core.fetch(String(url), init);
      return Response.json(contextuallyInvalidResponse);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await client.sync.start();
    const entityWatch = vi.fn();
    const taskWatch = vi.fn();
    client.entities.watch(existingEntity.entity_id, entityWatch);
    client.tasks.watch(existingTask.task_id, taskWatch);
    const snapshot = client.sync.snapshot();
    const cursor = client.sync.status().lastVersion;
    malformedCheckIn = true;

    await expect(client.entities.checkIn(existingEntity.entity_id)).rejects.toThrow("Atlas response failed validation");
    expect(client.sync.snapshot()).toBe(snapshot);
    expect(client.sync.snapshot().entities[existingEntity.entity_id]).toEqual(existingEntity);
    expect(client.sync.snapshot().tasks[existingTask.task_id]).toEqual(existingTask);
    expect(client.sync.status().lastVersion).toBe(cursor);
    expect(entityWatch).not.toHaveBeenCalled();
    expect(taskWatch).not.toHaveBeenCalled();
    client.sync.stop();
  });
});

describe("AtlasClient inbound feed validation", () => {
  it("rejects a malformed feed hello even when the protocol revision matches", async () => {
    const core = new FakeCore();
    class MalformedHelloWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url, core);
        queueMicrotask(() =>
          this.receive({ type: "hello", protocol_revision: ATLAS_PROTOCOL_REVISION, unexpected: true })
        );
      }
    }
    const manager = new FeedConnectionManager({
      baseUrl: "http://atlas.test",
      WebSocketImpl: MalformedHelloWebSocket,
      feedHandshakeTimeoutMs: 1_000
    });

    await expect(
      manager.connect({
        subscriptions: [{ filter: "all" }],
        onEvent: () => undefined,
        onEventError: () => undefined,
        onClose: () => undefined
      })
    ).rejects.toThrow("feed did not send a valid protocol hello");
    expect(core.sockets.size).toBe(0);
  });

  it("degrades after a replacement feed sends a malformed hello and bypasses covered cache reads", async () => {
    const core = new FakeCore();
    class MalformedReplacementWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url, core);
        if (core.feedConnections === 2) {
          queueMicrotask(() =>
            this.receive({ type: "hello", protocol_revision: ATLAS_PROTOCOL_REVISION, unexpected: true })
          );
        }
      }
    }
    const cached = core.upsertEntity(entity("asset-replacement-fallback"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: MalformedReplacementWebSocket,
      sync: "all",
      pollIntervalMs: 0
    });

    try {
      await client.sync.start();
      expect(client.sync.status()).toMatchObject({ running: true, healthy: true, degraded: false });
      const snapshot = client.sync.snapshot();
      expect(snapshot.entities[cached.entity_id]).toEqual(cached);
      expect(Object.isFrozen(snapshot.entities[cached.entity_id])).toBe(true);

      const fresh = core.upsertEntity({ ...cached, alias: "fresh from HTTP" });
      core.requests = [];

      await expect(client.connectFeed()).rejects.toThrow("feed did not send a valid protocol hello");
      expect(client.sync.status()).toMatchObject({ running: true, healthy: false, degraded: true });
      await expect(client.entities.get(cached.entity_id)).resolves.toEqual(fresh);
      expect(core.requests).toContain(`/entities/${cached.entity_id}`);
    } finally {
      client.sync.stop();
    }
  });

  it("recovers from a malformed feed frame through reconnect and changed-since without polling", async () => {
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
      const socket = [...core.sockets][0];
      if (!socket) throw new Error("expected a connected fake websocket");
      const watch = vi.fn();
      client.watch({ filter: "all" }, watch);
      const snapshot = client.sync.snapshot();
      const resource = validEntity("asset-invalid-feed", 1);
      const unsafeVersion = Number.MAX_SAFE_INTEGER + 1;
      socket.receive({
        event: "update",
        resource_type: "entity",
        id: resource.entity_id,
        version: unsafeVersion,
        resource: { ...resource, metadata: metadata(unsafeVersion) }
      });

      expect(client.sync.snapshot()).toBe(snapshot);
      expect(client.sync.status()).toMatchObject({ healthy: false, degraded: true, lastVersion: 0 });
      expect(watch).not.toHaveBeenCalled();

      const recovered = core.upsertEntity(entity("asset-recovered-after-malformed-feed"));
      await vi.waitFor(() => expect(core.feedConnections).toBe(2), { timeout: 2_000 });
      await vi.waitFor(() => expect(client.sync.snapshot().entities[recovered.entity_id]).toEqual(recovered));
      expect(watch).toHaveBeenCalledWith(
        recovered,
        expect.objectContaining({ id: recovered.entity_id, version: recovered.metadata.version })
      );
      expect(client.sync.status()).toMatchObject({
        healthy: true,
        degraded: false,
        lastVersion: recovered.metadata.version
      });
    } finally {
      client.sync.stop();
    }
  });
});
