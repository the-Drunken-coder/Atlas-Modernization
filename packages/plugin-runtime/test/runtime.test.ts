import { once } from "node:events";
import { AtlasAPIError, type EntityResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  definePlugin,
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
    expect(() => definePlugin({ pluginId: "bad-id", displayName: "Bad", operations: {} })).toThrow(TypeError);
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

  it("transports repeated headers and binary bodies through the Source Gateway client", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
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
      vi.fn<typeof fetch>(async () => new Response('{"code":"circuit_open"}', { status: 503 }))
    );
    await expect(client.request("reference", { method: "GET", path: "/" })).rejects.toEqual(
      new SourceGatewayError("circuit_open")
    );
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
    await expect(ensureToolAsset(missingClient, "reference", { alias: "Reference" })).resolves.toEqual(entity);
    expect(create).toHaveBeenCalledWith({
      entity_id: entity.entity_id,
      entity_type: "asset",
      subtype: "tool",
      alias: "Reference",
      components: { custom_plugin: { plugin_id: "reference" } }
    });

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
