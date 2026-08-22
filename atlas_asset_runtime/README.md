# Atlas Asset Runtime

A small Node.js runtime for Atlas Assets. It registers a fresh process with Core, establishes safe state, publishes a fixed Command Manifest, consumes runtime-scoped Task delivery, and records lifecycle changes through the Atlas SDK.

```ts
import { AtlasAssetRuntime } from "@the-drunken-coder/atlas-asset-runtime";
import { AtlasClient, type CommandManifest } from "@the-drunken-coder/atlas-sdk";

const client = new AtlasClient({
  baseUrl: "http://127.0.0.1:8000",
  apiKey: process.env.ATLAS_API_KEY
});

const manifest: CommandManifest = [
  {
    command: "example.inspect",
    description: "Inspect the current location with the onboard sensor.",
    scheduling: "queued",
    supports_cancel: true,
    supports_progress: true
  }
];

const runtime = new AtlasAssetRuntime(client, {
  entityId: "asset-1",
  manifest,
  handlers: {
    "example.inspect": async ({ signal, reportProgress }) => {
      signal.throwIfAborted();
      await reportProgress(0.5);
      return { observations: 3 };
    }
  },
  checkIn: ({ signal }) => {
    signal.throwIfAborted();
    return {
      status: "online",
      telemetry: { latitude: 38.8977, longitude: -77.0365 }
    };
  },
  onError: console.error
});

await runtime.start();
```

`start()` completes the Protocol handshake, creates a new runtime ID, runs each execution module's safety barrier, and publishes the manifest as its final startup step. The running process polls only its runtime delivery endpoint and accepted Task IDs, so it does not hydrate the global Atlas dataset. If startup becomes uncertain after registration, the runtime asks Core to deactivate the allocated runtime ID before returning the startup error. `stop()` aborts local handlers, waits for in-flight work to settle, and then deactivates that runtime in Core. Local state always reaches `stopped`; the returned promise rejects when Core deactivation could not be confirmed.

Queued Commands enter a provisional queue in Core's authoritative order before acknowledgement and use one serial executor. Immediate Commands start independently and are processed before queued acknowledgements. The runtime confirms Start before invoking a physical handler. It retries exact idempotent lifecycle writes after transport failures, HTTP 408, 429, and server errors, then consults the authoritative Task after permanent responses. AtlasClient-compatible implementations must mark ambiguous network failures with `AtlasTransportError` and HTTP failures with `AtlasAPIError`; the runtime recognizes their stable `code` values across package copies. The five-second runtime reconciliation reads accepted Tasks eight at a time, catches new immediate work inside Core's start window, and aborts a matching handler when Core reports a terminal Task, including cancellation and runtime fencing. Handlers and check-in report callbacks must observe their signal, finish any physical cleanup, and settle; `stop()` waits for them before another runtime can start. Throw `AssetTaskFailure("precondition_failed", message)` when a physical or operational precondition prevents execution. Other handler errors become `execution_failed`. Check-in reports telemetry and observed state only. It never carries or retrieves Tasks.

An Asset with an empty manifest and no handlers is telemetry-only. The runtime does not provide plugins, deployment tooling, durable offline writes, or exact-once execution. See [`docs/atlas-asset-runtime/`](../docs/atlas-asset-runtime/) for the full lifecycle and safety contract.

The package is configured for public npm access but is not published automatically. Publish its pinned `@the-drunken-coder/atlas-sdk@0.1.0` dependency before publishing runtime version `0.1.0`.
