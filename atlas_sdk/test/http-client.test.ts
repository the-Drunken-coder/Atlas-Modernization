import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AtlasAPIError,
  AtlasClient,
  AtlasTransportError,
  ConflictError,
  isAtlasAPIError,
  isAtlasTransportError,
  isEntityCreateRequest,
  isEntityUpdateRequest,
  isJSONValue,
  isObjectCreateRequest,
  isObjectUpdateRequest,
  isRuntimeStopRequest,
  isTaskCreateRequest,
  ProtocolMismatchError
} from "../src";
import { AtlasAdminClient } from "../src/admin.js";
import { entity, FakeCore, object, task } from "./support/fake-core.js";

afterEach(() => vi.unstubAllGlobals());

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
      value.asset_id = "asset-cross-realm";
      value.command = "fixture.queued";
      value.input = {};
      return value;
    } finally {
      iframe.remove();
    }
  }

  const { runInNewContext } = await import(/* @vite-ignore */ "node:vm");
  return runInNewContext("({ asset_id: 'asset-cross-realm', command: 'fixture.queued', input: {} })") as Record<
    string,
    unknown
  >;
}

describe("AtlasClient HTTP", () => {
  it("rejects invalid changed-since cursors before serialization", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });

    for (const sinceVersion of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(client.queries.changedSince(sinceVersion)).rejects.toThrow(
        "sinceVersion must be a non-negative safe integer"
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sanitizes untrusted HTTP errors while preserving status and error code", async () => {
    const secret = "http-canary-secret";
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async () =>
        Response.json(
          {
            success: false,
            error_code: "CORE_UNAVAILABLE",
            message: `failed https://user:${secret}@core.test?api_key=${secret} Bearer ${secret} Basic ${secret} \u001b[31m`,
            details: { api_key: secret }
          },
          { status: 503 }
        )
    });

    const failure = await client.queries.full().catch((error: unknown) => error);

    expect(failure).toMatchObject({ status: 503, errorCode: "CORE_UNAVAILABLE" });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect((failure as Error).message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
  it("binds the default global fetch for browser callers", async () => {
    const receivers: unknown[] = [];
    const fetchImpl: typeof fetch = async function (this: unknown, url) {
      receivers.push(this);
      const body = String(url).includes("/admin/")
        ? { user: { username: "admin" } }
        : {
            entities: [],
            tasks: [],
            objects: [],
            version: 0,
            has_more_entities: false,
            has_more_tasks: false,
            has_more_objects: false
          };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    } as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const client = new AtlasClient({ baseUrl: "http://atlas.test" });
    const admin = new AtlasAdminClient({ baseUrl: "http://atlas.test" });

    await client.queries.full();
    await admin.auth.me();

    expect(receivers).toEqual([globalThis, globalThis]);
  });

  it("fails loudly on protocol revision mismatch", async () => {
    const core = new FakeCore();
    core.revision = `sha256:${"0".repeat(64)}`;
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

  it("labels fetch failures as transport errors", async () => {
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async () => Promise.reject(new Error("network unavailable"))
    });

    const failure = await client.handshake().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "AtlasTransportError",
      message: "network unavailable",
      code: "ATLAS_TRANSPORT_ERROR"
    });
    expect(failure).toBeInstanceOf(AtlasTransportError);
    expect(isAtlasTransportError(failure)).toBe(true);
  });

  it("sanitizes transport errors constructed by consumers", () => {
    const secret = "transport-canary-secret";
    const failure = new AtlasTransportError(`failed https://user:${secret}@core.test?api_key=${secret}`);

    expect(failure.message).not.toContain(secret);
    expect(isAtlasTransportError(failure)).toBe(true);
  });

  it("preserves caller abort reasons for handshake, check-in, and fresh reads", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });
    const handshakeController = new AbortController();
    const checkInController = new AbortController();
    const taskReadController = new AbortController();
    const handshakeReason = new Error("handshake caller aborted");
    const checkInReason = new Error("check-in caller aborted");
    const taskReadReason = new Error("task read caller aborted");

    const handshake = client.handshake({ signal: handshakeController.signal });
    const checkIn = client.entities.checkIn("asset-1", { signal: checkInController.signal });
    const taskRead = client.tasks.get("task-1", { fresh: true, signal: taskReadController.signal });
    handshakeController.abort(handshakeReason);
    checkInController.abort(checkInReason);
    taskReadController.abort(taskReadReason);

    await expect(handshake).rejects.toBe(handshakeReason);
    await expect(checkIn).rejects.toBe(checkInReason);
    await expect(taskRead).rejects.toBe(taskReadReason);
  });

  it("labels successful response body failures as transport errors", async () => {
    const response = Response.json({ protocol_revision: "unused" });
    vi.spyOn(response, "json").mockRejectedValueOnce(new TypeError("response body terminated"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: async () => response });

    await expect(client.handshake()).rejects.toMatchObject({
      name: "AtlasTransportError",
      message: "response body terminated",
      code: "ATLAS_TRANSPORT_ERROR"
    });
  });

  it("preserves caller abort reasons while reading an HTTP error body", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted error response read");
    const response = Response.json({ message: "unavailable" }, { status: 503 });
    vi.spyOn(response, "json").mockImplementationOnce(async () => {
      controller.abort(reason);
      throw new TypeError("response body terminated");
    });
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: async () => response });

    await expect(client.handshake({ signal: controller.signal })).rejects.toBe(reason);
  });

  it("rejects request timeouts outside the supported timer range", () => {
    const core = new FakeCore();

    expect(() => new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, requestTimeoutMs: 0 })).toThrow(
      "positive finite"
    );
    expect(() => new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, requestTimeoutMs: -1 })).toThrow(
      "positive finite"
    );
    expect(
      () => new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, requestTimeoutMs: Number.NaN })
    ).toThrow("positive finite");
    expect(
      () =>
        new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, requestTimeoutMs: Number.POSITIVE_INFINITY })
    ).toThrow("positive finite");
    expect(
      () => new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, requestTimeoutMs: 2_147_483_648 })
    ).toThrow("no greater than 2147483647");
    expect(
      () => new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, requestTimeoutMs: 2_147_483_647 })
    ).not.toThrow();
  });

  it("passes browser credentials through resource requests without adding admin methods", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        entities: [],
        tasks: [],
        objects: [],
        version: 0,
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, credentials: "include" });

    await client.queries.full();

    expect(calls[0]).toMatchObject({ url: "http://atlas.test/queries/full", init: { credentials: "include" } });
    expect("auth" in client).toBe(false);
  });

  it("sends configured API keys on resource HTTP requests", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", apiKey: "resource-key", fetch: core.fetch });

    await client.queries.full();
    await client.entities.create({ entity_id: "asset-api-key", entity_type: "asset" });

    expect(core.requestHeaders.find((request) => request.path === "/queries/full")?.apiKey).toBe("resource-key");
    expect(core.requestHeaders.find((request) => request.path === "/entities")?.apiKey).toBe("resource-key");
  });

  it("keeps admin auth on AtlasAdminClient", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ user: { username: "admin" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const admin = new AtlasAdminClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, credentials: "include" });

    await admin.auth.login({ username: "admin", password: "password" });

    expect(calls[0]).toMatchObject({
      url: "http://atlas.test/admin/auth/login",
      init: { method: "POST", credentials: "include" }
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ username: "admin", password: "password" });
  });

  it("accepts plain records and rejects non-plain records in task create requests", async () => {
    const nullPrototypeRequest = Object.assign(Object.create(null) as Record<string, unknown>, {
      asset_id: "asset-null-proto",
      command: "fixture.queued",
      input: {}
    });
    const crossRealmRequest = await crossRealmTaskCreateRequest();

    expect(isTaskCreateRequest({ asset_id: "asset-plain", command: "fixture.queued", input: {} })).toBe(true);
    expect(isTaskCreateRequest(nullPrototypeRequest)).toBe(true);
    expect(isTaskCreateRequest(crossRealmRequest)).toBe(true);
    expect(isTaskCreateRequest({ asset_id: "asset-date", command: "fixture.queued", input: new Date() })).toBe(false);
    expect(
      isTaskCreateRequest({ asset_id: "asset-map", command: "fixture.queued", input: new Map([["priority", "high"]]) })
    ).toBe(false);
  });

  it("rejects proxies with non-terminating prototype chains", () => {
    let cyclicPrototype!: object;
    cyclicPrototype = new Proxy({}, { getPrototypeOf: () => cyclicPrototype });
    const createPrototype = (): object => new Proxy({}, { getPrototypeOf: createPrototype });

    expect(isJSONValue(cyclicPrototype)).toBe(false);
    expect(isJSONValue(createPrototype())).toBe(false);
  });

  it("rejects sparse JSON arrays", () => {
    expect(isJSONValue(Array(1))).toBe(false);
    expect(isJSONValue(Array(100_000_000))).toBe(false);
  });

  it("accepts dense JSON arrays within the Entity request limit", () => {
    const values = new Array<number>(300_000).fill(0);

    expect(isJSONValue(values)).toBe(true);
    expect(
      isEntityCreateRequest({
        components: { custom_dense: values },
        entity_id: "dense-array",
        entity_type: "asset"
      })
    ).toBe(true);
  });

  it("rejects named properties on JSON arrays", () => {
    const value: unknown[] & { metadata?: unknown } = [];
    value.metadata = undefined;
    const prototype = Object.create(Array.prototype) as unknown[];
    Object.defineProperty(prototype, "metadata", { enumerable: true, value: 1n });
    const inherited = Object.setPrototypeOf([], prototype);

    expect(isJSONValue(value)).toBe(false);
    expect(isJSONValue(inherited)).toBe(false);
  });

  it("accepts nested Array subclasses and rejects negative zero", () => {
    class IntermediateArray extends Array<unknown> {}
    class HandlerArray extends IntermediateArray {}
    const value = new HandlerArray();
    value.push(1);
    const coercibleLength = new Proxy([], {
      get(target, key, receiver) {
        return key === "length" ? "0" : Reflect.get(target, key, receiver);
      }
    });
    const bigintLength = new Proxy([1], {
      get(target, key, receiver) {
        return key === "length" ? 1n : Reflect.get(target, key, receiver);
      }
    });

    expect(isJSONValue(value)).toBe(true);
    expect(isJSONValue(coercibleLength)).toBe(true);
    expect(isJSONValue(bigintLength)).toBe(false);
    expect(isJSONValue(0)).toBe(true);
    expect(isJSONValue(-0)).toBe(true);
  });

  it("rejects hidden properties on JSON records", () => {
    const value = Object.defineProperty({}, "secret", { value: 1n });
    const inherited = Object.create(Object.assign(Object.create(null) as Record<string, unknown>, { secret: 1n }));

    expect(isJSONValue(value)).toBe(false);
    expect(isJSONValue(inherited)).toBe(false);
  });

  it("rejects inherited and proxy-supplied JSON transforms", () => {
    const prototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(prototype, "toJSON", { value: () => ({ changed: true }) });
    const inherited = Object.assign(Object.create(prototype) as Record<string, unknown>, { value: 1 });
    const proxied = new Proxy(
      { value: 1 },
      {
        get(target, key, receiver) {
          return key === "toJSON" ? () => ({ changed: true }) : Reflect.get(target, key, receiver);
        }
      }
    );

    expect(isJSONValue(inherited)).toBe(false);
    expect(isJSONValue(proxied)).toBe(false);
  });

  it("rejects malformed generated entity create validator geometry and timestamps", () => {
    expect(
      isEntityCreateRequest({ entity_id: "asset-valid", entity_type: "asset", published_at: "2026-06-18T12:00:00Z" })
    ).toBe(true);
    expect(
      isEntityCreateRequest({ entity_id: "asset-date-only", entity_type: "asset", published_at: "2026-06-18" })
    ).toBe(false);
    expect(
      isEntityCreateRequest({ entity_id: "asset-bad-date", entity_type: "asset", published_at: "2026-02-30T12:00:00Z" })
    ).toBe(false);
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
        entity_id: "asset-point-radius",
        entity_type: "asset",
        components: { geometry: { type: "Point", coordinates: [-97.7431, 30.2672], radius_m: 500 } }
      })
    ).toBe(false);
    expect(
      isEntityCreateRequest({
        entity_id: "asset-circle",
        entity_type: "asset",
        components: {
          geometry: {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-97.7431, 30.2672] },
            properties: { shape: "circle", radius_m: 500 }
          }
        }
      })
    ).toBe(true);
    expect(
      isEntityCreateRequest({
        entity_id: "asset-circle-missing-shape",
        entity_type: "asset",
        components: {
          geometry: {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-97.7431, 30.2672] },
            properties: { radius_m: 500 }
          }
        }
      })
    ).toBe(false);
    expect(
      isEntityCreateRequest({
        entity_id: "asset-circle-missing-radius",
        entity_type: "asset",
        components: {
          geometry: {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-97.7431, 30.2672] },
            properties: { shape: "circle" }
          }
        }
      })
    ).toBe(false);
  });

  it("validates every generated request validator at runtime", () => {
    expect(isEntityCreateRequest({ entity_id: "asset-valid", entity_type: "asset", alias: null })).toBe(true);
    expect(isEntityCreateRequest({ entity_id: "", entity_type: "asset" })).toBe(false);
    expect(isEntityUpdateRequest({ alias: null })).toBe(true);
    expect(isEntityUpdateRequest({})).toBe(false);

    expect(
      isTaskCreateRequest({
        asset_id: "asset-valid",
        command: "fixture.queued",
        input: { latitude: 38, longitude: -77 }
      })
    ).toBe(true);
    expect(
      isTaskCreateRequest({
        asset_id: "asset-command",
        command: "fixture.queued",
        input: null
      })
    ).toBe(true);
    expect(isTaskCreateRequest({ asset_id: "", command: "fixture.queued", input: {} })).toBe(false);
    expect(isTaskCreateRequest({ asset_id: "asset-command", input: {} })).toBe(false);
    expect(isRuntimeStopRequest({ runtime_id: "runtime-1" })).toBe(true);
    expect(isRuntimeStopRequest({ runtime_id: "" })).toBe(false);

    expect(isObjectCreateRequest({ object_id: "object-valid", referenced_by: [{ entity_id: "asset-valid" }] })).toBe(
      true
    );
    expect(isObjectCreateRequest({ object_id: "object-invalid", referenced_by: [{}] })).toBe(false);
    expect(isObjectUpdateRequest({ usage_hints: ["thumbnail"] })).toBe(true);
    expect(isObjectUpdateRequest({})).toBe(false);
  });

  it("counts Unicode code points at generated string-length boundaries", () => {
    expect(isEntityCreateRequest({ entity_id: "x", entity_type: "🙂".repeat(50) })).toBe(true);
    expect(isEntityCreateRequest({ entity_id: "x", entity_type: "🙂".repeat(51) })).toBe(false);
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

    await expect(
      core.fetch("http://atlas.test/protocol/revision", { method: "POST" }).then((response) => response.status)
    ).resolves.toBe(404);
    await expect(
      core.fetch("http://atlas.test/entities/asset-method", { method: "POST" }).then((response) => response.status)
    ).resolves.toBe(404);
  });

  it("applies writes to cache and rejects stale nonzero preconditions across mutable routes", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const created = await client.entities.create({ entity_id: "asset-1", entity_type: "asset" });
    await expect(client.entities.get("asset-1")).resolves.toEqual(created);
    const currentEntity = core.upsertEntity(created);
    const currentObject = core.upsertObject(object("object-precondition"));

    const staleWrites = [
      () =>
        client.entities.update(
          currentEntity.entity_id,
          { alias: "new" },
          { ifMatchVersion: currentEntity.metadata.version - 1 }
        ),
      () =>
        client.entities.checkIn(currentEntity.entity_id, {
          status: "active",
          ifMatchVersion: currentEntity.metadata.version - 1
        }),
      () =>
        client.objects.update(
          currentObject.object_id,
          { type: "log" },
          { ifMatchVersion: currentObject.metadata.version - 1 }
        )
    ];

    for (const write of staleWrites) {
      const conflict = await write().catch((error) => error);
      expect(conflict).toBeInstanceOf(ConflictError);
      expect(conflict).toMatchObject({ status: 412, errorCode: "PRECONDITION_FAILED" });
    }
    expect(core.entities.get(currentEntity.entity_id)).toEqual(currentEntity);
    expect(core.objects.get(currentObject.object_id)).toEqual(currentObject);
  });

  it("accepts wildcard preconditions across mutable fake Core routes", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-wildcard"));
    core.upsertObject(object("object-wildcard"));

    const wildcardWrites = [
      ["PATCH", "/entities/asset-wildcard", { alias: "updated" }],
      ["POST", "/entities/asset-wildcard/checkin", {}],
      ["PATCH", "/objects/object-wildcard", { type: "log" }]
    ] as const;

    for (const [method, path, body] of wildcardWrites) {
      const response = await core.fetch(`http://atlas.test${path}`, {
        method,
        headers: { "Content-Type": "application/json", "If-Match": "*" },
        body: JSON.stringify(body)
      });
      expect(response.status, `${method} ${path}`).toBe(200);
    }
  });

  it("rejects malformed fake Core resource paths without throwing or mutating resources", async () => {
    const core = new FakeCore();
    const originalEntity = core.upsertEntity(entity("route-entity"));
    const originalTask = core.upsertTask(task("route-task", originalEntity.entity_id));
    const originalObject = core.upsertObject(object("route-object"));

    const malformedRoutes = [
      ["PATCH", "/entities/route-entity/extra", { alias: "changed" }],
      ["POST", "/entities/route-entity/checkin/extra", {}],
      ["PATCH", "/tasks/route-task/extra", { status: "acknowledged" }],
      ["POST", "/tasks/route-task/extra/more", {}],
      ["PATCH", "/objects/route-object/extra", { type: "log" }],
      ["GET", "/objects/route-object/extra/download", undefined]
    ] as const;

    for (const [method, path, body] of malformedRoutes) {
      const response = await core.fetch(`http://atlas.test${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(core.entities.get(originalEntity.entity_id)).toEqual(originalEntity);
    expect(core.tasks.get(originalTask.task_id)).toEqual(originalTask);
    expect(core.objects.get(originalObject.object_id)).toEqual(originalObject);
  });

  it("returns a controlled error for malformed fake Core path escapes", async () => {
    const core = new FakeCore();
    const invalidEscape = await core.fetch("http://atlas.test/entities/%zz");
    expect(invalidEscape.status).toBe(400);
    await expect(invalidEscape.json()).resolves.toMatchObject({ error_code: "VALIDATION_ERROR" });
  });

  it("keeps fresh read and write return mutation from changing cached resources", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();

    const created = await client.entities.create({
      entity_id: "asset-owned-write",
      entity_type: "asset",
      alias: "server value",
      components: { health: { battery_percent: 72 } }
    });
    Reflect.set(created, "alias", "write return mutation");
    if (created.components.health) Reflect.set(created.components.health, "battery_percent", 0);

    expect(client.sync.snapshot().entities[created.entity_id]).toMatchObject({
      alias: "server value",
      components: { health: { battery_percent: 72 } }
    });
    await expect(client.entities.get(created.entity_id)).resolves.toMatchObject({
      alias: "server value",
      components: { health: { battery_percent: 72 } }
    });

    const latest = core.upsertEntity({
      ...entity(created.entity_id),
      alias: "fresh server value",
      components: { health: { battery_percent: 73 } }
    });
    const fresh = await client.entities.get(created.entity_id, { fresh: true });
    expect(fresh).toEqual(latest);
    Reflect.set(fresh, "alias", "fresh read mutation");
    if (fresh.components.health) Reflect.set(fresh.components.health, "battery_percent", 1);

    expect(client.sync.snapshot().entities[created.entity_id]).toMatchObject({
      alias: "fresh server value",
      components: { health: { battery_percent: 73 } }
    });
    await expect(client.entities.get(created.entity_id)).resolves.toMatchObject({
      alias: "fresh server value",
      components: { health: { battery_percent: 73 } }
    });
  });

  it("uses explicit Task lifecycle routes with runtime fencing headers", async () => {
    const core = new FakeCore();
    core.upsertTask(task("task-ack", "asset-1"));
    core.upsertTask(task("task-start", "asset-1"));
    core.upsertTask({ ...task("task-progress", "asset-1"), status: "in_progress" });
    core.upsertTask(task("task-complete", "asset-1"));
    core.upsertTask(task("task-fail", "asset-1"));
    core.upsertTask(task("task-cancel", "asset-1"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const watch = vi.fn();
    client.tasks.watch("task-ack", watch);

    const runtime = { runtimeId: "runtime-1" };
    const acknowledged = await client.tasks.acknowledge("task-ack", runtime);
    const started = await client.tasks.start("task-start", runtime);
    const progressed = await client.tasks.progress("task-progress", { progress: 0.625 }, runtime);
    const completed = await client.tasks.complete("task-complete", { ...runtime, output: { ok: true } });
    const failed = await client.tasks.fail("task-fail", {
      ...runtime,
      failure: { code: "execution_failed", message: "boom" }
    });
    const cancelled = await client.tasks.cancel("task-cancel", {
      cancellation: { code: "requested", message: "Operator cancelled" }
    });

    expect(acknowledged.status).toBe("acknowledged");
    expect(started.status).toBe("in_progress");
    expect(progressed.progress).toBe(0.625);
    expect(completed).toMatchObject({ status: "completed", output: { ok: true } });
    expect(failed).toMatchObject({ status: "failed", failure: { code: "execution_failed", message: "boom" } });
    expect(cancelled.status).toBe("cancelled");
    await expect(client.tasks.get("task-ack")).resolves.toEqual(acknowledged);
    expect(core.requestHeaders.find((request) => request.path === "/tasks/task-ack/acknowledge")?.runtimeId).toBe(
      "runtime-1"
    );
    expect(core.requestHeaders.find((request) => request.path === "/tasks/task-cancel/cancel")?.runtimeId).toBeNull();
    expect(watch).toHaveBeenCalledWith(
      expect.objectContaining({ status: "acknowledged" }),
      expect.objectContaining({ event: "update", id: "task-ack" })
    );
    await expect(client.tasks.acknowledge("missing-task", runtime)).rejects.toBeInstanceOf(AtlasAPIError);
  });

  it("serializes Task completion without inherited toJSON hooks", async () => {
    const core = new FakeCore();
    core.upsertTask(task("task-inert-completion", "asset-1"));
    const originalToJSON = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const restoreToJSON = () => {
      if (originalToJSON === undefined) Reflect.deleteProperty(Object.prototype, "toJSON");
      else Object.defineProperty(Object.prototype, "toJSON", originalToJSON);
    };
    let requestBody: BodyInit | null | undefined;
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async (url, init) => {
        requestBody = init?.body;
        restoreToJSON();
        return core.fetch(String(url), init);
      }
    });
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value: () => null
    });

    try {
      await client.tasks.complete("task-inert-completion", {
        runtimeId: "runtime-1",
        output: Object.setPrototypeOf([1], null)
      });
    } finally {
      restoreToJSON();
    }

    expect(requestBody).toBe('{"output":[1]}');
  });

  it("serializes Task failure without inherited toJSON hooks", async () => {
    const core = new FakeCore();
    core.upsertTask(task("task-inert-failure", "asset-1"));
    const originalToJSON = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const restoreToJSON = () => {
      if (originalToJSON === undefined) Reflect.deleteProperty(Object.prototype, "toJSON");
      else Object.defineProperty(Object.prototype, "toJSON", originalToJSON);
    };
    let requestBody: BodyInit | null | undefined;
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async (url, init) => {
        requestBody = init?.body;
        restoreToJSON();
        return core.fetch(String(url), init);
      }
    });
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: () => null });

    try {
      await client.tasks.fail("task-inert-failure", {
        runtimeId: "runtime-1",
        failure: { code: "execution_failed", message: "invalid output" }
      });
    } finally {
      restoreToJSON();
    }

    expect(requestBody).toBe('{"failure":{"code":"execution_failed","message":"invalid output"}}');
  });

  it("canonicalizes tasking identifiers before body and header use", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    await client.runtime.begin("asset-1", { runtime_id: " runtime-1 " });
    await client.runtime.ready("asset-1", { runtime_id: " runtime-1 ", manifest: [] });
    await client.runtime.tasks("asset-1", { runtimeId: " runtime-1 " });
    await client.runtime.stop("asset-1", { runtime_id: " runtime-1 " });
    await client.tasks.create(
      { asset_id: "asset-1", command: "fixture.queued", input: {} },
      { idempotencyKey: " attempt-1 " }
    );

    expect(core.runtimes.get("asset-1")).toEqual({ runtimeId: "runtime-1", ready: false });
    expect(core.requestHeaders.find((request) => request.path.endsWith("/runtime/tasks"))?.runtimeId).toBe("runtime-1");
    expect(core.requestHeaders.some((request) => request.path.endsWith("/runtime/stop"))).toBe(true);
    expect(core.requestHeaders.find((request) => request.path === "/tasks")?.idempotencyKey).toBe("attempt-1");
  });

  it("checks in telemetry without polling Tasks", async () => {
    const core = new FakeCore();
    const baseEntity = core.upsertEntity(entity("asset-checkin"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const entityWatch = vi.fn();
    client.entities.watch("asset-checkin", entityWatch);

    const response = await client.entities.checkIn("asset-checkin", {
      status: "active",
      telemetry: { latitude: 40.1, longitude: -74.2, altitude_m: 120 },
      components: { communications: { link_state: "connected" } },
      ifMatchVersion: baseEntity.metadata.version
    });

    expect(response).toMatchObject({
      entity: {
        components: {
          communications: { link_state: "connected" },
          status: { value: "active" },
          telemetry: { latitude: 40.1, longitude: -74.2, altitude_m: 120 },
          heartbeat: expect.objectContaining({ last_seen: expect.any(String) })
        }
      }
    });
    await expect(client.entities.get("asset-checkin")).resolves.toEqual(response.entity);
    expect(core.requests).toContain("/entities/asset-checkin/checkin");
    expect(core.requestHeaders.find((request) => request.path === "/entities/asset-checkin/checkin")?.ifMatch).toBe(
      `"v${baseEntity.metadata.version}"`
    );
    expect(entityWatch).toHaveBeenCalledWith(
      expect.objectContaining({ entity_id: "asset-checkin" }),
      expect.objectContaining({ event: "update" })
    );
  });

  it("supports a check-in with no reported status, telemetry, or components", async () => {
    const core = new FakeCore();
    const checkedIn = core.upsertEntity(entity("asset-empty-checkin"));
    let requestBody: unknown;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname.endsWith("/checkin")) {
        requestBody = JSON.parse(String(init?.body));
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });

    const response = await client.entities.checkIn(checkedIn.entity_id);

    expect(requestBody).toEqual({});
    expect(response).toMatchObject({ entity: { entity_id: checkedIn.entity_id } });
  });

  it("surfaces Core-style check-in validation errors from the fake transport", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-invalid-checkin"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    await expect(client.entities.checkIn("asset-invalid-checkin", { status: "" } as never)).rejects.toMatchObject({
      status: 400,
      errorCode: "VALIDATION_ERROR"
    });
    const malformed = await core.fetch("http://atlas.test/entities/asset-invalid-checkin/checkin", {
      method: "POST",
      body: "{"
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      success: false,
      error_code: "INVALID_JSON"
    });
  });

  it("exposes one-page query helpers without mutating sync state", async () => {
    const core = new FakeCore();
    core.fullLimitPerType = 1;
    core.changedSinceLimit = 1;
    core.upsertEntity(entity("asset-query"));
    core.upsertTask(task("task-query", "asset-query"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    const full = await client.queries.full({ entityLimit: 1, taskLimit: 1, objectLimit: 1, entityCursor: "1" });
    const firstChanged = await client.queries.changedSince(0, { limit: 1 });
    const changed = await client.queries.changedSince(0, { limit: 1, cursor: firstChanged.next_cursor });

    expect(full.entities).toEqual([]);
    expect(full.version).toBe(core.version);
    expect(firstChanged.events).toHaveLength(1);
    expect(changed.events).toHaveLength(1);
    expect(core.requests).toContain("/queries/full?entity_limit=1&task_limit=1&object_limit=1&entity_cursor=1");
    expect(core.requests).toContain("/queries/changed-since?since_version=0&limit=1");
    expect(core.requests).toContain(
      `/queries/changed-since?since_version=0&limit=1&cursor=${encodeURIComponent(firstChanged.next_cursor ?? "")}`
    );
    expect(client.sync.status().lastVersion).toBe(0);
  });

  it("loads the typed command catalog directly from Core", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    await expect(client.commandCatalog()).resolves.toEqual(core.commandCatalog);
    expect(core.requests).toContain("/command-catalog");
  });

  it("matches Core duplicate-create conflicts in the fake transport", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    await client.entities.create({ entity_id: "asset-conflict", entity_type: "asset" });
    const entityConflict = await client.entities
      .create({ entity_id: "asset-conflict", entity_type: "asset" })
      .catch((error) => error);
    expect(entityConflict).toBeInstanceOf(ConflictError);
    expect(entityConflict).toMatchObject({
      status: 409,
      errorCode: "ENTITY_ALREADY_EXISTS"
    });

    const request = { asset_id: "asset-conflict", command: "fixture.queued", input: {} };
    const firstTask = await client.tasks.create(request, { idempotencyKey: "task-conflict" });
    const repeatedTask = await client.tasks.create(request, { idempotencyKey: "task-conflict" });
    expect(repeatedTask.task_id).toBe(firstTask.task_id);
    const taskConflict = await client.tasks
      .create({ ...request, input: { changed: true } }, { idempotencyKey: "task-conflict" })
      .catch((error) => error);
    expect(taskConflict).toBeInstanceOf(ConflictError);
    expect(taskConflict).toMatchObject({ status: 409, errorCode: "TASK_ALREADY_EXISTS" });

    await client.objects.create({ object_id: "object-conflict" });
    const objectConflict = await client.objects.create({ object_id: "object-conflict" }).catch((error) => error);
    expect(objectConflict).toBeInstanceOf(ConflictError);
    expect(objectConflict).toMatchObject({
      status: 409,
      errorCode: "OBJECT_ALREADY_EXISTS"
    });
  });

  it("does not repeat watch events for idempotent Task create retries", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "task" }, watch);
    const request = { asset_id: "asset-idempotent", command: "fixture.queued", input: {} };

    const first = await client.tasks.create(request, { idempotencyKey: "task-idempotent" });
    const repeated = await client.tasks.create(request, { idempotencyKey: "task-idempotent" });

    expect(repeated).toEqual(first);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledWith(
      client.sync.snapshot().tasks[first.task_id],
      expect.objectContaining({ event: "create", id: first.task_id })
    );
  });

  it("assigns distinct UUID task IDs to repeated command requests", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });
    const command = { asset_id: "asset-command", command: "fixture.queued", input: { latitude: 38, longitude: -77 } };

    const first = await client.tasks.create(command, { idempotencyKey: "attempt-1" });
    const second = await client.tasks.create(command, { idempotencyKey: "attempt-2" });

    expect(first.task_id).toMatch(/^task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second.task_id).toMatch(/^task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second.task_id).not.toBe(first.task_id);
    expect([...core.tasks.keys()]).toEqual([first.task_id, second.task_id]);
  });

  it("rejects response-shaped write payloads with protocol error details", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    await expect(client.entities.create(entity("asset-with-metadata") as never)).rejects.toMatchObject({
      status: 400,
      errorCode: "INVALID_JSON"
    });
    await expect(
      client.objects.create({ ...object("object-with-bucket"), bucket: "client-owned" } as never)
    ).rejects.toMatchObject({
      status: 400,
      errorCode: "INVALID_JSON"
    });
  });

  it("round-trips object extra on detail and write responses", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    const created = await client.objects.create({
      object_id: "object-with-extra",
      type: "image",
      extra: { label: "thermal", nested: { confidence: 0.91 } }
    });
    expect(created.extra).toEqual({ label: "thermal", nested: { confidence: 0.91 } });

    const fetched = await client.objects.get("object-with-extra", { fresh: true });
    expect(fetched.extra).toEqual(created.extra);

    const updated = await client.objects.update("object-with-extra", {
      extra: { reviewed: true, label: "visual" }
    });
    expect(updated.extra).toEqual({ label: "visual", nested: { confidence: 0.91 }, reviewed: true });
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

    const created = await client.objects.create({
      object_id: "object-feed-cache",
      type: "image",
      extra: { label: "thermal" }
    });
    expect(created).toMatchObject({ extra: { label: "thermal" } });
    core.emit(
      {
        event: "create",
        resource_type: "object",
        id: created.object_id,
        version: created.metadata.version,
        resource: core.objects.get(created.object_id)!
      },
      { record: false }
    );
    await vi.waitFor(() => expect(client.sync.status().lastVersion).toBe(created.metadata.version));

    const feedObject = core.upsertObject({ ...object("object-feed-cache"), type: "log" });
    core.emit(
      {
        event: "update",
        resource_type: "object",
        id: feedObject.object_id,
        version: feedObject.metadata.version,
        resource: feedObject
      },
      { record: false }
    );

    await vi.waitFor(() => {
      expect(client.sync.status().lastVersion).toBeGreaterThanOrEqual(feedObject.metadata.version);
    });

    const detailRequestsBeforeRead = core.requests.filter((request) => request === "/objects/object-feed-cache").length;
    const fetched = await client.objects.get("object-feed-cache");

    expect(fetched).toMatchObject({
      object_id: "object-feed-cache",
      type: "log",
      extra: { label: "thermal" }
    });
    expect(core.requests.filter((request) => request === "/objects/object-feed-cache")).toHaveLength(
      detailRequestsBeforeRead + 1
    );
  });

  it("rejects write payloads with missing required fields or invalid shapes", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    await expect(client.tasks.create({} as never, { idempotencyKey: "invalid" })).rejects.toMatchObject({
      status: 400,
      errorCode: "INVALID_JSON"
    });
    await expect(
      client.objects.create({ object_id: "object-invalid-ref", referenced_by: [{}] } as never)
    ).rejects.toMatchObject({
      status: 400,
      errorCode: "INVALID_JSON"
    });
    core.upsertEntity(entity("asset-empty-update"));
    await expect(client.entities.update("asset-empty-update", {} as never)).rejects.toMatchObject({
      status: 400,
      errorCode: "INVALID_JSON"
    });
  });

  it("rejects cyclic JSON values in Task input", () => {
    const input: Record<string, unknown> = {};
    input.self = input;

    expect(isTaskCreateRequest({ asset_id: "asset-cycle", command: "fixture.queued", input })).toBe(false);
  });

  it("rejects JSON integers that JavaScript cannot represent exactly", async () => {
    const unsafeTask = `{
      "task_id":"task-unsafe-number",
      "asset_id":"asset-1",
      "command":"fixture.queued",
      "input":{"value":9007199254740993},
      "status":"pending",
      "created_at":"2026-08-20T12:00:00Z",
      "updated_at":"2026-08-20T12:00:00Z"
    }`;
    const inboundClient = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async () =>
        new Response(unsafeTask, {
          headers: { "Content-Type": "application/json", ETag: '"v1"' }
        })
    });

    await expect(inboundClient.tasks.get("task-unsafe-number", { fresh: true })).rejects.toThrow(
      "integer that JavaScript cannot represent exactly"
    );

    const fetchImpl = vi.fn<typeof fetch>();
    const outboundClient = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });
    await expect(
      outboundClient.tasks.create(
        { asset_id: "asset-1", command: "fixture.queued", input: { value: Number.MAX_SAFE_INTEGER + 1 } },
        { idempotencyKey: "unsafe-number" }
      )
    ).rejects.toThrow("integer that JavaScript cannot represent exactly");

    await expect(
      outboundClient.tasks.create(
        {
          asset_id: "asset-1",
          command: "fixture.queued",
          input: { value: new Number(Number.MAX_SAFE_INTEGER + 1) } as never
        },
        { idempotencyKey: "boxed-unsafe-number" }
      )
    ).rejects.toThrow("integer that JavaScript cannot represent exactly");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects boxed non-finite numbers before they serialize to null", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });

    for (const [name, value] of [
      ["nan", Number.NaN],
      ["infinity", Number.POSITIVE_INFINITY]
    ] as const) {
      await expect(
        client.tasks.create(
          {
            asset_id: "asset-1",
            command: "fixture.queued",
            input: { nested: { value: new Number(value) } } as never
          },
          { idempotencyKey: `boxed-${name}` }
        )
      ).rejects.toThrow("number outside the JavaScript range");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns protocol errors for malformed fake Core request JSON", async () => {
    const core = new FakeCore();

    const response = await core.fetch("http://atlas.test/tasks", {
      method: "POST",
      headers: { "Idempotency-Key": "malformed-json" },
      body: "{"
    });

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
    core.changedSinceLimit = 1;

    const fullResponse = await core.fetch("http://atlas.test/queries/full?entity_cursor=abc");
    await expect(fullResponse.json()).resolves.toMatchObject({
      success: false,
      error_code: "VALIDATION_ERROR"
    });
    expect(fullResponse.status).toBe(400);

    const changedSinceResponse = await core.fetch("http://atlas.test/queries/changed-since?since_version=0&cursor=-1");
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
    const failure = await client.entities.get("missing-entity").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AtlasAPIError);
    expect(failure).toMatchObject({ code: "ATLAS_API_ERROR" });
    expect(isAtlasAPIError(failure)).toBe(true);
  });

  it("surfaces successful invalid JSON responses as JSON parse failures", async () => {
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async () => new Response("{", { status: 200, headers: { "Content-Type": "application/json" } })
    });

    await expect(client.queries.full()).rejects.toThrow(SyntaxError);
  });

  it("surfaces empty successful JSON responses as JSON parse failures", async () => {
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async () => new Response("", { status: 200, headers: { "Content-Type": "application/json" } })
    });

    await expect(client.queries.full()).rejects.toThrow(SyntaxError);
  });

  it("collapses non-JSON error responses into unstructured AtlasAPIError", async () => {
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: async () => new Response("server exploded", { status: 500, headers: { "Content-Type": "text/plain" } })
    });

    await expect(client.queries.full()).rejects.toMatchObject({
      name: "AtlasAPIError",
      status: 500,
      response: undefined,
      errorCode: undefined,
      message: "Atlas request failed: 500"
    });
  });
});
