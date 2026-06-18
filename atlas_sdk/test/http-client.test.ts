import { describe, expect, it, vi } from "vitest";
import { AtlasAPIError, AtlasClient, ConflictError, ProtocolMismatchError, isEntityCreateRequest, isTaskCreateRequest } from "../src";
import { entity, FakeCore, object } from "./support/fake-core.js";

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
    expect(() => new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, requestTimeoutMs: -1 })).toThrow("positive finite");
    expect(() => new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, requestTimeoutMs: Number.NaN })).toThrow("positive finite");
    expect(() => new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, requestTimeoutMs: Number.POSITIVE_INFINITY })).toThrow("positive finite");
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

  it("rejects malformed generated entity create validator geometry and timestamps", () => {
    expect(isEntityCreateRequest({ entity_id: "asset-valid", entity_type: "asset", published_at: "2026-06-18T12:00:00Z" })).toBe(true);
    expect(isEntityCreateRequest({ entity_id: "asset-date-only", entity_type: "asset", published_at: "2026-06-18" })).toBe(false);
    expect(isEntityCreateRequest({ entity_id: "asset-bad-date", entity_type: "asset", published_at: "2026-02-30T12:00:00Z" })).toBe(false);
    expect(
      isEntityCreateRequest({
        entity_id: "asset-bad-point",
        entity_type: "asset",
        components: { geometry: { type: "Point", coordinates: [999] } }
      })
    ).toBe(false);
    expect(
      isEntityCreateRequest({
        entity_id: "asset-good-point",
        entity_type: "asset",
        components: { geometry: { type: "Point", coordinates: [-97.7431, 30.2672] } }
      })
    ).toBe(true);
    expect(
      isEntityCreateRequest({
        entity_id: "asset-missing-lng",
        entity_type: "asset",
        components: { geometry: { point_lat: 30.2672 } }
      })
    ).toBe(false);
    expect(
      isEntityCreateRequest({
        entity_id: "asset-missing-radius-center",
        entity_type: "asset",
        components: { geometry: { radius_m: 500, point_lat: 30.2672 } }
      })
    ).toBe(false);
    expect(
      isEntityCreateRequest({
        entity_id: "asset-radius",
        entity_type: "asset",
        components: { geometry: { radius_m: 500, point_lat: 30.2672, point_lng: -97.7431 } }
      })
    ).toBe(true);
  });

  it("enforces fake Core route verbs while preserving default GET semantics", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-method"));

    const revision = await core.fetch("http://atlas.test/protocol/revision");
    expect(revision.status).toBe(200);
    await expect(revision.json()).resolves.toMatchObject({ protocol_revision: core.revision });

    const entityResponse = await core.fetch("http://atlas.test/entities/asset-method");
    expect(entityResponse.status).toBe(200);
    await expect(entityResponse.json()).resolves.toMatchObject({ entity_id: "asset-method" });

    await expect(core.fetch("http://atlas.test/protocol/revision", { method: "POST" }).then((response) => response.status)).resolves.toBe(404);
    await expect(core.fetch("http://atlas.test/entities/asset-method", { method: "POST" }).then((response) => response.status)).resolves.toBe(404);
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
    const entityConflict = await client.entities.create({ entity_id: "asset-conflict", entity_type: "asset" }).catch((error) => error);
    expect(entityConflict).toBeInstanceOf(ConflictError);
    expect(entityConflict).toMatchObject({
      status: 409,
      errorCode: "ENTITY_ALREADY_EXISTS"
    });

    await client.tasks.create({ task_id: "task-conflict" });
    const taskConflict = await client.tasks.create({ task_id: "task-conflict" }).catch((error) => error);
    expect(taskConflict).toBeInstanceOf(ConflictError);
    expect(taskConflict).toMatchObject({
      status: 409,
      errorCode: "TASK_ALREADY_EXISTS"
    });

    await client.objects.create({ object_id: "object-conflict" });
    const objectConflict = await client.objects.create({ object_id: "object-conflict" }).catch((error) => error);
    expect(objectConflict).toBeInstanceOf(ConflictError);
    expect(objectConflict).toMatchObject({
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

  it("returns protocol errors for invalid fake Core pagination cursors", async () => {
    const core = new FakeCore();
    core.fullLimitPerType = 1;
    core.changedSinceLimitPerType = 1;

    const fullResponse = await core.fetch("http://atlas.test/queries/full?entity_cursor=abc");
    await expect(fullResponse.json()).resolves.toMatchObject({
      success: false,
      error_code: "VALIDATION_ERROR"
    });
    expect(fullResponse.status).toBe(400);

    const changedSinceResponse = await core.fetch("http://atlas.test/queries/changed-since?since_version=0&task_cursor=-1");
    await expect(changedSinceResponse.json()).resolves.toMatchObject({
      success: false,
      error_code: "VALIDATION_ERROR"
    });
    expect(changedSinceResponse.status).toBe(400);
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
