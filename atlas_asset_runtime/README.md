# Atlas Asset Runtime

A small Node.js runtime for Atlas assets. It reports asset state through compact check-ins, dispatches pending commands sequentially, and records task outcomes through the Atlas SDK.

```ts
import { AtlasClient } from "@the-drunken-coder/atlas-sdk";
import { AtlasAssetRuntime } from "@the-drunken-coder/atlas-asset-runtime";

const client = new AtlasClient({ baseUrl: "http://127.0.0.1:8000" });
const runtime = new AtlasAssetRuntime(client, {
  entityId: "asset-1",
  handlers: {
    move: async ({ task, signal, reportProgress }) => {
      await reportProgress(50, "moving");
      if (signal.aborted) return;
      return { destination: task.parameters ?? {} };
    }
  },
  checkIn: () => ({ status: "ready" })
});

await runtime.start();
```

`start()` resolves after the protocol handshake and first complete check-in cycle. Later cycles run in the background. `checkIn()` can run a full cycle manually. `stop()` prevents future background cycles, signals an active background handler, and waits for all in-flight work to settle; it cannot interrupt an SDK request already in progress.

The runtime deliberately does not provide plugins, deployment tooling, durable offline writes, or exact-once execution. A process failure after task acknowledgement can leave that task acknowledged without completing it; callers must design physical commands with that boundary in mind.

The package is configured for public npm access but is not published automatically. Publish its pinned `@the-drunken-coder/atlas-sdk@0.1.0` dependency before publishing runtime version `0.1.0`.
