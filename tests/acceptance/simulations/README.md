# Simulation acceptance

Run the simulation journeys from the repository root with Node 24 and a running Docker daemon:

```sh
npm ci
npm run build:sdk && node tests/acceptance/simulations/moving-assets.mjs
npm run build:sdk && node tests/acceptance/simulations/observations-objects.mjs
npm run build:sdk && node tests/acceptance/simulations/multi-client-sync.mjs
```

Each invocation starts a disposable Atlas Core, PostgreSQL, and MinIO stack. It then uses a test-only launcher to construct the actual simulations server factory on a reserved loopback port with the built workspace SDK. The launcher loads its configuration and cleanup ledger from a runner-owned temporary package root while reusing the built simulation assets, so it does not read or alter `simulations/.env` or its ledger. It records the actual isolated ledger path before fixture cleanup. It uses the server's public HTTP and server-sent event routes, verifies that exactly the `local` target is exposed without deployed credentials, and tears down only its generated Compose project and child process.

The moving-assets journey completes a bounded run and cancels a second after its first telemetry tick. A separate SDK client verifies persisted coordinates and speed without relying on simulation status. Before cleanup, it replaces a run-owned Entity and creates unrelated Entity and Object instances; cleanup must preserve those instances while removing run-owned Entities. After cancellation, fresh reads separated by one tick interval must show that telemetry no longer changes before cleanup removes each cancelled Entity. A test-only Core overlay also creates, delivers, completes, and independently rereads a nonempty Task after its run-owned Asset is cleaned up.

The observations-objects journey independently reads observer Assets, track Entities, and their linked Objects after a completed run. Objects from this scenario are metadata-only: `path`, `size_bytes`, `content_type`, and `bucket` must be null, rather than representing stored binary bytes. Numbered observer and track Entity IDs are mapped from their stable numeric component before every expected alias, coordinate, and relation is compared; hash suffixes remain opaque. Each numbered Object must have exactly `usage_hints: ["thumbnail"]` and exactly one reference to its matching track. The test replaces run-owned Entity and Object instances before cleanup, preserves unrelated resources, and rereads those protected instances after both completed and cancelled cleanup.

The multi-client-sync journey starts separate SDK readers outside the simulation process before issuing the run. Polling is disabled so each reader must converge through the SDK feed. It maps the stable numbered portion of every writer Entity ID before checking the matching alias, coordinates, and write index, while treating the hash suffix as opaque. Before cleanup it creates unrelated Entity and Object canaries with independent instance tokens, then fresh reads must show both survive while every run-owned Entity is removed. The canaries are deleted with their own tokens during test teardown. This is an SDK feed-convergence and ownership check independent of the scenario's internal readers and assertions.

Every invocation writes the exact revision, dirty-worktree state, duration, expected and observed values, raw SSE frames and parsed events even when stream opening fails, simulation HTTP responses, server output, and Compose logs under `.atlas/acceptance/simulations-<scenario>/`. Set `ATLAS_ACCEPTANCE_ARTIFACTS` to choose another artifact root.

The required `Simulation scenario acceptance` workflow runs observations-objects and multi-client-sync in separate jobs and uploads required evidence. Its nightly or manually dispatched matrix runs each scenario independently with `ATLAS_ACCEPTANCE_NIGHTLY=1`: it expands observations to three observers and eight observations, multi-client sync to four clients and eight writes, and records each scenario's invalid-cardinality public-input fault. The workflow keeps push, scheduled, and manual runs in separate concurrency groups, so a push does not cancel a nightly run. Those configured nightly paths require hosted execution; the local required runs only prove the recorded host and Docker daemon environment.
