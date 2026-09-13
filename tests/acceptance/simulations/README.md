# Moving-assets simulation acceptance

Run the moving-assets journey from the repository root with Node 24 and a running Docker daemon:

```sh
npm ci
npm run build:sdk && node tests/acceptance/simulations/moving-assets.mjs
```

The acceptance runner starts a disposable Atlas Core, PostgreSQL, and MinIO stack. It then uses a test-only launcher to construct the actual simulations server factory on a reserved loopback port with the built workspace SDK. The launcher loads its configuration and cleanup ledger from a runner-owned temporary package root while reusing the built simulation assets, so it does not read or alter `simulations/.env` or its ledger. The test uses the server's public HTTP and server-sent event routes to complete one bounded moving-assets run and cancel a second run after its first telemetry tick.

A separate SDK client reads Core directly. Those reads verify the final coordinates and speed without relying on the simulation status or its own assertions. Before cleanup, the test replaces one run-owned Entity with a new instance that uses the same ID. It also creates unrelated Entity and Object instances. Cleanup must preserve all three protected instances while removing the other run-owned Entities. The cancelled run must remove each Entity it recorded before cancellation.

The test configures only the runner-owned loopback Core. The actual server's deployed-target guards remain active against that isolated configuration, which contains no deployed values. It checks that the server exposes no deployed target and writes no deployed cleanup-ledger record. A test-only Core overlay loads the canonical Task conformance catalog. Before cleanup, the test registers a runtime on one run-owned Asset, creates and reads a nonempty queued Task through public APIs, verifies runtime delivery, and completes that Task. Cleanup removes the Asset; a fresh Task read must still return the completed Task. The simulation cleanup evidence continues to contain only the Entity resources recorded by moving-assets, while the separate Task check proves retention.

Each invocation writes the exact revision, dirty-worktree state, duration, expected and observed values, raw SSE frames, parsed events, simulation HTTP responses, server output, and Compose logs under `.atlas/acceptance/simulations-moving-assets/`. The runner preserves the first failure in those files and tears down only its generated Compose project and child process. Set `ATLAS_ACCEPTANCE_ARTIFACTS` to choose another artifact root.

The required `Simulation Acceptance` workflow runs the same command on Linux and uploads the evidence even when the check fails. A local run proves only the recorded host and Docker daemon environment.
