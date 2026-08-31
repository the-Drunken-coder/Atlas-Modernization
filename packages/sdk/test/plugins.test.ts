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

  it("validates spatial input and result contracts", async () => {
    const result = {
      features: [],
      provenance: { connector_id: "fixture", source: "Recorded fixture" },
      attribution: { text: "Fixture data", url: "https://example.test/attribution" },
      retrieved_at: "2026-08-30T12:00:00Z",
      truncation: null
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(result));
    const client = new AtlasClient({ baseUrl: "https://core.test", fetch: fetchMock, sync: false });

    await expect(
      client.plugins.invokeSpatial("fixture", "search", {
        west: -71.31,
        south: 42.27,
        east: -71.3,
        north: 42.28
      })
    ).resolves.toEqual(result);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      body: '{"west":-71.31,"south":42.27,"east":-71.3,"north":42.28}'
    });
    expect(() =>
      client.plugins.invokeSpatial("fixture", "search", { west: 179.9, south: 0, east: -179.9, north: 0.01 })
    ).toThrow("no larger than 5 km²");

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...result, features: [{ id: "duplicate" }, { id: "duplicate" }] }));
    await expect(
      client.plugins.invokeSpatial("fixture", "search", { west: -71.31, south: 42.27, east: -71.3, north: 42.28 })
    ).rejects.toThrow("response failed validation");
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
