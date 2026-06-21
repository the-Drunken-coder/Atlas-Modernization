import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandSubmitError, createSdkDataSource } from "./data-source.js";

const config = { atlasBaseUrl: "https://console.test/atlas", protocolRevision: "rev" };
const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

afterEach(() => vi.unstubAllGlobals());

describe("sdk data source command submission", () => {
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
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ entity_id: "asset-1", command_id: "hold_position", parameters: { seconds: "5" } });
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
