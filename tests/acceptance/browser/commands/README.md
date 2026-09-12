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

Use `--browser=firefox` or `--browser=webkit` for the nightly engines, and add `--headed` for local observation. Each command owns unique credentials, ports, containers, volumes, fixture directory, build directory, and artifacts. The runner bounds public requests at 10 seconds, normal UI observations at 15 seconds, interruption recovery at 30 seconds, Core readiness at 90 seconds, and builds at 10 minutes. It uses observable readiness and Task state rather than fixed delays.

The journey verifies normal issuance, acknowledgement, start, progress, completion, and visible output against fresh SDK reads. It then disconnects the browser while a pending Task completes through the real runtime interface, restores transport through the visible retry control, and verifies changed-since recovery against the authoritative Task. Finally, it expires the browser's real HttpOnly session cookie, records the actual Core `401` response from a Command click, verifies the session-expiry login message, signs in again, checks retained outcomes, and completes another Command. This exercises the application's response to an expired browser credential; it does not wait through Core's seven-day wall-clock session lifetime.

Every run records revision, working-tree state, duration, exact reproduction, fixture hashes, Compose and build logs, full non-secret Core text/JSON responses, browser requests, console output, proxy observations, final or failure screenshots, HTML on failure, and a Playwright trace under:

```text
.atlas/acceptance/browser-commands-<engine>/<run-id>/
```

Open a trace with `node node_modules/playwright/cli.js show-trace <trace.zip>`. The test does not retry. Preserve the first artifact directory and stop if a new user-facing assertion fails.

## Known cancellation contract gap

The shipped Command Interface has no Task cancellation action or control at the fixture base revision. `AtlasContextValue` and `AtlasDataSource` expose only Command submission, `AssetInspector` renders active and queued Tasks as read-only `TaskRow` values, and `TaskRow` renders status and payload only. The `Cancel` action in a Command form dismisses an unsubmitted form. The SDK does expose `client.tasks.cancel`, but calling it from this fixture would not test operator cancellation through the application.

This acceptance therefore does not claim or simulate UI cancellation. Adding a cancellation control requires a product change outside this test-only ticket and remains pending developer assessment.

The pull request job runs Chromium. The scheduled and manually dispatched nightly job requests Chromium, Firefox, and WebKit. WebKit does not establish Safari or physical-device coverage. The inherited hosted Firefox WebGL failure from browser smoke ticket #379 is still awaiting manual assessment; this ticket does not change or rerun that case, so successful three-engine nightly coverage remains unverified until the new workflow executes and that existing limitation is resolved.
