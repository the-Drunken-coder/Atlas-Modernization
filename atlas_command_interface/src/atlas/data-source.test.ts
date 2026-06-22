import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandSubmitError, createSdkDataSource } from "./data-source.js";

const config = { atlasBaseUrl: "https://console.test/atlas", protocolRevision: "rev" };
const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sdk data source command submission", () => {
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
    expect(requestedUrls[0]).toBe("https://console.test/atlas/queries/full");
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

  it("posts to /api/commands with bearer auth and returns the created task", async () => {
    const calls: Array<{ input: unknown; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ task: { task_id: "t1", status: "pending", entity_id: "asset-1", components: {}, metadata } }), {
          status: 201,
          headers: { "Content-Type": "application/json" }
        });
      })
    );

    const dataSource = createSdkDataSource(config);
    const task = await dataSource.submitCommand({ entityId: "asset-1", commandId: "hold_position", parameters: { seconds: "5" } }, "secret");

    expect(task.task_id).toBe("t1");
    expect(task.status).toBe("pending");
    expect(calls[0].input).toBe("/api/commands");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ entity_id: "asset-1", command_id: "hold_position", parameters: { seconds: "5" } });
  });

  it("aborts command submissions that do not complete", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })
      )
    );

    const dataSource = createSdkDataSource(config);
    const pending = dataSource.submitCommand({ entityId: "asset-1", commandId: "hold_position" }, "secret");
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });

    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });

  it("wraps non-2xx responses in a CommandSubmitError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: false, error_code: "UNSUPPORTED_COMMAND", message: "nope" }), { status: 400 }))
    );
    const dataSource = createSdkDataSource(config);
    await expect(dataSource.submitCommand({ entityId: "asset-1", commandId: "x" }, "secret")).rejects.toMatchObject({
      name: "CommandSubmitError",
      errorCode: "UNSUPPORTED_COMMAND"
    });
  });

  it("exposes CommandSubmitError as an Error subclass", () => {
    expect(new CommandSubmitError(400, "X", "msg")).toBeInstanceOf(Error);
  });
});
