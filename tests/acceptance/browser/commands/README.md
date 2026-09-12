# Browser Command acceptance

This journey builds the current Command Interface and SDK, runs a disposable real Core with PostgreSQL and MinIO, and drives the existing Command list in Playwright. The test-only build variant supplies two pieces of data that production deliberately omits:

- a Go build overlay embeds the canonical `packages/protocol/conformance/tasking/fixtures/catalog.json` catalog in only the disposable Core image;
- a Vite resolve plugin replaces only the empty browser Command input registry with a typed direct registration for `fixture.queued`, whose fixed input is valid against `atlas.tasking.FixtureInput`.

The fixture adds no rendered control. The operator clicks the application's existing `Queued Fixture` Command row, and the existing Command flow creates the Task through the browser SDK. The test treats returned Task IDs as opaque strings and checks only the Protocol's 50-character limit. JSON catalog, input, and output comparisons are semantic.

Run Chromium from the repository root with Node 24, Docker, Compose, and the Playwright browser installed:

```sh
npm ci
node node_modules/playwright/cli.js install chromium
node node_modules/typescript/bin/tsc -p tests/acceptance/browser/commands/tsconfig.json
npm run build:sdk
node tests/acceptance/browser/commands/commands.mjs --browser=chromium
```

Use `--browser=webkit` for the additional nightly engine, and add `--headed` for local observation. Each command owns unique credentials, ports, containers, volumes, fixture directory, build directory, and artifacts. The runner bounds public requests at 10 seconds, normal UI observations at 15 seconds, interruption recovery at 30 seconds, Core readiness at 90 seconds, and builds at 10 minutes. It uses observable readiness and Task state rather than fixed delays.

The journey verifies normal issuance, acknowledgement, start, progress, completion, and visible output against fresh SDK reads. It then closes the browser's established real `/feed` WebSocket and blocks reconnect sockets at a Playwright transport gate while a pending Task completes through the separate real runtime interface. The test proves that an upstream feed existed, a live browser socket closed, and a reconnect was blocked before it assesses the visible connection error. It restores feed forwarding through the visible retry control and verifies changed-since recovery against the authoritative Task. Finally, it expires the browser's real HttpOnly session cookie, records the actual Core `401` response from a Command click, verifies the session-expiry login message, signs in again, checks retained outcomes, and completes another Command. This exercises the application's response to an expired browser credential; it does not wait through Core's seven-day wall-clock session lifetime.

Every run records revision, working-tree state, duration, exact reproduction, fixture hashes, Compose and build logs, full non-secret Core text/JSON responses, browser requests, console output, browser feed-gate events, proxy observations, final or failure screenshots, HTML on failure, and a Playwright trace under:

```text
.atlas/acceptance/browser-commands-<engine>/<run-id>/
```

Open a trace with `node node_modules/playwright/cli.js show-trace <trace.zip>`. The test does not retry. Preserve the first artifact directory and stop if a new user-facing assertion fails.

## Known cancellation contract gap

The shipped Command Interface has no Task cancellation action or control at the fixture base revision. `AtlasContextValue` and `AtlasDataSource` expose only Command submission, `AssetInspector` renders active and queued Tasks as read-only `TaskRow` values, and `TaskRow` renders status and payload only. The `Cancel` action in a Command form dismisses an unsubmitted form. The SDK does expose `client.tasks.cancel`, but calling it from this fixture would not test operator cancellation through the application.

The journey issues a final real pending Task after every independent recovery case and requires a visible cancellation button within that Task's row. If the control exists, the test clicks it and checks fresh authoritative Core state plus the visible cancelled state. The missing-control assertion remains active so the test stays red until a separate product repair adds operator cancellation.

The implementation-SHA reproduction and retained evidence are recorded in [`docs/problems/2026-09-12-command-task-cancellation-control-missing.md`](../../../../docs/problems/2026-09-12-command-task-cancellation-control-missing.md).

The pull request job runs Chromium. The scheduled and manually dispatched nightly job requests Chromium and WebKit. WebKit does not establish Safari or physical-device coverage. Firefox was removed from the supported matrix after the initial hosted browser smoke run failed before MapLibre could create a real WebGL context; this workflow does not claim Firefox coverage or treat that failure as a pass.
