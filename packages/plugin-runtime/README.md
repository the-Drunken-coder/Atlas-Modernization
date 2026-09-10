# Atlas Plugin Runtime

`@the-drunken-coder/atlas-plugin-runtime` is the supported TypeScript authoring kit for trusted Atlas Plugins. The HTTP wire contract remains language-neutral; this package derives the private manifest, serves the three private routes, carries cancellation into Operation handlers, and provides clients for the Atlas Source Gateway and Plugin Tool Assets.

## Define and serve a Plugin

```ts
import {
  definePlugin,
  PluginInputError,
  servePlugin,
  SourceGatewayClient
} from "@the-drunken-coder/atlas-plugin-runtime";
import type { JSONValue } from "@the-drunken-coder/atlas-sdk";

const sources = new SourceGatewayClient("http://source-gateway:8080");

const plugin = definePlugin({
  pluginId: "building_info",
  displayName: "Building Information",
  operations: {
    inspect_building: {
      displayName: "Inspect building",
      timeoutMs: 5000,
      async handler(input: JSONValue, signal: AbortSignal) {
        if (!isBuildingInput(input)) throw new PluginInputError("invalid_location");
        const response = await sources.request(
          "openstreetmap",
          { method: "GET", path: "/lookup", query: [["id", input.id]] },
          { signal }
        );
        return { status: response.status };
      }
    }
  }
});

await servePlugin(plugin, { port: 8080 });
```

`definePlugin` validates lowercase underscore-only Plugin and Operation identifiers, display names, and Operation timeouts. Its private `/manifest` response includes the fixed `core_to_plugin_protocol_major` contract field. The private field stays outside the generated Atlas Protocol `PluginManifest`; Core validates it and projects the remaining fields into the public descriptor. Setting `taskable: true` adds the derived Tool Asset ID to the manifest. `servePlugin` exposes only `GET /manifest`, `GET /health`, and `POST /operations/{operation_id}`.

Throw `PluginInputError` for a handled input rejection and `PluginFailureError` for a handled Plugin failure. Both accept the private error code and optional JSON details. Unexpected exceptions become the fixed `operation_failed` private failure and are not exposed to Core callers.

## Source Gateway

`SourceGatewayClient.request` preserves repeated query and header tuples and transports request and response bodies as `Uint8Array`. It adds the fixed `plugin_to_source_gateway_protocol_major` field to every private request. Pass the Operation or Task `AbortSignal`; cancellation stops the private Gateway request. Gateway failures throw `SourceGatewayError` with one of the seven fixed failure codes from the Plugin architecture. The current values are exported as `CORE_TO_PLUGIN_PROTOCOL_MAJOR` and `PLUGIN_TO_SOURCE_GATEWAY_PROTOCOL_MAJOR` for release metadata generation.

## Tool Assets

`deriveToolAssetId(pluginId)` implements the Protocol derivation vector. `ensureToolAsset(client, pluginId)` gets or creates the ordinary Atlas Tool Asset and rejects any existing Entity whose type, subtype, or `custom_plugin.plugin_id` ownership marker conflicts. A taskable Plugin should ensure its Tool Asset before registering the Asset runtime.

## Checks

From the repository root:

```sh
npm run lint --workspace @the-drunken-coder/atlas-plugin-runtime
npm run format:check --workspace @the-drunken-coder/atlas-plugin-runtime
npm test --workspace @the-drunken-coder/atlas-plugin-runtime
npm run build:plugin-runtime
```
