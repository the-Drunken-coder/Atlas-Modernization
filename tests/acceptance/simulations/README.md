# Moving-assets simulation acceptance

Run the moving-assets journey from the repository root with Node 24 and a running Docker daemon:

```sh
npm ci
npm run build:sdk && node tests/acceptance/simulations/moving-assets.mjs
```

The acceptance runner starts a disposable Atlas Core, PostgreSQL, and MinIO stack. It then starts the actual simulations server entrypoint on a reserved loopback port with the built workspace SDK. The test uses the server's public HTTP and server-sent event routes to complete one bounded moving-assets run and cancel a second run after its first telemetry tick.

A separate SDK client reads Core directly. Those reads verify the final coordinates and speed without relying on the simulation status or its own assertions. Before cleanup, the test replaces one run-owned Entity with a new instance that uses the same ID. It also creates unrelated Entity and Object instances. Cleanup must preserve all three protected instances while removing the other run-owned Entities. The cancelled run must remove each Entity it recorded before cancellation.

The test configures only the runner-owned loopback Core. Existing server configuration still rejects an incompatible deployed target before readiness. The fixture refuses to start when `simulations/.atlas-simulations/runs/` contains retained ledger entries, so it never reads or reports another run as acceptance-owned data. It checks that the server exposes no deployed target and writes no deployed cleanup-ledger record. The cleanup evidence must contain only the Entity resources recorded by moving-assets. The production Command Catalog is empty, and moving-assets creates no Tasks, so this case does not execute cleanup while a real Task exists. It preserves the no-Task-cleanup contract without claiming that unexecuted retention case as runtime evidence.

Each invocation writes the exact revision, dirty-worktree state, duration, expected and observed values, raw SSE frames, parsed events, simulation HTTP responses, server output, and Compose logs under `.atlas/acceptance/simulations-moving-assets/`. The runner preserves the first failure in those files and tears down only its generated Compose project and child process. Set `ATLAS_ACCEPTANCE_ARTIFACTS` to choose another artifact root.

The required `Simulation Acceptance` workflow runs the same command on Linux and uploads the evidence even when the check fails. A local run proves only the recorded host and Docker daemon environment.
