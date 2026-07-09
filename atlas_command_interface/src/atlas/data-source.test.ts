import { afterEach, describe, expect, it, vi } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import { createSdkDataSource } from "./data-source.js";
import type { CommandDefinition } from "./command-model.js";
import { ATLAS_PROTOCOL_REVISION } from "../../../atlas_sdk/src/index.js";

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

function fullResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({ entities: [], tasks: [], objects: [], has_more_entities: false, has_more_tasks: false, has_more_objects: false, ...overrides }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("sdk data source", () => {
  it("starts live SDK sync, exposes its cache snapshot, and reports sync health", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url === "https://core.test/protocol/revision") {
          return new Response(JSON.stringify({ protocol_revision: ATLAS_PROTOCOL_REVISION }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url === "https://core.test/queries/full") return fullResponse();
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const dataSource = createSdkDataSource(config);
    expect(dataSource.health?.()).toEqual({ running: false, healthy: false, degraded: false });

    await dataSource.start();

    expect(requestedUrls).toEqual(["https://core.test/protocol/revision", "https://core.test/queries/full"]);
    expect(dataSource.snapshot()).toEqual({ entities: {}, tasks: {} });
    expect(dataSource.health?.()).toEqual({ running: true, healthy: true, degraded: false });

    dataSource.dispose();

    expect(dataSource.health?.()).toEqual({ running: false, healthy: false, degraded: false });
  });

  it("uses the SDK's multi-page hydration without a second UI dataset request", async () => {
    const requestedUrls: string[] = [];
    let fullRequests = 0;
    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url === "https://core.test/protocol/revision") {
          return new Response(JSON.stringify({ protocol_revision: ATLAS_PROTOCOL_REVISION }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (!url.startsWith("https://core.test/queries/full")) throw new Error(`Unexpected request: ${url}`);
        fullRequests += 1;
        if (fullRequests === 1) {
          return fullResponse({
            entities: [{ entity_id: "asset-1", entity_type: "asset", subtype: null, alias: "One", components: {}, metadata }],
            tasks: [{ task_id: "task-1", entity_id: "asset-1", status: "pending", components: {}, metadata }],
            has_more_entities: true,
            next_entity_cursor: "next-entity"
          });
        }
        return fullResponse({ entities: [{ entity_id: "asset-2", entity_type: "asset", subtype: null, alias: "Two", components: {}, metadata: { ...metadata, version: 2 } }] });
      })
    );

    const dataSource = createSdkDataSource(config);
    await dataSource.start();
    const snapshot = dataSource.snapshot();

    expect(fullRequests).toBe(2);
    expect(requestedUrls.filter((url) => url.includes("/queries/full"))).toHaveLength(2);
    expect(requestedUrls[2]).toContain("entity_cursor=next-entity");
    expect(Object.keys(snapshot.entities).sort()).toEqual(["asset-1", "asset-2"]);
    expect(Object.keys(snapshot.tasks)).toEqual(["task-1"]);
  });

  it("creates command tasks through the SDK transport and cache path", async () => {
    const calls: Array<{ input: unknown; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ task_id: "t1", status: "pending", entity_id: "asset-1", components: {}, metadata }), {
          status: 201,
          headers: { "Content-Type": "application/json" }
        });
      })
    );

    const dataSource = createSdkDataSource(config);
    const task = await dataSource.submitCommand({ entityId: "asset-1", command: holdPositionCommand, parameters: { seconds: "5" } });

    expect(task.task_id).toBe("t1");
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
    expect(dataSource.snapshot().tasks).toMatchObject({ t1: task });
  });

  it("dispatches auth-expired for Core session failures", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: false, error_code: "UNAUTHORIZED", message: "Login is required" }), { status: 401 }))
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
      vi.fn(async () => new Response(JSON.stringify({ success: false, error_code: "SOMETHING_ELSE", message: "Invalid API key" }), { status: 401 }))
    );

    const dataSource = createSdkDataSource(config);
    await expect(dataSource.submitCommand({ entityId: "asset-1", command: holdPositionCommand, parameters: { seconds: 5 } })).rejects.toMatchObject({
      status: 401,
      errorCode: "SOMETHING_ELSE"
    });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
