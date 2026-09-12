# Browser acceptance

The browser smoke runs the built Command Interface and built SDK against an isolated real Core, PostgreSQL, and MinIO stack. One independent SDK client seeds a geofeature and later changes its alias. The browser logs in through the visible form, loads the initial resource, receives the independent update through Core's feed, edits the point geometry, reloads, and confirms the saved coordinates from both the UI and a fresh SDK read.

The deeper Geofeature journey creates a line through map clicks, selects and edits it on the real map, verifies pointer and keyboard vertex behavior, exercises a real stale-version save failure, preserves the draft while the real Building Scan **Draw area** interaction temporarily owns the map, reloads the successful edit, and attempts deletion through the selected Geofeature's browser controls. The fixture builds Building Scan only for its real manifest and health endpoints; this scenario never invokes its external Overpass operation.

The browser and Core each use an ephemeral HTTPS loopback origin. A test-only TLS proxy forwards HTTP and WebSocket traffic to Core without replacing authentication or API behavior. Core receives the browser's actual `Origin` header and allows only that run's Command Interface origin. The smoke records that login and the browser edit used that origin, and that the reload, feed, and edit carried Core's HttpOnly session cookie.

MapLibre runs normally in the built application. The build enables its existing MapTiler source with a non-secret fixture token. Playwright redirects only that provider's raster tile request to the run's HTTPS fixture server, which returns the static `fixtures/map-tile.base64` image. Atlas HTTP, authentication, SDK, feed, and persistence traffic is never intercepted or fulfilled by Playwright. This keeps public map providers out of the result while retaining the real MapLibre renderer and request path.

Use Node 24 and a running Docker daemon. Install dependencies and the browser engines once:

```sh
npm ci
node node_modules/playwright/cli.js install chromium webkit
```

Select one engine from the repository root:

```sh
npm run test:acceptance:browser-smoke -- --browser=chromium
npm run test:acceptance:browser-smoke -- --browser=webkit
npm run test:acceptance:browser-geofeatures -- --browser=chromium
```

Add `--headed` to watch a local run. Each command owns unique ports, credentials, containers, volumes, and artifacts, so separate worktrees can run at the same time. A missing browser executable, Node 24, Docker daemon, or Compose plugin fails explicitly.

The smoke does not retry. A failure keeps the first observation in `evidence.jsonl` and writes the exact revision, reproduction command, duration, browser version, build output, full Core JSON/text responses, request status, browser console, proxy origin and cookie observations, Core logs, a screenshot, page HTML, and a Playwright trace under:

```text
.atlas/acceptance/browser-smoke-<engine>/<run-id>/
```

Open a trace with `node node_modules/playwright/cli.js show-trace <trace.zip>`. If a new user-facing assertion fails on its first real run, preserve that directory and stop the case for developer assessment. Do not rerun, weaken, skip, or mark the case as expected to fail while its expectation is disputed.

The required pull request workflow runs this same journey in Chromium and WebKit. Firefox was removed from the supported matrix on 2026-09-12 after its initial hosted smoke run failed before MapLibre could create a real WebGL context ([CI run 34712353314](https://github.com/the-Drunken-coder/Atlas-Modernization/actions/runs/34712353314)). That run remains removed coverage evidence and is not a pass. WebKit engine coverage does not verify Safari or any physical device.

`browser-geofeatures.yml` runs the deeper journey in Chromium for pull requests and default workflow dispatches. Its schedule and nightly dispatch mode expand the same assertions to Chromium and WebKit. A hosted engine that cannot create a real WebGL context remains a failed or unavailable renderer check; the test does not substitute a fake MapLibre implementation.
