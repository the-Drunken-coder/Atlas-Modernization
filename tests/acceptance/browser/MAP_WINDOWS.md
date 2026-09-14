# Map-window acceptance

This acceptance journey runs the built Command Interface and built SDK against an isolated Core, PostgreSQL, and MinIO stack. It authenticates through the visible login form, runs real MapLibre with the local deterministic tile fixture, and drives the current `spatial-results` map window through the public Plugin flow.

`map-windows/` supplies one test-only Plugin container. Core loads its endpoint fragment and obtains the fixture manifest and result over its normal private Plugin connection; the built browser invokes the public Core Plugin route and renders the returned spatial result. The fixture does not replace MapLibre, browser window state, Core authentication, Core Plugin routing, or the Command Interface renderer.

The journey validates observable behavior:

- real pointer dragging docks the spatial-results window to the workspace edge;
- attached windows collapse into a restore handle that retains result metadata and attribution, and whose visible, enabled close button removes the window through a normal pointer activation;
- pointer dragging moves the right-docked window 96 pixels into the workspace and proves that it becomes floating with no attached edge;
- pointer and keyboard controls move, restore, attach, and detach the same window through the documented transitions;
- the returned feature's actual result row contains both the fixture title and ID;
- after a viewport resize, the entire collapsed edge handle remains inside the workspace and can restore the window.

The journey records the native zoom-in control's normal pointer attempt and requires both a completed click and a higher zoom level in the resulting MapTiler tile request path. Tracking the requested `/z/x/y` level prevents unrelated late tile loads at the existing zoom from satisfying the assertion. It then uses that same visible control through keyboard focus to continue independent map-window coverage. Each zoom activation waits until the routed tile zoom increases and tile traffic remains unchanged for 500 milliseconds before the next activation. The pointer result remains the final active assertion. Map-window keyboard activations wait for observable focus and render frames because the component restores focus after rendering and clears collapsed-handle drag suppression on `requestAnimationFrame`.

The fixture validates the real Core Plugin POST body instead of returning a result for any request. The 1440 by 900 browser viewport leaves a 1080 by 900 map after the 360-pixel sidebar. Fitting the source-defined world bounds to that map is width-limited at zoom 1.076815597. Twelve settled unit zoom activations produce zoom 13.076815597. At that projection, a 36 by 36 drag from 46 percent of the map width and height resolves to west -0.003515625, south 19.800385362, east -0.0005859375, and north 19.803141819. The fixture permits two projected pixels around each edge to cover browser layout rounding while its coordinate, span, and aspect-ratio checks reject a translated area, an oversized area, and an area captured at a stale lower zoom. A focused HTTP probe of the fixture accepted the projected request with status 200 and returned status 422 for each of those three counterexamples.

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
