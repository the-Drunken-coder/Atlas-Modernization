import { afterEach, describe, expect, it, vi } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import {
  ATLAS_PROTOCOL_REVISION,
  type EntityResource,
  type FeedEvent,
  type JSONValue,
  type ObjectResource,
  type ObjectResponse,
  type TaskResource
} from "../../../atlas_sdk/src/index.js";
import { createSdkDataSource } from "./data-source.js";
import { COMMAND_CATALOG_OBJECT_ID, type CommandDefinition } from "./command-model.js";
import type { UiGeometry } from "./geometry.js";

const config = {
  atlasBaseUrl: "https://core.test",
  protocolRevision: "rev",
  defaultMapSourceId: "openstreetmap-default",
  mapSources: [{ id: "openstreetmap-default", label: "OpenStreetMap Default", style: style("openstreetmap-default") }]
};
const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };
const holdPositionCommand: CommandDefinition = {
  id: "hold_position",
  name: "Hold Position",
  description: "Hold here.",
  parameters_schema: { seconds: { type: "number", description: "Seconds", required: false } }
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function style(id: string): StyleSpecification {
  return { version: 8, sources: {}, layers: [], metadata: { id } };
}

function entity(id: string, version = 1): EntityResource {
  return { entity_id: id, entity_type: "asset", subtype: null, alias: id, components: {}, metadata: { ...metadata, version } };
}

function task(id: string, entityId: string, version = 1): TaskResource {
  return { task_id: id, status: "pending", entity_id: entityId, components: {}, metadata: { ...metadata, version } };
}

describe("sdk data source", () => {
  it("hydrates every page once and exposes the final SDK cache snapshot", async () => {
    const firstEntity = entity("asset-1", 1);
    const secondEntity = entity("asset-2", 2);
    const firstTask = task("task-1", firstEntity.entity_id, 3);
    const secondTask = task("task-2", secondEntity.entity_id, 4);
    const requestedUrls: string[] = [];
    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url === "https://core.test/protocol/revision") {
          return Response.json({ protocol_revision: ATLAS_PROTOCOL_REVISION });
        }
        if (url === "https://core.test/queries/full") {
          return Response.json({
            entities: [firstEntity],
            tasks: [firstTask],
            objects: [],
            has_more_entities: true,
            has_more_tasks: true,
            has_more_objects: false,
            next_entity_cursor: "next-entities",
            next_task_cursor: "next-tasks"
          });
        }
        if (url.includes("/queries/full?") && url.includes("entity_cursor=next-entities") && url.includes("task_cursor=next-tasks")) {
          return Response.json({
            entities: [secondEntity],
            tasks: [secondTask],
            objects: [],
            has_more_entities: false,
            has_more_tasks: false,
            has_more_objects: false
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const dataSource = createSdkDataSource(config);
    expect(dataSource.health?.()).toEqual({ running: false, healthy: false, degraded: false });

    await dataSource.start();

    expect(requestedUrls.filter((url) => url.includes("/queries/full"))).toHaveLength(2);
    expect(dataSource.snapshot()).toEqual({
      entities: { [firstEntity.entity_id]: firstEntity, [secondEntity.entity_id]: secondEntity },
      tasks: { [firstTask.task_id]: firstTask, [secondTask.task_id]: secondTask }
    });
    expect(requestedUrls.filter((url) => url.includes("/queries/full"))).toHaveLength(2);
    expect(dataSource.health?.()).toEqual({ running: true, healthy: true, degraded: false });

    dataSource.dispose();

    expect(dataSource.health?.()).toEqual({ running: false, healthy: false, degraded: false });
  });

  it("keeps snapshots current through the slow changed-since poll when WebSocket connections are blocked", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", BlockedWebSocket);
    const core = new TestCore();
    const original = core.upsertEntity(entity("asset-poll"));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => core.fetch(String(input), init)));
    const dataSource = createSdkDataSource(config);
    const snapshots = vi.fn();
    dataSource.watch(snapshots);

    const start = dataSource.start();
    await vi.advanceTimersByTimeAsync(0);
    await start;
    const updated = core.upsertEntity({ ...original, alias: "Recovered by poll" });
    core.requests = [];

    await vi.advanceTimersByTimeAsync(119_999);
    expect(core.requests.filter((request) => request.startsWith("/queries/changed-since"))).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(snapshots).toHaveBeenLastCalledWith({ entities: { [updated.entity_id]: updated }, tasks: {} }));
    expect(core.requests.filter((request) => request.startsWith("/queries/changed-since"))).toHaveLength(1);
    expect(dataSource.health?.()).toMatchObject({ running: true, degraded: true });

    dataSource.dispose();
    core.requests = [];
    await vi.advanceTimersByTimeAsync(120_000);
    expect(core.requests).toHaveLength(0);
  });

  it("recovers missed changes through changed-since after the feed reconnects", async () => {
    vi.useFakeTimers();
    const core = new TestCore();
    const original = core.upsertEntity(entity("asset-reconnect"));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => core.fetch(String(input), init)));
    vi.stubGlobal("WebSocket", core.attachWebSocketGlobal());
    const dataSource = createSdkDataSource(config);
    const snapshots = vi.fn();
    dataSource.watch(snapshots);

    const start = dataSource.start();
    await vi.advanceTimersByTimeAsync(0);
    await start;
    const firstSocket = [...core.sockets][0];
    expect(firstSocket).toBeDefined();

    firstSocket?.close();
    const updated = core.upsertEntity({ ...original, alias: "Recovered after reconnect" });
    core.requests = [];

    await vi.advanceTimersByTimeAsync(999);
    expect(core.feedConnections).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);

    await vi.waitFor(() => expect(snapshots).toHaveBeenLastCalledWith({ entities: { [updated.entity_id]: updated }, tasks: {} }));
    expect(core.feedConnections).toBe(2);
    expect(core.requests.some((request) => request.startsWith("/queries/changed-since"))).toBe(true);
    expect(dataSource.health?.()).toEqual({ running: true, healthy: true, degraded: false });

    dataSource.dispose();
  });

  it("fails closed and retries a live command catalog refresh after a transient detail failure", async () => {
    vi.useFakeTimers();
    const core = new TestCore();
    core.upsertObject(COMMAND_CATALOG_OBJECT_ID, "command_catalog", catalogFields("Original catalog"));
    core.upsertObject("other-object", "other");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => core.fetch(String(input), init)));
    vi.stubGlobal("WebSocket", core.attachWebSocketGlobal());
    const dataSource = createSdkDataSource(config);
    const catalogs = vi.fn();
    dataSource.watch(() => undefined, catalogs);

    const start = dataSource.start();
    await vi.advanceTimersByTimeAsync(0);
    await start;
    await expect(dataSource.loadCommandCatalog()).resolves.toMatchObject({ name: "Original catalog" });
    core.requests = [];

    core.upsertObject("other-object", "still-other", {}, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(catalogs).not.toHaveBeenCalled();

    core.objectFailures = 1;
    core.upsertObject(COMMAND_CATALOG_OBJECT_ID, "command_catalog", catalogFields("Updated catalog"), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(catalogs).toHaveBeenLastCalledWith(undefined);
    expect(core.requests.filter((request) => request === `/objects/${COMMAND_CATALOG_OBJECT_ID}`)).toHaveLength(1);
    expect(core.requests.some((request) => request.startsWith("/queries/changed-since"))).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(catalogs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(catalogs).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Updated catalog" })));
    expect(catalogs).toHaveBeenCalledTimes(2);
    expect(core.requests.filter((request) => request === `/objects/${COMMAND_CATALOG_OBJECT_ID}`)).toHaveLength(2);

    core.deleteObject(COMMAND_CATALOG_OBJECT_ID, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(catalogs).toHaveBeenLastCalledWith(undefined);
    expect(catalogs).toHaveBeenCalledTimes(3);

    dataSource.dispose();
  });

  it("does not publish a superseded catalog response after a newer initial read", async () => {
    vi.useFakeTimers();
    const core = new TestCore();
    core.upsertObject(COMMAND_CATALOG_OBJECT_ID, "command_catalog", catalogFields("Original catalog"));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => core.fetch(String(input), init)));
    vi.stubGlobal("WebSocket", core.attachWebSocketGlobal());
    const dataSource = createSdkDataSource(config);
    const catalogs = vi.fn();
    dataSource.watch(() => undefined, catalogs);

    const start = dataSource.start();
    await vi.advanceTimersByTimeAsync(0);
    await start;

    const releaseOldResponse = core.delayNextObjectResponse();
    core.upsertObject(COMMAND_CATALOG_OBJECT_ID, "command_catalog", catalogFields("Older event response"), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(catalogs).toHaveBeenLastCalledWith(undefined);

    core.upsertObject(COMMAND_CATALOG_OBJECT_ID, "command_catalog", catalogFields("Newest initial response"));
    await expect(dataSource.loadCommandCatalog()).resolves.toMatchObject({ name: "Newest initial response" });

    releaseOldResponse();
    await vi.advanceTimersByTimeAsync(0);
    expect(catalogs).toHaveBeenCalledTimes(1);

    dataSource.dispose();
  });

  it("routes command and geometry writes through SDK cache notifications", async () => {
    const calls: Array<{ input: unknown; init: RequestInit }> = [];
    const createdTask = task("task-created", "asset-1", 2);
    const updatedGeometry: UiGeometry = { type: "Point", coordinates: [-74.2, 40.1] };
    const updatedEntity = { ...entity("asset-1", 3), components: { geometry: updatedGeometry } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit) => {
        calls.push({ input, init });
        if (String(input) === "https://core.test/tasks") return Response.json(createdTask, { status: 201 });
        if (String(input) === "https://core.test/entities/asset-1") return Response.json(updatedEntity);
        throw new Error(`Unexpected request: ${String(input)}`);
      })
    );
    const dataSource = createSdkDataSource(config);
    const snapshots = vi.fn();
    dataSource.watch(snapshots);

    await expect(dataSource.submitCommand({ entityId: "asset-1", command: holdPositionCommand, parameters: { seconds: "5" } })).resolves.toEqual(createdTask);
    expect(snapshots).toHaveBeenLastCalledWith({ entities: {}, tasks: { [createdTask.task_id]: createdTask } });
    expect(calls[0].input).toBe("https://core.test/tasks");
    expect(calls[0].init).toMatchObject({ method: "POST", credentials: "include" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      entity_id: "asset-1",
      components: {
        command: { type: "hold_position", id: "hold_position" },
        parameters: { seconds: 5 }
      },
      status: "pending"
    });

    await expect(dataSource.updateGeometry("asset-1", updatedGeometry, 2)).resolves.toEqual(updatedEntity);
    expect(snapshots).toHaveBeenLastCalledWith({
      entities: { [updatedEntity.entity_id]: updatedEntity },
      tasks: { [createdTask.task_id]: createdTask }
    });
    expect(calls[1].init.headers).toEqual(expect.any(Headers));
    expect(new Headers(calls[1].init.headers).get("If-Match")).toBe('"v2"');
  });

  it("dispatches auth-expired for Core session failures", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: false, error_code: "UNAUTHORIZED", message: "Login is required" }, { status: 401 }))
    );

    const dataSource = createSdkDataSource(config);
    await expect(dataSource.submitCommand({ entityId: "asset-1", command: holdPositionCommand, parameters: { seconds: 5 } })).rejects.toMatchObject({
      status: 401,
      errorCode: "UNAUTHORIZED"
    });
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "atlas-auth-expired" }));
  });

  it("does not dispatch auth-expired for non-session 401 shapes", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: false, error_code: "SOMETHING_ELSE", message: "Invalid API key" }, { status: 401 }))
    );

    const dataSource = createSdkDataSource(config);
    await expect(dataSource.submitCommand({ entityId: "asset-1", command: holdPositionCommand, parameters: { seconds: 5 } })).rejects.toMatchObject({
      status: 401,
      errorCode: "SOMETHING_ELSE"
    });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});

function catalogFields(name: string): Record<string, JSONValue> {
  return {
    name,
    description: "Test catalog",
    commands: [
      {
        id: "hold_position",
        name: "Hold Position",
        description: "Hold here.",
        parameters_schema: {}
      }
    ]
  };
}

class TestCore {
  version = 0;
  feedConnections = 0;
  objectFailures = 0;
  requests: string[] = [];
  readonly sockets = new Set<TestWebSocket>();
  private readonly entities = new Map<string, EntityResource>();
  private readonly objects = new Map<string, ObjectResponse>();
  private readonly events: FeedEvent[] = [];
  private nextObjectDelay: Promise<void> | undefined;

  fetch = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    this.requests.push(path + url.search);
    if (path === "/protocol/revision") return Response.json({ protocol_revision: ATLAS_PROTOCOL_REVISION });
    if (path === "/queries/full") {
      return Response.json({
        entities: [...this.entities.values()],
        tasks: [],
        objects: [...this.objects.values()].map(objectResource),
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false
      });
    }
    if (path === "/queries/changed-since") {
      const since = Number(url.searchParams.get("since_version"));
      const changed = this.events.filter((event) => event.version > since);
      return Response.json({
        entities: changed.filter(isEntityUpsert).map((event) => event.resource),
        tasks: [],
        objects: changed.filter(isObjectUpsert).map((event) => event.resource),
        deleted_entities: [],
        deleted_tasks: [],
        deleted_objects: changed.filter(isObjectDelete).map((event) => ({ id: event.id, type: "object", version: event.version })),
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false,
        has_more_deleted_entities: false,
        has_more_deleted_tasks: false,
        has_more_deleted_objects: false,
        version: this.version
      });
    }
    if (path.startsWith("/objects/")) {
      if (this.objectFailures > 0) {
        this.objectFailures--;
        return Response.json({ error_code: "INTERNAL_SERVER_ERROR", message: "object unavailable" }, { status: 503 });
      }
      const object = this.objects.get(decodeURIComponent(path.slice("/objects/".length)));
      const delay = this.nextObjectDelay;
      this.nextObjectDelay = undefined;
      if (delay) await delay;
      return object ? Response.json(object) : Response.json({ error_code: "OBJECT_NOT_FOUND", message: "object not found" }, { status: 404 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  attachWebSocketGlobal() {
    const core = this;
    return class BoundTestWebSocket extends TestWebSocket {
      constructor(url: string) {
        super(url, core);
      }
    };
  }

  delayNextObjectResponse(): () => void {
    let release!: () => void;
    this.nextObjectDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  upsertEntity(value: EntityResource): EntityResource {
    const version = ++this.version;
    const updated = { ...value, metadata: { ...value.metadata, version } };
    this.entities.set(updated.entity_id, updated);
    this.events.push({ event: "update", resource_type: "entity", id: updated.entity_id, version, resource: updated });
    return updated;
  }

  upsertObject(id: string, type: string, payload: Record<string, JSONValue> = {}, live = false): ObjectResponse {
    const version = ++this.version;
    const resource: ObjectResource = {
      object_id: id,
      path: null,
      content_type: null,
      type,
      size_bytes: null,
      usage_hints: type === "command_catalog" ? ["command_catalog"] : [],
      bucket: null,
      metadata: { ...metadata, version }
    };
    const response = Object.keys(payload).length > 0 ? { ...resource, payload } : resource;
    this.objects.set(id, response);
    const event: FeedEvent = { event: "update", resource_type: "object", id, version, resource };
    this.events.push(event);
    if (live) this.emit(event);
    return response;
  }

  deleteObject(id: string, live = false): void {
    if (!this.objects.delete(id)) return;
    const version = ++this.version;
    const event: FeedEvent = { event: "delete", resource_type: "object", id, version };
    this.events.push(event);
    if (live) this.emit(event);
  }

  private emit(event: FeedEvent): void {
    for (const socket of this.sockets) socket.receive(event);
  }
}

class TestWebSocket {
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  constructor(readonly url: string, private readonly core: TestCore) {
    core.feedConnections++;
    core.sockets.add(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatch("open", {});
      this.dispatch("message", { data: JSON.stringify({ type: "hello", protocol_revision: ATLAS_PROTOCOL_REVISION }) });
    });
  }

  send(): void {}

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.core.sockets.delete(this);
    this.dispatch("close", {});
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  receive(value: unknown): void {
    if (this.readyState === 1) this.dispatch("message", { data: JSON.stringify(value) });
  }

  private dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class BlockedWebSocket {
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  constructor(readonly url: string) {
    queueMicrotask(() => this.dispatch("error", {}));
  }

  send(): void {}

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch("close", {});
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function objectResource(object: ObjectResponse): ObjectResource {
  const { payload: _payload, ...resource } = object;
  return resource;
}

function isEntityUpsert(event: FeedEvent): event is Extract<FeedEvent, { resource_type: "entity"; event: "create" | "update" }> {
  return event.resource_type === "entity" && event.event !== "delete";
}

function isObjectUpsert(event: FeedEvent): event is Extract<FeedEvent, { resource_type: "object"; event: "create" | "update" }> {
  return event.resource_type === "object" && event.event !== "delete";
}

function isObjectDelete(event: FeedEvent): event is Extract<FeedEvent, { resource_type: "object"; event: "delete" }> {
  return event.resource_type === "object" && event.event === "delete";
}
