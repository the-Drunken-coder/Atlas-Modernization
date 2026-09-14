# SDK authentication and conflicting writes acceptance

This journey runs the built SDK against a real Core container with API-key authentication enabled. It creates one protected Entity, checks missing and invalid credentials, verifies a legitimate read, and then uses two SDK clients to exercise an optimistic-concurrency conflict.

The fixture uses a plain UUID Entity ID (36 characters, within Core's 50-character limit) and aliases containing only characters accepted by Core's current alias validator. The preflight contract guard runs before `runAcceptance` starts Docker.

The expected HTTP and error contracts come from the current Core and Protocol definitions:

- Missing or invalid credentials: the built SDK raises `AtlasAPIError` with status `401`, `errorCode: "UNAUTHORIZED"`, and the exact public response `{ "success": false, "message": "Unauthorized", "error_code": "UNAUTHORIZED" }`. A separate raw HTTP read checks the same response before SDK error sanitization. Neither response may contain an Entity ID or alias.
- A legitimate built-SDK API-key read: the created Entity is returned successfully.
- A stale SDK update: `ConflictError`, HTTP `412`, and `error_code: "PRECONDITION_FAILED"`.
- The stale update is followed immediately by a fresh read from a separate SDK client. That read's state or error is included in the stale-write rejection evidence before the rejection assertion can fail, and the captured state must still show the newer alias and version. After a valid baseline, isolated local mutation probes verify that both stale-write and newer-state assertions reject incorrect outcomes without mutating Core.

Run locally from the repository root with Node 24 and a running Docker daemon:

```sh
npm ci
npm run build:sdk && node tests/acceptance/sdk-auth-conflicts.mjs
```

The scenario owns an isolated disposable Compose project and writes `run.json`, `commands.log`, `evidence.jsonl`, `stack.json`, `compose.log`, `result.json`, and `verification-disposition.json` below `.atlas/acceptance/sdk-auth-conflicts/<run-id>/`. The disposition artifact repeats the exact revision, scenario, reproduction command, and artifact path, then keeps separate arrays for corrected test errors, verified product defects, unavailable verification, and unresolved failures. A passing run records empty confirmed-defect arrays; any failed assertion includes its affected check and remains unresolved until manually classified rather than being silently treated as a product defect or a test correction. The stack owns final data disposal after the scenario. The generated API, admin, PostgreSQL, and MinIO credentials are never recorded in evidence or command diagnostics. The required CI execution is `.github/workflows/sdk-auth-conflicts.yml`, which uploads the same evidence directory for every run and fails when that directory is absent.

This test does not claim browser, feed, deployment, or physical-radio coverage. It leaves product behavior unchanged; a valid assertion that exposes a Core defect remains an active failing check for the later repair work.
