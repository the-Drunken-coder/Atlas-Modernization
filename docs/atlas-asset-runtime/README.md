# Atlas asset runtime

The Atlas asset runtime (`atlas_asset_runtime/`) is the small Node-side loop for code that represents an Atlas entity. It uses the public Atlas SDK to perform compact entity check-ins, publish telemetry, receive pending command tasks, and report task progress or completion.

The runtime is deliberately not an operating system. The caller owns the process, configuration, Atlas client, entity creation, hardware integration, and deployment. The runtime owns only the repeated asset lifecycle that is useful across those hosts.

## Package boundary

`@the-drunken-coder/atlas-asset-runtime` is a TypeScript/ESM package for Node 24 or newer. It depends on `@the-drunken-coder/atlas-sdk` as a normal package and imports only public SDK exports. It does not bundle a private SDK copy.

The first repository consumer is `atlas_simulations/`. That migration proves the API against an existing scenario; it is not evidence that the old scenarios already contained a reusable handshake, reconnect, feed, or task-dispatch loop. They did not.

## Public lifecycle

Create an `AtlasAssetRuntime` with an SDK-backed client, the ID of an entity that already exists, optional command handlers, and an optional function that returns the asset's current check-in report. A runtime with no handlers is a valid telemetry-only asset. `start()` performs the protocol handshake and one complete check-in cycle before resolving, then leaves a background check-in loop running. `stop()` stops background scheduling, rejects new cycles while shutdown is in progress, signals background handlers, waits for in-flight manual or background work, and is safe to call more than once. Restarting performs a fresh protocol handshake.

```ts
import { AtlasAssetRuntime } from "@the-drunken-coder/atlas-asset-runtime";
import { AtlasClient } from "@the-drunken-coder/atlas-sdk";

const client = new AtlasClient({
  baseUrl: "http://127.0.0.1:8000",
  apiKey: process.env.ATLAS_API_KEY
});

const runtime = new AtlasAssetRuntime(client, {
  entityId: "asset-1",
  checkIn: () => ({
    status: "online",
    telemetry: { latitude: 38.8977, longitude: -77.0365 }
  }),
  handlers: {
    move: async ({ reportProgress }) => {
      await reportProgress(50, "en route");
      return { arrived: true };
    }
  },
  onError: console.error
});

await runtime.start();
```

The runtime exposes four states: `stopped`, `starting`, `running`, and `stopping`. Callers can also request a complete cycle directly with `checkIn()`.

Each cycle:

1. Gets the latest telemetry/status/components report from the caller.
2. Calls the entity check-in endpoint with compact task fields, pending-task filtering, and a bounded page size.
3. Drains every returned task page in order.
4. Dispatches command tasks sequentially.

Cycles do not overlap, and task handlers do not run concurrently. The runtime forwards caller-owned components as provided; it does not inject or overwrite an entity task catalog.

## Task handling

A recognized command task is acknowledged before its handler runs. The handler receives the minimal task, an abort signal, and a function for reporting progress. Returning a JSON object completes the task with that object as its result; returning nothing completes it without a result. Throwing fails the task.

Tasks without a command are ignored. A command that has no registered handler is failed so it does not remain silently pending.

Stopping or aborting the runtime does not report an active task as failed merely because local shutdown interrupted it. Atlas may therefore retain an acknowledged task for later operator or asset recovery.

## Failure and delivery semantics

Every failed background cycle is surfaced through the caller's error callback. The loop then retries with an increasing delay capped at an internal maximum and returns to the normal check-in interval after a successful cycle. Retry policy is intentionally internal in v1 rather than exposed as configuration.

The runtime does **not** promise exactly-once task execution. A process crash after acknowledgement can leave a task acknowledged without a result, and restarting a process does not provide durable execution recovery. Handlers must be written with those limits in mind.

## Explicit v1 boundaries

V1 does not include:

- change-feed consumption or global SDK hydration;
- entity creation or registration;
- a durable task journal, offline outbox, or crash recovery;
- concurrent task execution;
- a plugin system, scaffolding CLI, deployment manager, or bundled host runtime;
- configurable retry/backoff policy;
- Python, Bun, or multi-language bindings.

These are not reserved extension points. Add one only when a real asset integration demonstrates the need.

## Repository checks

Install once from the repository root with Node 24:

```bash
npm ci
npm run build:asset-runtime
npm run lint --workspace @the-drunken-coder/atlas-asset-runtime
npm run format:check --workspace @the-drunken-coder/atlas-asset-runtime -- --since=origin/main
npm run typecheck --workspace @the-drunken-coder/atlas-asset-runtime
npm test --workspace @the-drunken-coder/atlas-asset-runtime
npm run test:package --workspace @the-drunken-coder/atlas-asset-runtime
```

The packed-consumer smoke verifies the public package boundary from clean tarballs. The package is configured for public npm access, but this repository does not automate npm publication. Publish the pinned `@the-drunken-coder/atlas-sdk@0.1.0` dependency first, then publish runtime version `0.1.0` as a separate explicit release action.
