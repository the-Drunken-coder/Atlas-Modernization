# SDK recovery acceptance

This scenario proves that a running Atlas SDK client converges after its real Core feed connection is interrupted by a Core restart. Each cycle retains one updated Entity and deletes a separate Entity so the final state independently demonstrates both outcomes.

The test starts from a healthy native WebSocket connection and a valid two-Entity baseline. Before restarting Core, it closes a test-local gate around future WebSocket construction. The established socket remains the native Node WebSocket connected to the real Core. The gate only rejects later connection attempts, which keeps the receiver disconnected long enough to commit and verify the offline writes. It never creates feed events, changed-since responses, or HTTP results.

An independent SDK client verifies that both baseline Entities survive the Core restart, then verifies the committed update and 404 deletion through fresh reads. It also reads the real changed-since stream from the receiver's baseline cursor and finds the update and deletion in order. Releasing the gate allows the SDK's automatic reconnect to open a native WebSocket, install its subscriptions, recover from the retained cursor, and publish both events to public watchers. The final assertions use `sync.status()`, `sync.snapshot()`, an ordinary receiver read, and fresh independent reads.

Run the bounded pull-request case from the repository root with Node 24 or newer and Docker running:

```sh
npm ci
npm run build:sdk
node tests/acceptance/sdk-recovery.mjs
```

Run the expanded nightly shape locally with the same recorded parameter used by the scheduled workflow:

```sh
ATLAS_ACCEPTANCE_RECOVERY_CYCLES=3 node tests/acceptance/sdk-recovery.mjs
```

The cycle count must be an integer from 1 through 5. Pull requests and pushes to `main` run one cycle. The nightly schedule runs three successive restart and recovery cycles against the same isolated stack and receiver, with distinct Entities in every cycle.

The runner writes the exact revision, dirty-worktree state, reproduction command, scenario parameters, timestamped recovery phases, expected and actual values, measured duration, command output, and Compose logs under `.atlas/acceptance/sdk-recovery/<run-id>/`. It classifies bounded failures as a missing baseline, an unobserved disconnect, an absent reconnect attempt, a Core restart failure, a durability mismatch, a changed-since mismatch, a stale disconnect boundary, a recovery timeout, or a final convergence mismatch. Preserve the first artifacts when a new user-facing assertion fails and stop that case for manual assessment; do not extend its deadline or change its expectation to obtain a pass.

The scenario covers retained-cursor recovery after an Atlas Core process restart with PostgreSQL and MinIO kept in place. It does not cover cursor expiry, feed-buffer exhaustion, a network partition while Core stays running, or offline write queueing. The SDK has no offline write queue; the writer and independent verifier remain connected to Core while only the receiving feed connection is gated.
