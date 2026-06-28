import { afterEach, describe, expect, it, vi } from "vitest";
import { createSdkDataSource } from "./data-source.js";
import type { CommandDefinition } from "./command-model.js";

const config = { atlasBaseUrl: "https://core.test", protocolRevision: "rev" };
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

describe("sdk data source", () => {
  it("paginates entity and task snapshots without paginating objects", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        requestedUrls.push(String(input));
        return new Response(
          JSON.stringify({
            entities: [],
            tasks: [],
            objects: [],
            has_more_entities: requestedUrls.length === 1,
            has_more_tasks: false,
            has_more_objects: requestedUrls.length === 1,
            next_entity_cursor: "next-entities",
            next_object_cursor: "next-objects"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const dataSource = createSdkDataSource(config);
    await dataSource.loadSnapshot();

    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toBe("https://core.test/queries/full");
    expect(requestedUrls[1]).toContain("entity_cursor=next-entities");
    expect(requestedUrls[1]).not.toContain("object_cursor=");
  });

  it("stops snapshot pagination when the server keeps returning cursors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            entities: [],
            tasks: [],
            objects: [],
            has_more_entities: true,
            has_more_tasks: false,
            has_more_objects: false,
            next_entity_cursor: "same-cursor"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const dataSource = createSdkDataSource(config);
    await expect(dataSource.loadSnapshot()).rejects.toThrow("Atlas snapshot pagination exceeded 100 pages");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(100);
  });

  it("rejects paginated snapshots when a required cursor is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            entities: [],
            tasks: [],
            objects: [],
            has_more_entities: true,
            has_more_tasks: false,
            has_more_objects: false
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const dataSource = createSdkDataSource(config);
    await expect(dataSource.loadSnapshot()).rejects.toThrow("Atlas snapshot page indicated more entities without a next cursor");
  });

  it("creates command tasks directly against Core", async () => {
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
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      entity_id: "asset-1",
      components: {
        command: { type: "hold_position", id: "hold_position" },
        parameters: { seconds: 5 }
      },
      status: "pending"
    });
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
