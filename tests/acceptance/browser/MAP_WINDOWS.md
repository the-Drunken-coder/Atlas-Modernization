# Map-window acceptance

This acceptance journey runs the built Command Interface and built SDK against an isolated Core, PostgreSQL, and MinIO stack. It authenticates through the visible login form, runs real MapLibre with the local deterministic tile fixture, and drives the current `spatial-results` map window through the public Plugin flow.

`map-windows/` supplies one test-only Plugin container. Core loads its endpoint fragment and obtains the fixture manifest and result over its normal private Plugin connection; the built browser invokes the public Core Plugin route and renders the returned spatial result. The fixture does not replace MapLibre, browser window state, Core authentication, Core Plugin routing, or the Command Interface renderer.

The journey validates observable behavior:

- real pointer dragging docks the spatial-results window to the workspace edge;
- attached windows collapse into a restore handle that retains result metadata, attribution, and close control;
- pointer and keyboard controls move, restore, attach, and detach the same window through the documented transitions;
- after a viewport resize, a collapsed edge handle remains visible and can restore the window.

The journey records the native zoom-in control's normal pointer attempt, then uses that same visible control through keyboard focus to continue independent map-window coverage. The pointer result remains the final active assertion. Map-window keyboard activations wait for focus and two browser animation frames because the component restores focus after rendering and clears collapsed-handle drag suppression on `requestAnimationFrame`.

Run Chromium locally from the repository root with Node 24, Docker, and the browser executable installed:

```sh
npm ci
npm run build:sdk
node node_modules/playwright/cli.js install chromium
node tests/acceptance/browser/map-windows.mjs --browser=chromium
```

Use `--headed` to watch the journey. The workflow runs Chromium for pull requests and branch pushes. Its scheduled nightly job runs Chromium and WebKit in a separate concurrency group. CI execution is recorded only after that workflow has run; this document does not claim a hosted result before publication.

Each run creates an isolated Compose project and writes diagnostics under:

```text
.atlas/acceptance/browser-map-windows-<engine>/<run-id>/
```

The directory retains the exact revision, fixture metadata, reproduction command, duration, Core responses including bodies, browser request and console logs, Compose logs, screenshots, page HTML on failure, and a Playwright trace. Open a trace with:

```sh
node node_modules/playwright/cli.js show-trace <trace.zip>
```

Do not rerun a new user-facing failure before manual assessment. Preserve its artifact directory and report the revision, command, expected and observed behavior, duration, and evidence path.

The current built application mounts only one production `MapWindow`, `spatial-results`. The test can therefore verify focus reaches the restored active control, but cannot observe relative stacking order between two simultaneously rendered real map windows. It does not add a synthetic browser window to fill that product-surface gap. Firefox was removed from the supported matrix after the initial hosted browser smoke run failed before MapLibre could create a real WebGL context; that failure remains removed coverage evidence and is not rerun or reclassified by this journey.
