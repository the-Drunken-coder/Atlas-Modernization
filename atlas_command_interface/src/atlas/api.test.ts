import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandAPIError, fetchCommandConfig, submitCommand } from "./api.js";

describe("command API helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("adds command credentials when submitting commands", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ task: { task_id: "task-1", status: "pending", entity_id: "asset-1", components: {}, metadata: {} } }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      })
    );

    await submitCommand({ entity_id: "asset-1", command_id: "hold_position", parameters: {} }, { commandApiKey: "command-secret" });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer command-secret");
  });

  it("fetches command config from the Worker API", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ atlasBaseUrl: "https://command.test/atlas", protocolRevision: "atlas-protocol/test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    await expect(fetchCommandConfig()).resolves.toEqual({
      atlasBaseUrl: "https://command.test/atlas",
      protocolRevision: "atlas-protocol/test"
    });
  });

  it("omits command credentials when no command API key is provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ task: { task_id: "task-1", status: "pending", entity_id: "asset-1", components: {}, metadata: {} } }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      })
    );

    await submitCommand({ entity_id: "asset-1", command_id: "hold_position", parameters: {} });

    const [, init] = fetchSpy.mock.calls[0];
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });

  it("propagates well-formed API error payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: false, error_code: "UPSTREAM_DOWN", message: "Core unavailable", details: { retryable: true } }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      })
    );

    await expect(fetchCommandConfig()).rejects.toMatchObject({
      status: 502,
      code: "UPSTREAM_DOWN",
      message: "Core unavailable",
      details: { retryable: true }
    });
  });

  it("wraps network failures in CommandAPIError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));

    await expect(fetchCommandConfig()).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_ERROR"
    });
  });

  it("wraps request timeouts in CommandAPIError", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );

    const pending = expect(fetchCommandConfig({ requestTimeoutMs: 5 })).rejects.toMatchObject({
      status: 0,
      code: "REQUEST_TIMEOUT"
    });
    await vi.advanceTimersByTimeAsync(5);

    await pending;
  });

  it("preserves caller-provided abort signals", async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );

    const pending = expect(fetchCommandConfig({ signal: controller.signal })).rejects.toMatchObject({
      status: 0,
      code: "REQUEST_ABORTED"
    });
    controller.abort();

    await pending;
  });

  it("wraps invalid JSON responses in CommandAPIError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 502 }));

    try {
      await fetchCommandConfig();
      throw new Error("fetchCommandConfig should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandAPIError);
      expect(error).toMatchObject({
        status: 502,
        code: "INVALID_RESPONSE"
      });
    }
  });

  it("normalizes malformed error payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 500 }));

    await expect(fetchCommandConfig()).rejects.toMatchObject({
      status: 500,
      code: "INVALID_RESPONSE"
    });
  });
});
