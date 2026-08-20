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
  checkIn: () => ({
    status: "online",
    telemetry: { latitude: 38.8977, longitude: -77.0365 }
  }),
  onError: console.error
});

await runtime.start();
```

`start()` completes the Protocol handshake, creates a new runtime ID, runs each execution module's safety barrier, and publishes the manifest as its final startup step. The running process polls only its runtime delivery endpoint and accepted Task IDs, so it does not hydrate the global Atlas dataset. `stop()` aborts local handlers and waits for in-flight work to settle.

Queued Commands use one serial executor. Immediate Commands start independently. The five-second runtime reconciliation catches new immediate work inside Core's start window and aborts a matching handler when Core reports a terminal Task, including cancellation and runtime fencing. Handlers must observe that signal, finish any physical cleanup, and settle; `stop()` waits for them before another runtime can start. Throw `AssetTaskFailure("precondition_failed", message)` when a physical or operational precondition prevents execution. Other handler errors become `execution_failed`. Check-in reports telemetry and observed state only. It never carries or retrieves Tasks.

An Asset with an empty manifest and no handlers is telemetry-only. The runtime does not provide plugins, deployment tooling, durable offline writes, or exact-once execution. See [`docs/atlas-asset-runtime/`](../docs/atlas-asset-runtime/) for the full lifecycle and safety contract.

The package is configured for public npm access but is not published automatically. Publish its pinned `@the-drunken-coder/atlas-sdk@0.1.0` dependency before publishing runtime version `0.1.0`.
