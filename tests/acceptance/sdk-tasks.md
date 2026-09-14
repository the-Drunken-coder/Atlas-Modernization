# SDK Task acceptance

Run the Task lifecycle and runtime-fencing journey from the repository root with Node 24 or newer and a running Docker daemon:

```sh
npm ci
npm run build:sdk && node tests/acceptance/sdk-tasks.mjs
```

The journey uses the shared isolated Core, PostgreSQL, and MinIO runner from `support/stack.mjs`. It creates an Asset through the built SDK, registers a runtime with the canonical Task conformance manifest, and uses fresh SDK reads to verify these public behaviors:

- queued Task creation, runtime delivery, acknowledgement, start, completion, and returned output;
- acknowledgement releasing the next queued Task to the Asset application;
- client cancellation with its Protocol cancellation reason;
- a queued start rejected before acknowledgement without altering the stored Task;
- runtime replacement draining the former runtime's pending Task as `asset_restarted`;
- a former runtime rejected from acknowledging a Task after replacement, followed by successful acknowledgement from the current runtime.

Rejected Task transitions assert Core's raw `error.response.message` together with HTTP 400 and `VALIDATION_ERROR`. The captured actual result keeps the complete SDK wrapper in `error.message` as evidence.

Atlas deliberately embeds an empty production Command Catalog. This scenario adds only a temporary test-data Go build overlay that replaces the compiled catalog constant with `packages/protocol/conformance/tasking/fixtures/catalog.json`. The overlay's manifest comes from the matching canonical conformance fixture. It still runs the current Core entrypoint, authentication, handlers, database, and storage; it does not add an API, mutate a generated or production file, or establish that the production catalog contains Task Commands.

Every invocation generates a unique Compose project, loopback port, credentials, storage volumes, and artifact directory. The fixture directory is mode `0755`, its generated files are mode `0644`, and it is mounted read-only only for the Core compile step. The existing development image runs its normal `go run` command as the unprivileged `atlas` user, so readiness proves that user can compile the overlay; the scenario then verifies the exact injected catalog through the public endpoint. The temporary fixture directory is removed during cleanup. Artifact metadata marks this as the `tasking-conformance-catalog-overlay` variant and records the fixture source paths and SHA-256 values. By default, evidence is retained under `.atlas/acceptance/sdk-tasks/`; set `ATLAS_ACCEPTANCE_ARTIFACTS` to select a different artifact root.

The dedicated `SDK Task Acceptance` workflow runs this same command on pull requests and uploads its evidence even when a check fails. It establishes Linux GitHub Actions coverage when that workflow executes. A local run records the host platform and Docker daemon architecture in the shared acceptance evidence; it does not establish another runner architecture.
