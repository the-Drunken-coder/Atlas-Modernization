# Simulation browser acceptance

The browser journey runs the built simulation workbench against its actual local server and a runner-owned Atlas Core, PostgreSQL, and MinIO stack. Chromium and WebKit each start a bounded moving-assets run through the visible workbench, observe a telemetry event delivered by the real server-sent event route, stop the run, and invoke cleanup through the visible controls. WebKit coverage does not verify Safari. Firefox is outside the supported browser matrix.

An independent built SDK client reads Core after the browser starts and stops the run. Before browser cleanup, that client completes a nonempty Task through the canonical Task conformance fixture, replaces one run-owned Entity with a new instance under the same ID, and creates unrelated Entity and Object instances. Fresh Core reads after cleanup verify that the original run-owned Entity is gone, the replacement and unrelated instances remain, and the completed Task is still readable after its Asset is deleted.

The server fixture configures only the disposable loopback Core and clears deployed-target configuration. The test verifies that both the server and browser expose one non-deployed target, keep the API-key input empty, do not show deployed confirmation, and do not disclose the configured Core API key in browser diagnostics. It refuses retained simulation cleanup-ledger entries in the worktree. The shared acceptance runner assigns a UUID Compose project with unique credentials, ports, containers, volumes, and labels, then removes only that project.

Use Node 24 and a running Docker daemon. Install dependencies and browsers once from the repository root:

```sh
npm ci
node node_modules/playwright/cli.js install chromium webkit
```

Build the actual workbench assets, then select one browser engine:

```sh
npm run build:simulations
node tests/acceptance/simulations/browser.mjs --browser=chromium
node tests/acceptance/simulations/browser.mjs --browser=webkit
```

Add `--headed` to watch a local run. A missing Node 24 runtime, Docker daemon, Compose plugin, built workbench, or selected browser executable fails explicitly. The journey has no retry.

Each run writes its exact revision, dirty-worktree state, duration, expected and observed values, built-asset hashes, browser version, mutation and SSE responses, browser console and uncaught page exceptions, simulation server output, Compose logs, and a Playwright trace under:

```text
.atlas/acceptance/simulations-browser-<engine>/<run-id>/
```

A failure also writes a full-page screenshot and page HTML when the browser remains available. Open the trace with `node node_modules/playwright/cli.js show-trace <trace.zip>`. Preserve the first failing directory. Correct setup or expectation errors in this test-only branch. Keep a verified product failure active and record its exact revision, command, expected result, observed result, and artifacts in `docs/problems/` for a later repair.

The required `Simulation Browser Acceptance` workflow runs the same Chromium and WebKit commands on Linux and uploads each engine's evidence even when its job fails. A local or hosted Playwright result establishes only the recorded engine, operating system, and Docker environment.
