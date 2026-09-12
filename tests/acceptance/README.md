# Atlas acceptance support

Acceptance scenarios use `support/stack.mjs` to run the current Core against disposable PostgreSQL and MinIO storage. The runner owns:

- a unique Docker Compose project, reserved loopback Core port, credentials, network, and project-scoped volumes;
- bounded dependency checks, startup, readiness, scenario execution, evidence capture, and cleanup on success, failure, or interruption;
- a `restartCore()` operation that restarts only Core while retaining that run's PostgreSQL and MinIO volumes;
- the scenario context: `baseUrl`, `apiKey`, browser `admin` credentials, `artifacts`, `record()`, `signal`, and `runID`.

Callers use those values through public Atlas interfaces and do not need to know Compose service names or storage layout. `record()` writes expected and actual observations to `evidence.jsonl` and fails the scenario when `passed` is false. The runner writes the exact revision, dirty-worktree state, reproduction command, duration, stack identity, command output, and Compose logs below `.atlas/acceptance/` by default. Set `ATLAS_ACCEPTANCE_ARTIFACTS` to choose another artifact root. Credentials are generated for each run, kept out of diagnostics, and discarded with the stack.

Run the Entity journey from the repository root with Node 24 or newer and a running Docker daemon:

```sh
npm ci
npm run test:acceptance:sdk-entity
```

The command builds the SDK, starts the isolated stack, connects two built SDK clients, and verifies that the receiving client observes a real create, update, and delete feed sequence plus fresh public reads. Missing Node or Docker dependencies fail the command explicitly.

Every invocation generates an unoverrideable UUID-backed ownership identity and a new artifact directory. To make concurrent runs easy to identify, add labels:

```sh
ATLAS_ACCEPTANCE_RUN_LABEL=worktree-a npm run test:acceptance:sdk-entity
ATLAS_ACCEPTANCE_RUN_LABEL=worktree-b npm run test:acceptance:sdk-entity
```

The label never replaces the random ownership suffix, so simultaneous or diagnostic runs cannot adopt another run's resources or overwrite its evidence. Scenarios must honor the supplied abort signal in waits and cancellable operations. Cleanup targets only the generated project identity; it never invokes the development launcher or accesses retained production volumes.
