# SDK authentication and conflicting writes acceptance

This journey runs the built SDK against a real Core container with API-key authentication enabled. It creates one protected Entity, checks missing and invalid credentials, verifies a legitimate read, and then uses two SDK clients to exercise an optimistic-concurrency conflict.

The fixture uses a plain UUID Entity ID (36 characters, within Core's 50-character limit) and aliases containing only characters accepted by Core's current alias validator. The preflight contract guard runs before `runAcceptance` starts Docker.

The expected HTTP and error contracts come from the current Core and Protocol definitions:

- Missing or invalid credentials: HTTP `401`, `error_code: "UNAUTHORIZED"`, with the exact middleware body `{ "success": false, "message": "Unauthorized", "error_code": "UNAUTHORIZED" }`. The response must contain no Entity ID or alias.
- A legitimate API-key read: HTTP `200` with the created Entity.
- A stale SDK update: `ConflictError`, HTTP `412`, and `error_code: "PRECONDITION_FAILED"`.
- The stale update is followed by a fresh read from a separate SDK client, which must still show the newer alias and version.

Run locally from the repository root with Node 24 and a running Docker daemon:

```sh
npm ci
npm run build:sdk && node tests/acceptance/sdk-auth-conflicts.mjs
```

The scenario owns an isolated disposable Compose project and writes `run.json`, `commands.log`, `evidence.jsonl`, `stack.json`, `compose.log`, and `result.json` below `.atlas/acceptance/sdk-auth-conflicts/<run-id>/`. The generated API, admin, PostgreSQL, and MinIO credentials are never recorded in evidence or command diagnostics. The required CI execution is `.github/workflows/sdk-auth-conflicts.yml`, which uploads the same evidence directory for every run.

This test does not claim browser, feed, deployment, or physical-radio coverage. It leaves product behavior unchanged; a valid assertion that exposes a Core defect remains an active failing check for the later repair work.
