import { once } from "node:events";
import { Agent, request as httpRequest, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
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
    expect(plugin.manifest.operations[0]?.interaction).not.toBe(operation.interaction);
    expect(plugin.operations.search.interaction).toBe(plugin.manifest.operations[0]?.interaction);
    expect(Object.isFrozen(plugin.operations.search.interaction)).toBe(true);
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
      const manifest = await fetch(`${origin}/manifest?source=test`);
      expect(manifest.headers.get("Connection")).toBe("keep-alive");
      await expect(manifest.json()).resolves.toEqual(plugin.manifest);
      const invalidTarget = await fetch(`${origin}//`);
      expect(invalidTarget.headers.get("Connection")).toBe("keep-alive");
      expect({ status: invalidTarget.status, body: await invalidTarget.json() }).toEqual({
        status: 404,
        body: { code: "route_not_found" }
      });
      await expect(fetch(`${origin}/health`)).resolves.toMatchObject({
        status: 503
      });
      await expect(postJSON(`${origin}/operations/constructor`, null)).resolves.toEqual({
        status: 404,
        body: { code: "operation_not_found" }
      });
      await expect(postJSON(`${origin}/operations/missing`, null)).resolves.toEqual({
        status: 404,
        body: { code: "operation_not_found" }
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

  it("accepts absolute-form targets without aliasing malformed paths", async () => {
    const handler = vi.fn(() => null);
    const plugin = definePlugin({
      pluginId: "reference",
      displayName: "Reference",
      operations: {
        inspect: {
          displayName: "Inspect",
          timeoutMs: 1000,
          handler
        }
      }
    });
    const server = await servePlugin(plugin, { host: "127.0.0.1", port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    try {
      for (const [method, target, body] of [
        ["GET", "//elsewhere/manifest", ""],
        ["GET", "//elsewhere/health", ""],
        ["POST", "//elsewhere/operations/inspect", "null"],
        ["GET", "/\\elsewhere/manifest", ""],
        ["GET", "/elsewhere/../manifest", ""],
        ["GET", "/manifest#fragment", ""],
        ["GET", "http://plugin.invalid/\\elsewhere/manifest", ""],
        ["GET", "http://plugin.invalid/elsewhere/../manifest", ""],
        ["GET", "http://plugin.invalid/%2e%2e/manifest", ""],
        ["GET", "http://plugin.invalid/manifest#fragment", ""]
      ] as const) {
        await expect(
          rawHTTPRequest(
            address.port,
            [
              `${method} ${target} HTTP/1.1`,
              "Host: plugin.invalid",
              ...(body ? ["Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`] : []),
              "Connection: close",
              "",
              body
            ].join("\r\n")
          )
        ).resolves.toEqual({
          status: 404,
          connection: "close",
          body: { code: "route_not_found" }
        });
      }
      expect(handler).not.toHaveBeenCalled();

      await expect(
        rawHTTPRequest(
          address.port,
          "GET http://plugin.invalid/manifest?source=test HTTP/1.1\r\nHost: plugin.invalid\r\nConnection: close\r\n\r\n"
        )
      ).resolves.toEqual({ status: 200, connection: "close", body: plugin.manifest });
      await expect(
        rawHTTPRequest(
          address.port,
          "GET http://plugin.invalid/health HTTP/1.1\r\nHost: plugin.invalid\r\nConnection: close\r\n\r\n"
        )
      ).resolves.toEqual({ status: 200, connection: "close", body: { status: "ok" } });
      await expect(
        rawHTTPRequest(
          address.port,
          "POST http://plugin.invalid/operations/inspect HTTP/1.1\r\nHost: plugin.invalid\r\nContent-Type: application/json\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnull"
        )
      ).resolves.toEqual({ status: 200, connection: "close", body: null });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("retains framing headers beyond Node's default header collection ceiling", async () => {
    const handler = vi.fn(() => null);
    const plugin = definePlugin({
      pluginId: "reference",
      displayName: "Reference",
      operations: {
        inspect: {
          displayName: "Inspect",
          timeoutMs: 1000,
          handler
        }
      }
    });
    const server = await servePlugin(plugin, { host: "127.0.0.1", port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const padding = "X: a\r\n".repeat(999);
    try {
      const operationSocket = await connectTo(address.port);
      try {
        const closed = once(operationSocket, "close");
        const response = readRawHTTPResponse(operationSocket);
        operationSocket.write(
          `POST /operations/inspect HTTP/1.1\r\nHost: plugin.invalid\r\n${padding}Content-Length: 1048577\r\nConnection: keep-alive\r\n\r\n`
        );
        await expect(response).resolves.toEqual({
          status: 400,
          connection: "close",
          body: { code: "invalid_input" }
        });
        await closed;
      } finally {
        operationSocket.destroy();
      }

      const missingSocket = await connectTo(address.port);
      try {
        const closed = once(missingSocket, "close");
        const response = readRawHTTPResponse(missingSocket);
        missingSocket.write(
          `POST /missing HTTP/1.1\r\nHost: plugin.invalid\r\n${padding}Content-Length: 2\r\nConnection: keep-alive\r\n\r\nx`
        );
        await expect(response).resolves.toEqual({
          status: 404,
          connection: "close",
          body: { code: "route_not_found" }
        });
        await closed;
      } finally {
        missingSocket.destroy();
      }
      expect(handler).not.toHaveBeenCalled();
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("returns pipelined responses when an early request body is already complete", async () => {
    const handler = vi.fn(() => null);
    const plugin = definePlugin({
      pluginId: "reference",
      displayName: "Reference",
      operations: {
        inspect: {
          displayName: "Inspect",
          timeoutMs: 1000,
          handler
        }
      }
    });
    const server = await servePlugin(plugin, { host: "127.0.0.1", port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const socket = await connectTo(address.port);
    try {
      const responses = readRawHTTPResponses(socket, 2);
      const earlyBody = Buffer.alloc(1024 * 1024, "x");
      socket.end(
        Buffer.concat([
          Buffer.from(
            `POST /missing HTTP/1.1\r\nHost: plugin.invalid\r\nContent-Length: ${earlyBody.length}\r\nConnection: keep-alive\r\n\r\n`,
            "latin1"
          ),
          earlyBody,
          Buffer.from(
            "POST /operations/inspect HTTP/1.1\r\nHost: plugin.invalid\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnull",
            "latin1"
          )
        ])
      );
      await expect(responses).resolves.toEqual([
        {
          status: 404,
          connection: "keep-alive",
          body: { code: "route_not_found" }
        },
        {
          status: 200,
          connection: "close",
          body: null
        }
      ]);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      socket.destroy();
      server.close();
      await once(server, "close");
    }
  });

  it("returns pipelined responses after a fully consumed invalid operation body", async () => {
    const handler = vi.fn(() => null);
    const plugin = definePlugin({
      pluginId: "reference",
      displayName: "Reference",
      operations: {
        inspect: {
          displayName: "Inspect",
          timeoutMs: 1000,
          handler
        }
      }
    });
    const server = await servePlugin(plugin, { host: "127.0.0.1", port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const socket = await connectTo(address.port);
    try {
      const responses = readRawHTTPResponses(socket, 2);
      socket.end(
        "POST /operations/inspect HTTP/1.1\r\nHost: plugin.invalid\r\nContent-Length: 1\r\nConnection: keep-alive\r\n\r\n{" +
          "POST /operations/inspect HTTP/1.1\r\nHost: plugin.invalid\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnull"
      );
      await expect(responses).resolves.toEqual([
        {
          status: 400,
          connection: "keep-alive",
          body: { code: "invalid_input" }
        },
        {
          status: 200,
          connection: "close",
          body: null
        }
      ]);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      socket.destroy();
      server.close();
      await once(server, "close");
    }
  });

  it("fences pipelined operations before awaiting health", async () => {
    const handler = vi.fn(() => null);
    const health = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return true;
    });
    const plugin = definePlugin({
      pluginId: "reference",
      displayName: "Reference",
      health,
      operations: {
        inspect: {
          displayName: "Inspect",
          timeoutMs: 1000,
          handler
        }
      }
    });
    const server = await servePlugin(plugin, { host: "127.0.0.1", port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const socket = await connectTo(address.port);
    try {
      const closed = once(socket, "close");
      const response = readRawHTTPResponse(socket);
      socket.write(
        "GET /health HTTP/1.1\r\nHost: plugin.invalid\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n1\r\nx\r\n0\r\n\r\n" +
          "POST /operations/inspect HTTP/1.1\r\nHost: plugin.invalid\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnull"
      );
      await expect(response).resolves.toEqual({
        status: 200,
        connection: "close",
        body: { status: "ok" }
      });
      await closed;
      expect(health).toHaveBeenCalledOnce();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      server.close();
      await once(server, "close");
    }
  });

  it.each(["chunked", "oversized content-length"] as const)(
    "does not dispatch pipelined operations after committing a %s early response to close",
    async (framing) => {
      const handler = vi.fn(() => null);
      const plugin = definePlugin({
        pluginId: "reference",
        displayName: "Reference",
        operations: {
          inspect: {
            displayName: "Inspect",
            timeoutMs: 1000,
            handler
          }
        }
      });
      const server = await servePlugin(plugin, { host: "127.0.0.1", port: 0 });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server address");
      const socket = await connectTo(address.port);
      try {
        const closed = once(socket, "close").catch((error: NodeJS.ErrnoException) => {
          if (framing === "oversized content-length" && ["EPIPE", "ECONNRESET"].includes(error.code ?? "")) return [];
          throw error;
        });
        if (framing === "oversized content-length") socket.on("error", () => undefined);
        const response = readRawHTTPResponse(
          socket,
          framing === "oversized content-length" ? ["EPIPE", "ECONNRESET"] : []
        );
        const pipelinedOperation =
          "POST /operations/inspect HTTP/1.1\r\nHost: plugin.invalid\r\nContent-Length: 4\r\nConnection: keep-alive\r\n\r\nnull";
        const earlyRequest =
          framing === "chunked"
            ? "POST /missing HTTP/1.1\r\nHost: plugin.invalid\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n1\r\nx\r\n0\r\n\r\n"
            : "POST /missing HTTP/1.1\r\nHost: plugin.invalid\r\nContent-Length: 1048577\r\nConnection: keep-alive\r\n\r\n" +
              "x".repeat(1_048_577);
        socket.end(earlyRequest + pipelinedOperation);
        await expect(response).resolves.toEqual({
          status: 404,
          connection: "close",
          body: { code: "route_not_found" }
        });
        await closed;
        expect(handler).not.toHaveBeenCalled();
      } finally {
        socket.destroy();
        server.close();
        await once(server, "close");
      }
    }
  );

  it("rejects lossy JSON integers before dispatch", async () => {
    const handler = vi.fn((input: JSONValue) => input);
    const plugin = definePlugin({
      pluginId: "reference",
      displayName: "Reference",
      operations: {
        inspect: {
          displayName: "Inspect",
          timeoutMs: 1000,
          handler
        }
      }
    });
    const server = await servePlugin(plugin, { host: "127.0.0.1", port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const operationURL = `http://127.0.0.1:${address.port}/operations/inspect`;
    const postSerializedJSON = async (body: string) => {
      const response = await fetch(operationURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      await expect(postSerializedJSON('{"value":9007199254740993}')).resolves.toEqual({
        status: 400,
        body: { code: "invalid_input" }
      });
      expect(handler).not.toHaveBeenCalled();

      await expect(postSerializedJSON('{"value":9007199254740992}')).resolves.toEqual({
        status: 200,
        body: { value: 9007199254740992 }
      });
      await expect(postSerializedJSON('{"value":0.1}')).resolves.toEqual({
        status: 200,
        body: { value: 0.1 }
      });
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("fails safely when an exact operation result cannot be serialized without changing its value", async () => {
    const handler = vi.fn((input: JSONValue) => input);
    const plugin = definePlugin({
      pluginId: "reference",
      displayName: "Reference",
      operations: {
        echo: {
          displayName: "Echo",
          timeoutMs: 1000,
          handler
        }
      }
    });
    const server = await servePlugin(plugin, { host: "127.0.0.1", port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const operationURL = `http://127.0.0.1:${address.port}/operations/echo`;
    const postSerializedJSON = async (body: string) => {
      const response = await fetch(operationURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      return { status: response.status, body: await response.text() };
    };
    try {
      await expect(postSerializedJSON('{"value":18446744073709551616}')).resolves.toEqual({
        status: 500,
        body: '{"code":"operation_failed"}'
      });
      expect(handler).toHaveBeenCalledTimes(1);

      await expect(postSerializedJSON('{"value":9007199254740992}')).resolves.toEqual({
        status: 200,
        body: '{"value":9007199254740992}'
      });
      await expect(postSerializedJSON('{"value":0.1}')).resolves.toEqual({
        status: 200,
        body: '{"value":0.1}'
      });
      await expect(postSerializedJSON('{"value":"ordinary"}')).resolves.toEqual({
        status: 200,
        body: '{"value":"ordinary"}'
      });
      expect(handler).toHaveBeenCalledTimes(4);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("distinguishes malformed request bodies from handler exceptions", async () => {
    const handler = vi.fn((input: JSONValue) => {
      if (input === "syntax") throw new SyntaxError("handler parse failed");
      if (input === "range") throw new RangeError("handler range failed");
      if (input === "revoked") {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        throw proxy;
      }
      if (input === "spoofed_input") throw Object.create(PluginInputError.prototype);
      if (input === "mutated_input") {
        const error = new PluginInputError("bad_key");
        Object.defineProperty(error, "pluginCode", { value: "INVALID" });
        throw error;
      }
      if (input === "mutated_failure") {
        const error = new PluginFailureError("source_failed");
        Object.defineProperty(error, "pluginCode", { value: 1 });
        throw error;
      }
      return null;
    });
    const plugin = definePlugin({
      pluginId: "reference",
      displayName: "Reference",
      operations: {
        inspect_fixture: {
          displayName: "Inspect fixture",
          timeoutMs: 1000,
          handler
        }
      }
    });
    const server = await servePlugin(plugin, { host: "127.0.0.1", port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const operationURL = `http://127.0.0.1:${address.port}/operations/inspect_fixture`;
    const keepAliveAgent = new Agent({ keepAlive: true });
    try {
      const malformed = await fetch(operationURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{"
      });
      expect({ status: malformed.status, body: await malformed.json() }).toEqual({
        status: 400,
        body: { code: "invalid_input" }
      });
      expect(handler).not.toHaveBeenCalled();

      await expect(
        incompleteJSONRequest(server, operationURL, {
          method: "POST",
          contentLength: 1024 * 1024 + 1
        })
      ).resolves.toEqual({
        status: 400,
        connection: "close",
        body: { code: "invalid_input" },
        connectionClosed: true
      });
      expect(handler).not.toHaveBeenCalled();

      const connectionClosed = new Promise<void>((resolve) => {
        server.once("connection", (socket) => socket.once("close", resolve));
      });
      const oversized = await new Promise<{
        status: number | undefined;
        connection: string | undefined;
        body: unknown;
      }>((resolve, reject) => {
        const request = httpRequest(
          operationURL,
          {
            method: "POST",
            agent: keepAliveAgent,
            headers: {
              "Content-Type": "application/json",
              Connection: "keep-alive"
            },
            signal: AbortSignal.timeout(2000)
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () => {
              resolve({
                status: response.statusCode,
                connection: response.headers.connection,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
              });
            });
          }
        );
        request.once("error", reject);
        request.write('"');
        const fragment = Buffer.alloc(256, "a");
        for (let index = 0; index < 4096; index += 1) request.write(fragment);
      });
      expect(oversized).toEqual({
        status: 400,
        connection: "close",
        body: { code: "invalid_input" }
      });
      await expect(
        Promise.race([
          connectionClosed.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))
        ])
      ).resolves.toBe(true);
      expect(handler).not.toHaveBeenCalled();

      const invalidUTF8 = await fetch(operationURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: Buffer.from([0x22, 0xc0, 0xaf, 0x22])
      });
      expect({ status: invalidUTF8.status, body: await invalidUTF8.json() }).toEqual({
        status: 400,
        body: { code: "invalid_input" }
      });
      expect(handler).not.toHaveBeenCalled();

      await expect(postJSON(operationURL, "syntax")).resolves.toEqual({
        status: 500,
        body: { code: "operation_failed" }
      });
      await expect(postJSON(operationURL, "range")).resolves.toEqual({
        status: 500,
        body: { code: "operation_failed" }
      });
      await expect(postJSON(operationURL, "revoked")).resolves.toEqual({
        status: 500,
        body: { code: "operation_failed" }
      });
      for (const input of ["spoofed_input", "mutated_input", "mutated_failure"]) {
        await expect(postJSON(operationURL, input)).resolves.toEqual({
          status: 500,
          body: { code: "operation_failed" }
        });
      }
      await expect(fetch(`http://127.0.0.1:${address.port}/health`)).resolves.toMatchObject({ status: 200 });
    } finally {
      keepAliveAgent.destroy();
      server.close();
      await once(server, "close");
    }
  });

  it("closes incomplete request bodies after early responses", async () => {
    const plugin = definePlugin({
      pluginId: "reference",
      displayName: "Reference",
      operations: {}
    });
    const server = await servePlugin(plugin, { host: "127.0.0.1", port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      await expect(
        incompleteJSONRequest(server, `${origin}//`, {
          method: "GET",
          contentLength: 1
        })
      ).resolves.toEqual({
        status: 404,
        connection: "close",
        body: { code: "route_not_found" },
        connectionClosed: true
      });

      for (const [method, path, status, body] of [
        ["POST", "/missing", 404, { code: "route_not_found" }],
        ["POST", "/operations/missing", 404, { code: "operation_not_found" }],
        ["GET", "/manifest", 200, plugin.manifest],
        ["GET", "/health", 200, { status: "ok" }]
      ] as const) {
        await expect(
          incompleteJSONRequest(server, `${origin}${path}`, {
            method,
            contentLength: 2,
            partialBody: "x"
          })
        ).resolves.toEqual({ status, connection: "close", body, connectionClosed: true });
      }
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("dispatches a deliberately declared constructor operation", async () => {
    const constructorHandler = vi.fn(() => "declared");
    const withConstructor = definePlugin({
      pluginId: "reference",
      displayName: "Reference",
      operations: {
        constructor: {
          displayName: "Constructor",
          timeoutMs: 1000,
          handler: constructorHandler
        }
      }
    });
    const server = await servePlugin(withConstructor, { host: "127.0.0.1", port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    try {
      await expect(postJSON(`http://127.0.0.1:${address.port}/operations/constructor`, null)).resolves.toEqual({
        status: 200,
        body: "declared"
      });
      expect(constructorHandler).toHaveBeenCalledOnce();
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

  it.each([
    ["circuit_open", 503],
    ["admission_timeout", 503]
  ] as const)("exposes fixed Source Gateway failure %s", async (failureCode, status) => {
    const client = new SourceGatewayClient(
      "http://gateway.test",
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ code: failureCode }), {
            status,
            headers: { "Content-Type": "application/json" }
          })
      )
    );
    await expect(client.request("reference", { method: "GET", path: "/" })).rejects.toEqual(
      new SourceGatewayError(failureCode)
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

async function incompleteJSONRequest(
  server: Server,
  url: string,
  options: { method: string; contentLength: number; partialBody?: string }
) {
  const agent = new Agent({ keepAlive: true });
  let request: ReturnType<typeof httpRequest> | undefined;
  const connectionClosed = new Promise<void>((resolve) => {
    server.once("connection", (socket) => socket.once("close", resolve));
  });
  try {
    const response = await new Promise<{ status: number | undefined; connection: string | undefined; body: unknown }>(
      (resolve, reject) => {
        request = httpRequest(
          url,
          {
            method: options.method,
            agent,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": options.contentLength,
              Connection: "keep-alive"
            },
            signal: AbortSignal.timeout(2000)
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () => {
              resolve({
                status: response.statusCode,
                connection: response.headers.connection,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
              });
            });
          }
        );
        request.once("error", reject);
        if (options.partialBody === undefined) request.flushHeaders();
        else request.write(options.partialBody);
      }
    );
    const connectionClosedPromptly = await Promise.race([
      connectionClosed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))
    ]);
    return { ...response, connectionClosed: connectionClosedPromptly };
  } finally {
    request?.destroy();
    agent.destroy();
  }
}

async function connectTo(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const fail = (error: Error) => reject(error);
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.off("error", fail);
      resolve(socket);
    });
  });
}

async function rawHTTPRequest(port: number, request: string) {
  const socket = await connectTo(port);
  try {
    const response = readRawHTTPResponse(socket);
    socket.end(request);
    return await response;
  } finally {
    socket.destroy();
  }
}

type RawHTTPResponse = { status: number; connection: string | undefined; body: unknown };

function readRawHTTPResponse(socket: Socket, ignoredSocketErrors: readonly string[] = []): Promise<RawHTTPResponse> {
  return readRawHTTPResponses(socket, 1, ignoredSocketErrors).then(([response]) => {
    if (!response) throw new Error("missing response");
    return response;
  });
}

function readRawHTTPResponses(
  socket: Socket,
  count: number,
  ignoredSocketErrors: readonly string[] = []
): Promise<RawHTTPResponse[]> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let offset = 0;
    const responses: RawHTTPResponse[] = [];
    const cleanup = () => {
      socket.off("data", receive);
      socket.off("error", fail);
      socket.off("close", close);
    };
    const fail = (error: NodeJS.ErrnoException) => {
      if (error.code && ignoredSocketErrors.includes(error.code)) return;
      cleanup();
      reject(error);
    };
    const close = () => fail(new Error("connection closed before the complete response"));
    const receive = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      while (responses.length < count) {
        const headerEnd = bytes.indexOf("\r\n\r\n", offset);
        if (headerEnd < 0) return;
        const headers = bytes.subarray(offset, headerEnd).toString("latin1");
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(headers)?.[1]);
        const contentLength = Number(/(?:^|\r\n)Content-Length: (\d+)/i.exec(headers)?.[1]);
        if (!Number.isInteger(status) || !Number.isInteger(contentLength)) {
          fail(new Error(`invalid response headers: ${headers}`));
          return;
        }
        const bodyEnd = headerEnd + 4 + contentLength;
        if (bytes.length < bodyEnd) return;
        const connection = /(?:^|\r\n)Connection: ([^\r\n]+)/i.exec(headers)?.[1];
        const body: unknown = JSON.parse(bytes.subarray(headerEnd + 4, bodyEnd).toString("utf8"));
        responses.push({ status, connection, body });
        offset = bodyEnd;
      }
      cleanup();
      resolve(responses);
    };
    socket.on("data", receive);
    socket.on("error", fail);
    socket.once("close", close);
  });
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
