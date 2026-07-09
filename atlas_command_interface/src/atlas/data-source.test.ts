import { afterEach, describe, expect, it, vi } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import {
  ATLAS_PROTOCOL_REVISION,
  type EntityResource,
  type EntityUpdateRequest,
  type TaskResource
} from "../../../atlas_sdk/src/index.js";
import { createSdkDataSource } from "./data-source.js";
import type { CommandDefinition } from "./command-model.js";
import type { UiGeometry } from "./geometry.js";

const config = {
  atlasBaseUrl: "https://core.test",
  protocolRevision: "rev",
  defaultMapSourceId: "openstreetmap-default",
  mapSources: [{ id: "openstreetmap-default", label: "OpenStreetMap Default", style: style("openstreetmap-default") }]
};
const holdPositionCommand: CommandDefinition = {
  id: "hold_position",
  name: "Hold Position",
  description: "Hold here.",
  parameters_schema: { seconds: { type: "number", description: "Seconds", required: false } }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function style(id: string): StyleSpecification {
  return { version: 8, sources: {}, layers: [], metadata: { id } };
}

function metadata(version: number) {
  return { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version };
}

function entity(id: string, version = 1, components: EntityResource["components"] = {}): EntityResource {
  return { entity_id: id, entity_type: "asset", subtype: null, alias: id, components, metadata: metadata(version) };
}

function task(id: string, entityId: string, version = 1): TaskResource {
  return { task_id: id, status: "pending", entity_id: entityId, components: {}, metadata: metadata(version) };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("sdk data source", () => {
  it("starts live SDK sync and reports sync health", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url === "https://core.test/protocol/revision") {
          return jsonResponse({ protocol_revision: ATLAS_PROTOCOL_REVISION });
        }
        if (url === "https://core.test/queries/full") {
          return jsonResponse({ entities: [], tasks: [], objects: [], has_more_entities: false, has_more_tasks: false, has_more_objects: false });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const dataSource = createSdkDataSource(config);
    expect(dataSource.snapshot()).toEqual({ entities: {}, tasks: {} });
    expect(dataSource.health?.()).toEqual({ running: false, healthy: false, degraded: false });

    await dataSource.start();

    expect(requestedUrls).toEqual(["https://core.test/protocol/revision", "https://core.test/queries/full"]);
    expect(dataSource.snapshot()).toEqual({ entities: {}, tasks: {} });
    expect(dataSource.health?.()).toEqual({ running: true, healthy: true, degraded: false });

    dataSource.dispose();

    expect(dataSource.health?.()).toEqual({ running: false, healthy: false, degraded: false });
  });

  it("hydrates multiple SDK pages once and serves snapshots without a second UI hydration", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url === "http://atlas.test/protocol/revision") {
          return jsonResponse({ protocol_revision: ATLAS_PROTOCOL_REVISION });
        }
        if (url === "http://atlas.test/queries/full") {
          return jsonResponse({
            entities: [entity("asset-page-1", 1)],
            tasks: [task("task-page-1", "asset-page-1", 2)],
            objects: [],
            has_more_entities: true,
            has_more_tasks: true,
            has_more_objects: false,
            next_entity_cursor: "entity-next",
            next_task_cursor: "task-next"
          });
        }
        if (url === "http://atlas.test/queries/full?entity_cursor=entity-next&task_cursor=task-next") {
          return jsonResponse({
            entities: [entity("asset-page-2", 3)],
            tasks: [task("task-page-2", "asset-page-2", 4)],
            objects: [],
            has_more_entities: false,
            has_more_tasks: false,
            has_more_objects: false
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const dataSource = createSdkDataSource({ ...config, atlasBaseUrl: "http://atlas.test" });
    await dataSource.start();

    expect(Object.keys(dataSource.snapshot().entities).sort()).toEqual(["asset-page-1", "asset-page-2"]);
    expect(Object.keys(dataSource.snapshot().tasks).sort()).toEqual(["task-page-1", "task-page-2"]);
    expect(requestedUrls.filter((url) => url.startsWith("http://atlas.test/queries/full"))).toHaveLength(2);

    dataSource.snapshot();
    dataSource.snapshot();

    expect(requestedUrls.filter((url) => url.startsWith("http://atlas.test/queries/full"))).toHaveLength(2);
  });

  it("creates command tasks through the SDK transport and updates the snapshot cache", async () => {
    const calls: Array<{ input: unknown; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (!init) throw new Error("missing request init");
        calls.push({ input, init });
        return jsonResponse({ task_id: "t1", status: "pending", entity_id: "asset-1", components: {}, metadata: metadata(1) }, 201);
      })
    );

    const dataSource = createSdkDataSource(config);
    const onSnapshotChanged = vi.fn();
    dataSource.watch(onSnapshotChanged);
    const created = await dataSource.submitCommand({ entityId: "asset-1", command: holdPositionCommand, parameters: { seconds: "5" } });

    expect(created.task_id).toBe("t1");
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
    expect(onSnapshotChanged).toHaveBeenCalledTimes(1);
    expect(dataSource.snapshot().tasks.t1).toEqual(created);
  });

  it("updates geometry through the SDK write path and updates the snapshot cache", async () => {
    const requestHeaders: Array<{ path: string; ifMatch: string | null }> = [];
    let storedEntity = entity("asset-1", 1);
    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        requestHeaders.push({ path: url.pathname, ifMatch: new Headers(init?.headers).get("If-Match") });
        if (url.href === "http://atlas.test/protocol/revision" && method === "GET") {
          return jsonResponse({ protocol_revision: ATLAS_PROTOCOL_REVISION });
        }
        if (url.href === "http://atlas.test/queries/full" && method === "GET") {
          return jsonResponse({ entities: [storedEntity], tasks: [], objects: [], has_more_entities: false, has_more_tasks: false, has_more_objects: false });
        }
        if (url.href === "http://atlas.test/entities/asset-1" && method === "PATCH") {
          const patch = JSON.parse(String(init?.body)) as EntityUpdateRequest;
          storedEntity = { ...storedEntity, components: { ...storedEntity.components, ...patch.components }, metadata: metadata(2) };
          return jsonResponse(storedEntity);
        }
        throw new Error(`Unexpected request: ${method} ${url.href}`);
      })
    );
    const dataSource = createSdkDataSource({ ...config, atlasBaseUrl: "http://atlas.test" });
    const onSnapshotChanged = vi.fn();
    dataSource.watch(onSnapshotChanged);
    await dataSource.start();

    const geometry: UiGeometry = { type: "Point", coordinates: [-74.2, 40.1] };
    const updated = await dataSource.updateGeometry("asset-1", geometry, 1);

    expect(updated.components.geometry).toEqual(geometry);
    expect(dataSource.snapshot().entities["asset-1"]?.components.geometry).toEqual(geometry);
    expect(requestHeaders.find((request) => request.path === "/entities/asset-1")?.ifMatch).toBe('"v1"');
    expect(onSnapshotChanged).toHaveBeenCalledTimes(1);
  });

  it("dispatches auth-expired for Core session failures", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ success: false, error_code: "UNAUTHORIZED", message: "Login is required" }, 401))
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
      vi.fn(async () => jsonResponse({ success: false, error_code: "SOMETHING_ELSE", message: "Invalid API key" }, 401))
    );

    const dataSource = createSdkDataSource(config);
    await expect(dataSource.submitCommand({ entityId: "asset-1", command: holdPositionCommand, parameters: { seconds: 5 } })).rejects.toMatchObject({
      status: 401,
      errorCode: "SOMETHING_ELSE"
    });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
