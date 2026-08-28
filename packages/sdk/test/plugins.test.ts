import { describe, expect, it, vi } from "vitest";
import { AtlasClient } from "../src/index.js";

describe("AtlasClient Plugins", () => {
  it("lists Plugin status and invokes an Operation using the documented paths", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            plugin_id: "reference",
            display_name: "Reference Fixture",
            status: "available",
            reason_code: null,
            checked_at: "2026-08-28T12:00:00Z",
            operations: [{ operation_id: "inspect_fixture", display_name: "Inspect fixture", timeout_ms: 5000 }],
            tool_asset_id: null
          }
        ])
      )
      .mockResolvedValueOnce(jsonResponse({ value: 7 }));
    const client = new AtlasClient({ baseUrl: "https://core.test", fetch: fetchMock, sync: false });

    await expect(client.plugins.list()).resolves.toHaveLength(1);
    await expect(client.plugins.invoke("reference", "inspect_fixture", { key: "alpha" })).resolves.toEqual({
      value: 7
    });

    expect(fetchMock.mock.calls[0][0]).toBe("https://core.test/plugins");
    expect(fetchMock.mock.calls[1][0]).toBe("https://core.test/plugins/reference/operations/inspect_fixture");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", body: '{"key":"alpha"}' });
  });

  it("validates discovery and Operation JSON responses at runtime", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ plugins: [] }))
      .mockResolvedValueOnce(
        new Response("{not json}", { status: 200, headers: { "Content-Type": "application/json" } })
      );
    const client = new AtlasClient({ baseUrl: "https://core.test", fetch: fetchMock, sync: false });

    await expect(client.plugins.list()).rejects.toThrow("response failed validation");
    await expect(client.plugins.invoke("reference", "inspect_fixture", null)).rejects.toThrow();
  });

  it("rejects contradictory Plugin discovery states", async () => {
    const client = new AtlasClient({
      baseUrl: "https://core.test",
      sync: false,
      fetch: async () =>
        jsonResponse([
          {
            plugin_id: "reference",
            display_name: "Reference Fixture",
            status: "available",
            reason_code: "transport_timeout",
            checked_at: "2026-08-28T12:00:00Z",
            operations: [],
            tool_asset_id: null
          }
        ])
    });

    await expect(client.plugins.list()).rejects.toThrow("response failed validation");
  });

  it("preserves structured Plugin failure details", async () => {
    const client = new AtlasClient({
      baseUrl: "https://core.test",
      sync: false,
      fetch: async () =>
        new Response(
          JSON.stringify({
            success: false,
            error_code: "PLUGIN_FAILURE",
            message: "Plugin Operation failed",
            details: { plugin_code: "source_failed", plugin_details: { field: "key" } }
          }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        )
    });

    await expect(client.plugins.invoke("reference", "inspect_fixture", null)).rejects.toMatchObject({
      errorCode: "PLUGIN_FAILURE",
      details: { plugin_code: "source_failed", plugin_details: { field: "key" } },
      response: expect.objectContaining({
        details: { plugin_code: "source_failed", plugin_details: { field: "key" } }
      })
    });
  });

  it("propagates caller cancellation", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      throw new Error("unreachable");
    });
    const client = new AtlasClient({ baseUrl: "https://core.test", fetch: fetchMock, sync: false });
    const controller = new AbortController();
    const pending = client.plugins.list({ signal: controller.signal });
    controller.abort(new Error("closed"));
    await expect(pending).rejects.toThrow("closed");
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
