# Atlas acceptance support

Acceptance scenarios use `support/stack.mjs` to run the production Core image against run-owned, disposable PostgreSQL and MinIO storage. Durable mode preserves state for an in-run Core restart; cleanup destroys only those generated volumes. The runner owns:

- a unique Docker Compose project, loopback Core port, credentials, network, and project-scoped volumes;
- bounded dependency checks, startup, readiness, scenario execution, evidence capture, and cleanup on success, failure, or interruption;
- a `restartCore()` operation that restarts only Core while retaining that run's PostgreSQL and MinIO volumes;
- the scenario context: `baseUrl`, `apiKey`, browser `admin` credentials, `artifacts`, `record()`, `signal`, and `runID`.

Callers use those values through public Atlas interfaces and do not need to know Compose service names or storage layout. `record()` writes expected and actual observations to `evidence.jsonl` and fails the scenario when `passed` is false. Failed checks may classify their evidence as `corrected_test_error`, `verified_product_defect`, or `unavailable_verification`; behavior checks default to `verified_product_defect`, while setup and interruption errors are recorded as unavailable. The runner writes the exact revision, dirty-worktree state, reproduction command, duration, stack identity, command output, and Compose logs below `.atlas/acceptance/` by default. Set `ATLAS_ACCEPTANCE_ARTIFACTS` to choose another artifact root. Credentials are generated for each run, kept out of diagnostics, and discarded with the stack.

When a failed assertion raises an `AcceptanceCheckError`, the runner also writes a `manual-verification-required.json` handoff beside the evidence log and links it from `result.json`.

Scenarios that need a deterministic fixture can pass `prepare({ artifacts, runID, signal })`, which returns `{ environment, metadata, cleanup }`. Preparation and cleanup each have a two-minute deadline; both receive an abort signal and should stop promptly when it fires. The runner merges non-reserved `environment` keys into the disposable stack environment, records JSON metadata under `run.json.fixture`, and calls `cleanup({ signal })` after Compose logs and `down` have completed on both success and failure. Runner-owned credentials, run ID, and generated Core port cannot be overridden. A preparation function must remove any partially acquired fixture resources before throwing or timing out; its returned cleanup is only available after it resolves. If fixture cleanup fails or times out, its error is retained separately in `result.json` alongside the primary failure.

`fixtureVariant` adds a JSON-serializable scenario-level variant description to `run.json.fixture_variant`. `additionalComposeFiles` adds repository-relative or absolute Compose override paths after the base acceptance Compose file, allowing a fixture to extend the disposable stack without duplicating runner ownership. The runner validates the resolved Compose configuration before creating resources: overrides may not publish extra host ports, bind host paths, use external volumes or networks, attach host devices, or bypass the generated project identity.

Run the Entity journey from the repository root with Node 24 or newer and a running Docker daemon:

```sh
npm ci
npm run test:acceptance:sdk-entity
```

The command builds the SDK, starts the isolated stack, connects two built SDK clients, and verifies that the receiving client observes a real create, update, and delete feed sequence plus fresh public reads. Missing Node or Docker dependencies fail the command explicitly.

Every invocation generates an unoverrideable UUID-backed ownership identity and a new artifact directory. The runner holds its selected loopback port through setup, releases it immediately before Compose binds it, then retries startup once only when Docker reports that exact port was claimed in the handoff. The initial bind error remains in `commands.log` and `evidence.jsonl`; the successful port remains assigned to the same Core container through `restartCore()`. To make concurrent runs easy to identify, add labels:

```sh
ATLAS_ACCEPTANCE_RUN_LABEL=worktree-a npm run test:acceptance:sdk-entity
ATLAS_ACCEPTANCE_RUN_LABEL=worktree-b npm run test:acceptance:sdk-entity
```

The label never replaces the random ownership suffix, so simultaneous or diagnostic runs cannot adopt another run's resources or overwrite its evidence. Scenarios must honor the supplied abort signal in waits and cancellable operations. Cleanup targets only the generated project identity; it never invokes the development launcher or accesses retained production volumes.

The Entity journey covers one authenticated client's create, update, and delete lifecycle plus a second client's feed observations and fresh reads. It does not claim reconnect or Core-restart convergence, browser behavior, or server-side fault coverage; those belong to later acceptance journeys. After the valid create assertion, it deliberately changes only the captured observation's alias and verifies that the assertion rejects the mismatch. This guard check does not mutate the Core image or any product source.
The built Command Interface smoke and its two-engine local commands are documented in [browser/README.md](browser/README.md).
