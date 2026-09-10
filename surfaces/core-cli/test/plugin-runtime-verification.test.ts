import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { type PluginRelease, parsePluginRelease } from "../src/plugin-distribution.js";
import { assertPluginRuntime, PLUGIN_RUNTIME_PROBE_SCRIPT } from "../src/plugin-runtime-verification.js";

const operation = {
  operation_id: "search_buildings",
  display_name: "Search buildings",
  timeout_ms: 5_000,
  interaction: { kind: "map_area" }
};

function releaseDocument(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: 1,
      plugin_id: "building_scan",
      version: "0.2.0",
      display_name: "Building Scan",
      lifecycle: "query_only",
      image: `ghcr.io/the-drunken-coder/atlas-building-scan@sha256:${"a".repeat(64)}`,
      core_to_plugin_protocol_major: 1,
      plugin_to_source_gateway_protocol_major: 1,
      atlas_protocol_revision: null,
      interactions: ["map_area"],
      source_connector: null
    })
  );
}

function release(): PluginRelease {
  return parsePluginRelease(releaseDocument());
}

function runtimeManifest() {
  return {
    plugin_id: "building_scan",
    display_name: "Building Scan",
    core_to_plugin_protocol_major: 1,
    operations: [operation]
  };
}

function responses(manifest: unknown = runtimeManifest()): unknown[] {
  return [
    { status: 200, body: JSON.stringify(manifest) },
    { status: 200, body: JSON.stringify({ status: "ok" }) },
    { status: 404, body: JSON.stringify({ code: "route_not_found" }) }
  ];
}

describe("Plugin runtime verification", () => {
  it("bounds probe response bodies before emitting partial output", async () => {
    let cancelled = false;
    let oversizedBody: ReadableStream<Uint8Array>;
    oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array((1 << 20) | 1));
      },
      cancel() {
        cancelled = true;
      }
    });
    const body = new TextEncoder().encode("{}");
    const calls: string[] = [];
    const output: string[] = [];
    const processState: { exitCode?: number; stdout: { write(value: string): void } } = {
      stdout: { write: (value) => output.push(value) }
    };
    const fetch = async (input: string): Promise<{ status: number; body: ReadableStream<Uint8Array> }> => {
      calls.push(input);
      if (input.endsWith("/health")) return { status: 200, body: oversizedBody };
      return {
        status: input.endsWith("/manifest") ? 200 : 404,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          }
        })
      };
    };

    await runInNewContext(PLUGIN_RUNTIME_PROBE_SCRIPT, {
      AbortSignal,
      Buffer,
      fetch,
      process: processState,
      Uint8Array
    });

    expect(calls).toHaveLength(3);
    expect(cancelled).toBe(true);
    expect(processState.exitCode).toBe(1);
    expect(output).toEqual([]);
  });

  it("accepts the runtime manifest and health fixture", () => {
    expect(() => assertPluginRuntime(release(), responses())).not.toThrow();
  });

  it("accepts multiple operations advertising the same interaction kind", () => {
    const secondOperation = { ...operation, operation_id: "zoom_buildings" };
    expect(() =>
      assertPluginRuntime(release(), responses({ ...runtimeManifest(), operations: [operation, secondOperation] }))
    ).not.toThrow();
  });

  it("rejects a runtime tool asset identity even when its value is correctly derived", () => {
    const manifest = { ...runtimeManifest(), tool_asset_id: "plugin__9p5CV1JPbrDEGXjxS4_gAkKcVzHPir5XGMgdu02IlE" };
    expect(() => assertPluginRuntime(release(), responses(manifest))).toThrow(/tool_asset_id|query.only/i);
  });

  it.each([
    ["identity", { plugin_id: "other", display_name: "Building Scan", core_to_plugin_protocol_major: 1 }],
    ["protocol major", { plugin_id: "building_scan", display_name: "Building Scan", core_to_plugin_protocol_major: 2 }],
    ["interactions", { ...runtimeManifest(), operations: [{ ...operation, interaction: undefined }] }],
    ["tool asset", { ...runtimeManifest(), tool_asset_id: "plugin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }]
  ])("rejects a signed release mismatch in the %s", (_label, manifest) => {
    expect(() => assertPluginRuntime(release(), responses(manifest))).toThrow(/manifest|interaction|asset|identity/i);
  });

  it.each([
    [
      "unsorted operations",
      [
        { ...operation, operation_id: "z" },
        { ...operation, operation_id: "a" }
      ]
    ],
    ["invalid timeout", [{ ...operation, timeout_ms: 25_001 }]],
    ["unknown operation field", [{ ...operation, unexpected: true }]],
    ["invalid interaction", [{ ...operation, interaction: { kind: "other" } }]]
  ])("rejects %s", (_label, operations) => {
    expect(() => assertPluginRuntime(release(), responses({ ...runtimeManifest(), operations }))).toThrow(/Operation/i);
  });

  it.each([
    [
      "health body",
      [
        { status: 200, body: JSON.stringify(runtimeManifest()) },
        { status: 200, body: JSON.stringify({ status: "bad" }) },
        responses()[2]
      ]
    ],
    ["unknown route code", [responses()[0], responses()[1], { status: 404, body: JSON.stringify({ code: "wrong" }) }]],
    [
      "response shape",
      [{ status: 200, body: JSON.stringify(runtimeManifest()), extra: true }, responses()[1], responses()[2]]
    ]
  ])("rejects an invalid %s", (_label, fixture) => {
    expect(() => assertPluginRuntime(release(), fixture)).toThrow(/Plugin/i);
  });
});
