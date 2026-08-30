import {
  definePlugin,
  PluginInputError,
  servePlugin,
  SourceGatewayClient
} from "@the-drunken-coder/atlas-plugin-runtime";
import type { JSONValue } from "@the-drunken-coder/atlas-sdk";

const gateway = new SourceGatewayClient(process.env.ATLAS_SOURCE_GATEWAY_ORIGIN ?? "http://source-gateway:8080");

const reference = definePlugin({
  pluginId: "reference",
  displayName: "Reference Fixture",
  async health(signal: AbortSignal) {
    try {
      const response = await gateway.request(
        "reference",
        { method: "GET", path: "/fixture", query: [["key", "alpha"]] },
        { signal }
      );
      return response.status === 200;
    } catch {
      return false;
    }
  },
  operations: {
    inspect_fixture: {
      displayName: "Inspect fixture",
      timeoutMs: 5_000,
      async handler(input: JSONValue, signal: AbortSignal) {
        if (!isInspectInput(input)) throw new PluginInputError("invalid_key");
        const response = await gateway.request(
          "reference",
          { method: "GET", path: "/fixture", query: [["key", input.key]] },
          { signal }
        );
        if (response.status !== 200) throw new Error(`fixture source returned ${response.status}`);
        const source: unknown = JSON.parse(new TextDecoder().decode(response.body));
        if (!isFixtureResult(source)) throw new Error("fixture source returned an invalid response");
        return {
          value: source.value,
          provenance: { connector_id: "reference", source: "atlas_reference_fixture" },
          freshness: { observed_at: source.observed_at, stale: false }
        };
      }
    }
  }
});

function isInspectInput(value: JSONValue): value is { key: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof value.key === "string" &&
    value.key.length > 0
  );
}

function isFixtureResult(value: unknown): value is { value: JSONValue; observed_at: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    "observed_at" in value &&
    typeof value.observed_at === "string"
  );
}

await servePlugin(reference, { port: Number(process.env.PORT ?? "8080") });
