import { afterEach, describe, expect, it, vi } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import { ATLAS_PROTOCOL_REVISION, type EntityResource, type TaskResource } from "../../../atlas_sdk/src/index.js";
import { createSdkDataSource } from "./data-source.js";
import type { CommandDefinition } from "./command-model.js";
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
