import { once } from "node:events";
import { AtlasAPIError, type EntityResource, type JSONValue } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  definePlugin,
  defineSpatialOperation,
  deriveToolAssetId,
  ensureToolAsset,
  PluginFailureError,
  PluginInputError,
  SourceGatewayClient,
  SourceGatewayError,
  servePlugin
} from "../src/index.js";

describe("Atlas Plugin runtime", () => {
  it("derives and validates an immutable private manifest", () => {
    const plugin = definePlugin({
      pluginId: "adsb",
      displayName: " ADS-B ",
      taskable: true,
      operations: {
        inspect_aircraft: {
          displayName: "Inspect aircraft",
          timeoutMs: 5000,
          handler: () => null
        }
      }
    });
    expect(plugin.manifest).toEqual({
      plugin_id: "adsb",
      display_name: "ADS-B",
      operations: [
        {
          operation_id: "inspect_aircraft",
          display_name: "Inspect aircraft",
          timeout_ms: 5000
        }
      ],
      tool_asset_id: "plugin_rfSey5Te4YU6Prz-hpGcwRnuSBuF9z1COTHZJt_s0G4"
    });
    expect(deriveToolAssetId("adsb")).toBe(plugin.manifest.tool_asset_id);
    expect(Object.isFrozen(plugin)).toBe(true);
    expect(Object.isFrozen(plugin.operations)).toBe(true);
    expect(Object.isFrozen(plugin.operations.inspect_aircraft)).toBe(true);
    expect(Object.isFrozen(plugin.manifest)).toBe(true);
    expect(Object.isFrozen(plugin.manifest.operations)).toBe(true);
    expect(Object.isFrozen(plugin.manifest.operations[0])).toBe(true);
    expect(() => definePlugin({ pluginId: "bad-id", displayName: "Bad", operations: {} })).toThrow(TypeError);
  });

  it("enforces Protocol display-name lengths by Unicode code point", () => {
    const operation = { displayName: "x".repeat(100), timeoutMs: 1000, handler: () => null };
    expect(() =>
      definePlugin({ pluginId: "reference", displayName: "😀".repeat(100), operations: { inspect_fixture: operation } })
    ).not.toThrow();
    expect(() =>
      definePlugin({ pluginId: "reference", displayName: "😀".repeat(101), operations: { inspect_fixture: operation } })
    ).toThrow("Plugin display name must be no more than 100 characters");
    expect(() =>
      definePlugin({
        pluginId: "reference",
        displayName: "Reference",
        operations: { inspect_fixture: { ...operation, displayName: "x".repeat(101) } }
      })
    ).toThrow("Operation inspect_fixture display name must be no more than 100 characters");
  });

  it("defines map-area Operations with shared input and output validation", async () => {
    const operation = defineSpatialOperation({
      displayName: "Search area",
      timeoutMs: 1000,
      handler: (_area) => ({
        features: [],
        provenance: { connector_id: "fixture", source: "Recorded fixture" },
        attribution: { text: "Fixture data", url: "https://example.test/attribution" },
        retrieved_at: "2026-08-30T12:00:00Z",
        truncation: null
      })
    });
    const plugin = definePlugin({
      pluginId: "spatial_fixture",
      displayName: "Spatial fixture",
      operations: { search: operation }
    });

    expect(plugin.manifest.operations[0]).toMatchObject({ interaction: { kind: "map_area" } });
    await expect(
      operation.handler({ west: -71.31, south: 42.27, east: -71.3, north: 42.28 }, new AbortController().signal)
    ).resolves.toMatchObject({ features: [], truncation: null });
    await expect(
      operation.handler({ west: 179.9, south: 0, east: -179.9, north: 0.01 }, new AbortController().signal)
    ).rejects.toMatchObject({ pluginCode: "invalid_map_area" });
    await expect(
      operation.handler({ west: -72, south: 41, east: -71, north: 42 }, new AbortController().signal)
    ).rejects.toMatchObject({ pluginCode: "invalid_map_area" });

    const invalidResult = defineSpatialOperation({
      displayName: "Invalid result",
      timeoutMs: 1000,
      handler: () => ({ features: [] }) as never
    });
    await expect(
      invalidResult.handler({ west: -71.31, south: 42.27, east: -71.3, north: 42.28 }, new AbortController().signal)
    ).rejects.toMatchObject({ pluginCode: "invalid_spatial_result" });
  });

  it("serves manifest, health, results, and typed private errors", async () => {
    const plugin = definePlugin({
      pluginId: "reference",
      displayName: "Reference",
      health: () => false,
      operations: {
        inspect_fixture: {
          displayName: "Inspect fixture",
          timeoutMs: 1000,
          handler(input) {
            if (input === "bad") throw new PluginInputError("bad_key", { field: "key" });
            if (input === "fail") throw new PluginFailureError("source_failed");
            if (input === "mutated") {
              const details: Record<string, JSONValue> = { field: "key" };
              const failure = new PluginInputError("bad_key", details);
              details.self = details;
              throw failure;
            }
            return { received: input };
          }
        }
      }
    });
    const server = await servePlugin(plugin, { host: "127.0.0.1", port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      await expect(fetch(`${origin}/manifest`).then((response) => response.json())).resolves.toEqual(plugin.manifest);
      await expect(fetch(`${origin}/health`)).resolves.toMatchObject({
        status: 503
      });
      await expect(postJSON(`${origin}/operations/inspect_fixture`, { key: "alpha" })).resolves.toEqual({
        status: 200,
        body: { received: { key: "alpha" } }
      });
      await expect(postJSON(`${origin}/operations/inspect_fixture`, "bad")).resolves.toEqual({
        status: 400,
        body: { code: "bad_key", details: { field: "key" } }
      });
      await expect(postJSON(`${origin}/operations/inspect_fixture`, "fail")).resolves.toEqual({
        status: 500,
        body: { code: "source_failed" }
      });
      await expect(postJSON(`${origin}/operations/inspect_fixture`, "mutated")).resolves.toEqual({
        status: 500,
        body: { code: "operation_failed" }
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("maps a failed health check to the exact unhealthy response", async () => {
    const plugin = definePlugin({
      pluginId: "reference",
      displayName: "Reference",
      health: () => {
        throw new Error("source offline");
      },
      operations: {}
    });
    const server = await servePlugin(plugin, { host: "127.0.0.1", port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ status: "unhealthy" });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("aborts active handlers on lifecycle shutdown and rejects an already-aborted lifecycle", async () => {
    const lifecycle = new AbortController();
    let handlerSignal: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const plugin = definePlugin({
      pluginId: "reference",
      displayName: "Reference",
      operations: {
        inspect_fixture: {
          displayName: "Inspect fixture",
          timeoutMs: 1000,
          handler: async (_input, signal) => {
            handlerSignal = signal;
            entered();
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            return null;
          }
        }
      }
    });
    const server = await servePlugin(plugin, { host: "127.0.0.1", port: 0, signal: lifecycle.signal });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const request = fetch(`http://127.0.0.1:${address.port}/operations/inspect_fixture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null"
    }).catch(() => undefined);
    await started;
    const closed = once(server, "close");
    lifecycle.abort(new Error("shutdown"));
    await closed;
    await request;
    expect(handlerSignal?.aborted).toBe(true);

    const alreadyStopped = new AbortController();
    alreadyStopped.abort(new Error("stopped"));
    await expect(servePlugin(plugin, { host: "127.0.0.1", port: 0, signal: alreadyStopped.signal })).rejects.toThrow(
      "stopped"
    );
  });

  it("rejects non-JSON Plugin error details", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => new PluginInputError("invalid_input", cyclic as never)).toThrow("must be a JSON value");
    expect(() => new PluginFailureError("operation_failed", 1n as never)).toThrow("must be a JSON value");
  });

  it("transports repeated headers and binary bodies through the Source Gateway client", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe("manual");
      const request = JSON.parse(String(init?.body));
      expect(request).toEqual({
        method: "POST",
        path: "/binary",
        query: [
          ["tag", "one"],
          ["tag", "two"]
        ],
        headers: [
          ["x-id", "a"],
          ["x-id", "b"]
        ],
        body_base64: "AAH/"
      });
      return new Response(
        JSON.stringify({
          status: 201,
          headers: [
            ["x-id", "a"],
            ["x-id", "b"]
          ],
          body_base64: "AP8="
        }),
        {
          headers: { "Content-Type": "application/json" }
        }
      );
    });
    const client = new SourceGatewayClient("http://gateway.test", fetchMock);
    const response = await client.request("reference", {
      method: "POST",
      path: "/binary",
      query: [
        ["tag", "one"],
        ["tag", "two"]
      ],
      headers: [
        ["x-id", "a"],
        ["x-id", "b"]
      ],
      body: Uint8Array.of(0, 1, 255)
    });
    expect(response.status).toBe(201);
    expect([...response.body]).toEqual([0, 255]);
    expect(response.headers).toEqual([
      ["x-id", "a"],
      ["x-id", "b"]
    ]);
  });

  it("exposes only fixed Source Gateway failure categories", async () => {
    const client = new SourceGatewayClient(
      "http://gateway.test",
      vi.fn<typeof fetch>(
        async () =>
          new Response('{"code":"circuit_open"}', {
            status: 503,
            headers: { "Content-Type": "application/json" }
          })
      )
    );
    await expect(client.request("reference", { method: "GET", path: "/" })).rejects.toEqual(
      new SourceGatewayError("circuit_open")
    );
  });

  it("enforces the exact Source Gateway response and wire contract", async () => {
    const requestBodies: unknown[] = [];
    const client = new SourceGatewayClient(
      "http://gateway.test",
      vi.fn<typeof fetch>(async (_url, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        return new Response('{"status":204,"headers":[],"body_base64":""}', {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      })
    );
    await expect(
      client.request("reference", { method: "GET", path: "/", body: new Uint8Array() })
    ).resolves.toMatchObject({
      status: 204,
      body: new Uint8Array()
    });
    expect(requestBodies[0]).toMatchObject({ method: "GET", body_base64: null });
    await expect(client.request("reference", { method: "get", path: "/" })).rejects.toThrow("uppercase");

    for (const response of [
      new Response('{"status":99,"headers":[],"body_base64":""}', {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }),
      new Response('{"status":200,"headers":[],"body_base64":"%%%"}', {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }),
      new Response('{"code":"circuit_open"}', {
        status: 502,
        headers: { "Content-Type": "application/json" }
      }),
      new Response('{"status":200,"headers":[],"body_base64":""}', {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      })
    ]) {
      const invalid = new SourceGatewayClient(
        "http://gateway.test",
        vi.fn<typeof fetch>(async () => response)
      );
      await expect(invalid.request("reference", { method: "GET", path: "/" })).rejects.toThrow(TypeError);
    }
  });

  it("gets or creates a matching Tool Asset and rejects ownership conflicts", async () => {
    const entity = toolAsset("reference");
    const create = vi.fn(async () => entity);
    const missingClient = {
      entities: {
        get: vi.fn(async () => {
          throw new AtlasAPIError("missing", 404, {});
        }),
        create
      }
    };
    const controller = new AbortController();
    await expect(
      ensureToolAsset(missingClient, "reference", { alias: "Reference", signal: controller.signal })
    ).resolves.toEqual(entity);
    expect(create).toHaveBeenCalledWith(
      {
        entity_id: entity.entity_id,
        entity_type: "asset",
        subtype: "tool",
        alias: "Reference",
        components: { custom_plugin: { plugin_id: "reference" } }
      },
      { signal: controller.signal }
    );

    const conflicting = { ...entity, subtype: "vehicle" };
    await expect(
      ensureToolAsset({ entities: { get: vi.fn(async () => conflicting), create } }, "reference")
    ).rejects.toThrow("conflicts");
  });
});

async function postJSON(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

function toolAsset(pluginId: string): EntityResource {
  return {
    entity_id: deriveToolAssetId(pluginId),
    entity_type: "asset",
    subtype: "tool",
    alias: null,
    components: { custom_plugin: { plugin_id: pluginId } },
    created_at: "2026-08-28T12:00:00Z",
    updated_at: "2026-08-28T12:00:00Z",
    metadata: { version: 1 }
  };
}
