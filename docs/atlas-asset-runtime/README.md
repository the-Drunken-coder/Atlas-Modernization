# Atlas asset runtime

The Atlas asset runtime (`atlas_asset_runtime/`) is the small Node-side execution loop for a process that represents an Atlas Asset. It registers a fresh process fence, establishes safe state, publishes a fixed Command Manifest, consumes runtime-scoped Task delivery, executes handlers, and reports telemetry and Task lifecycle changes through the public Atlas SDK.

The caller owns process configuration, Entity creation, hardware integration, Command handlers, execution modules, and deployment. The runtime owns only the shared registration, delivery, lifecycle, and check-in behavior.

## Package boundary

`@the-drunken-coder/atlas-asset-runtime` is a TypeScript/ESM package for Node 24 or newer. It depends on `@the-drunken-coder/atlas-sdk` through public exports and does not bundle a private SDK copy.

## Public lifecycle

Every advertised Command requires one handler, and every handler must appear in the manifest. A telemetry-only Asset uses the empty manifest and no handlers.

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

`start()` performs the Protocol handshake, creates a fresh `runtime_id`, begins Core registration, and runs every execution module's safety barrier. Publishing the manifest is the final fallible startup step. If startup fails after allocation, the runtime compensates by asking Core to deactivate that exact runtime ID. If Core cannot confirm that compensation, `start()` remains `stopping`, retains the runtime ID, and throws an `AggregateError`; call `stop()` to retry deactivation. The running process then polls only its runtime delivery endpoint and accepted Task IDs instead of hydrating the global Atlas dataset. `stop()` aborts local work, waits for any in-flight startup request and tracked local cleanup to settle, then asks Core to deactivate the runtime. If Core deactivation cannot be confirmed, the runtime remains `stopping`, retains the allocated runtime ID, and rejects so the caller can retry `stop()`. It reaches `stopped` only after Core confirms deactivation. Task handlers and check-in report callbacks receive that cooperative cancellation signal and must settle when it aborts. A later `start()` creates a new runtime ID.

The runtime exposes `stopped`, `starting`, `running`, and `stopping` states. A failed `start()` may remain `stopping` until a follow-up `stop()` confirms deactivation. `checkIn()` remains available for a caller-requested telemetry cycle; the background loop calls the same method at the configured interval. Check-in never carries or retrieves Tasks.

## Safety barrier

Execution modules isolate the physical procedure needed to establish safe state:

```ts
import type { ExecutionModule } from "@the-drunken-coder/atlas-asset-runtime";

const mobility: ExecutionModule = {
  id: "mobility",
  async establishSafeState({ signal }) {
    signal.throwIfAborted();
    await haltAndConfirm();
  }
};
```

Pass modules through `executionModules`. Core never sees module IDs or procedures. If any module fails, registration does not become ready and no Task is delivered.

## Task execution

Core remains authoritative for Task eligibility and ordering. The runtime asks only for work released to its current runtime ID.

- Queued Tasks enter the local queue in authoritative `created_at`, `task_id` order before acknowledgement, then execute through one serial executor. A lost acknowledgement response cannot drop or reorder them.
- Immediate Commands start independently and may overlap queued or other immediate work. Delivered immediate work is processed before queued acknowledgements.
- Progress is available only when the manifest declares `supports_progress` and is reported from `0` to `1`.
- A handler return value becomes Task output. Returning nothing completes without output. A thrown error fails the Task with `execution_failed`.
- A handler throws `AssetTaskFailure("precondition_failed", message)` when a physical or operational precondition prevents execution.
- A pending unsupported Command is failed with `unsupported_command` instead of remaining silently pending.
- The runtime confirms Start before invoking a handler. Exact lifecycle writes retry after transport failures, HTTP 408, 429, and server errors. Permanent responses are reconciled against a fresh authoritative Task instead of retried forever.
- Independent five-second loops request new delivery and refresh accepted Task IDs with at most eight concurrent reads. A slow or failed status refresh cannot delay delivery, block another refresh, or consume an immediate Task's start window.
- A terminal Task state from Core aborts the matching local handler. This includes cancellation and failure caused by runtime fencing. The runtime does not issue a second cancellation or abort API call.
- Handlers must observe their `AbortSignal`, finish physical cleanup, and settle. Runtime shutdown waits for every active handler before a later `start()` can establish a new safety barrier.

Process restart recovery is explicit. A new registration first installs the replacement runtime as unready, then fails the previous runtime's nonterminal Tasks with `asset_restarted` in committed batches of 100. An exact repeated Begin continues an interrupted drain, and Core refuses Ready until no stale nonterminal Task remains. Temporary delivery failures keep the same runtime ID and are retried by the delivery loop; they are not process restarts.

## Boundaries

The package does not provide Entity creation, a hardware plugin system, durable local execution journals, deployment management, or its own retry queue. It also does not define Command semantics. Commands and their schemas, operator input, handlers, and any special Core policy are added together through the Protocol authoring process.

## Repository checks

Install once from the repository root with Node 24:

```bash
npm ci
npm run build:asset-runtime
npm run lint --workspace @the-drunken-coder/atlas-asset-runtime
npm run format:check --workspace @the-drunken-coder/atlas-asset-runtime
npm run typecheck --workspace @the-drunken-coder/atlas-asset-runtime
npm test --workspace @the-drunken-coder/atlas-asset-runtime
npm run test:package --workspace @the-drunken-coder/atlas-asset-runtime
```

The packed-consumer smoke builds clean SDK and runtime tarballs, installs them into a temporary consumer, compiles the public declarations, and exercises the public runtime boundary.
