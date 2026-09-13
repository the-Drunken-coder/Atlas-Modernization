import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMapArea, isPluginManifest, isSpatialOperationResult } from "@the-drunken-coder/atlas-sdk";
import { chromium, webkit } from "playwright";
import { runAcceptance } from "../support/stack.mjs";
import { buildCommandInterface, prepareBrowserServers } from "./support/servers.mjs";

const fixturePath = new URL("./map-windows/fixture.json", import.meta.url);
const composePath = "tests/acceptance/browser/map-windows/compose.yml";
const browserTypes = { chromium, webkit };
const options = parseArguments(process.argv.slice(2));
const browserType = browserTypes[options.browser];
const fixtureData = JSON.parse(readFileSync(fixturePath, "utf8"));
const fixture = validateFixture(fixtureData);
const reproduction = `npm run build:sdk && node tests/acceptance/browser/map-windows.mjs --browser=${options.browser}${
  options.headed ? " --headed" : ""
}`;

if (!existsSync(browserType.executablePath())) {
  throw new Error(
    `Playwright ${options.browser} is required at ${browserType.executablePath()}. ` +
      `Install it with: node node_modules/playwright/cli.js install ${options.browser}`
  );
}

let browserFixture;

await runAcceptance({
  name: `browser-map-windows-${options.browser}`,
  fixtureVariant: "test-only map_windows Plugin through Core's public Plugin proxy",
  reproduction,
  additionalComposeFiles: [composePath],
  prepare: async ({ artifacts }) => {
    browserFixture = await prepareBrowserServers({ artifacts });
    return {
      environment: { ATLAS_ACCEPTANCE_CORS_ORIGINS: browserFixture.appOrigin },
      metadata: {
        browser_engine: options.browser,
        fixture_plugin_id: fixture.manifest.plugin_id,
        fixture_operation_id: fixture.operation.operation_id,
        ...browserFixture.metadata
      },
      cleanup: browserFixture.cleanup
    };
  },
  run: async ({ baseUrl, admin, artifacts, record, signal }) => {
    if (!browserFixture) throw new Error("browser fixture preparation did not run");
    browserFixture.pointCoreAt(baseUrl);
    const buildRoot = await buildCommandInterface({ coreOrigin: browserFixture.coreOrigin, artifacts, signal });
    browserFixture.serveAppFrom(buildRoot);
    await runMapWindowJourney({
      browserType,
      browserName: options.browser,
      headed: options.headed,
      fixture,
      browserFixture,
      admin,
      artifacts,
      record,
      signal
    });
  }
});

async function runMapWindowJourney({
  browserType,
  browserName,
  headed,
  fixture,
  browserFixture,
  admin,
  artifacts,
  record,
  signal
}) {
  const consoleLog = join(artifacts, `${browserName}-console.jsonl`);
  const requestLog = join(artifacts, `${browserName}-requests.jsonl`);
  const tracePath = join(artifacts, `${browserName}-trace.zip`);
  const runtimePath = join(artifacts, `${browserName}-runtime.json`);
  const failureScreenshot = join(artifacts, `${browserName}-failure.png`);
  const failureHTML = join(artifacts, `${browserName}-failure.html`);
  const browser = await browserType.launch({ headless: !headed });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  });
  const pendingDiagnostics = new Set();
  let routedTileRequests = 0;
  let maximumRoutedTileZoom = -1;
  let page;
  let failure;

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await context.route("https://api.maptiler.com/maps/openstreetmap-dark/**", async (route) => {
    routedTileRequests += 1;
    const tileZoom = mapTileZoom(route.request().url());
    if (tileZoom !== undefined) maximumRoutedTileZoom = Math.max(maximumRoutedTileZoom, tileZoom);
    await route.continue({ url: browserFixture.fixtureTileUrl });
  });

  try {
    page = await context.newPage();
    attachDiagnostics(page, {
      consoleLog,
      requestLog,
      coreOrigin: browserFixture.coreOrigin,
      pending: pendingDiagnostics
    });
    await page.goto(`${browserFixture.appOrigin}/map`, { waitUntil: "domcontentloaded", timeout: 20_000 });

    await checkVisible(record, page.getByRole("form", { name: "Atlas login" }), {
      check: `${browserName} displayed the public login shell`,
      expected: "Atlas login form visible",
      page
    });
    await page.getByLabel("Username").fill(admin.username);
    await page.getByLabel("Password").fill(admin.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await checkVisible(record, page.getByRole("button", { name: "Plugins", exact: true }), {
      check: `${browserName} completed legitimate Core login`,
      expected: "authenticated Plugins navigation visible",
      page
    });

    const mapCanvas = page.locator(".maplibregl-canvas");
    await checkVisible(record, mapCanvas, {
      check: `${browserName} loaded the real MapLibre canvas`,
      expected: "visible MapLibre WebGL canvas",
      page
    });
    const webgl = await mapCanvas.evaluate((canvas) => {
      if (!(canvas instanceof HTMLCanvasElement)) return { canvas: false, width: 0, height: 0, webgl2: false };
      return {
        canvas: true,
        width: canvas.width,
        height: canvas.height,
        webgl2: canvas.getContext("webgl2") !== null
      };
    });
    record({
      check: `${browserName} used a live WebGL-backed MapLibre renderer`,
      expected: { canvas: true, positive_dimensions: true, webgl2: true },
      actual: webgl,
      passed: webgl.canvas && webgl.width > 0 && webgl.height > 0 && webgl.webgl2
    });
    await waitUntil(() => browserFixture.mapTileRequestCount() > 0, 10_000, signal);
    record({
      check: `${browserName} loaded the deterministic local map fixture`,
      expected: { routed_tile_requests: ">0", fixture_tile_requests: ">0" },
      actual: {
        routed_tile_requests: routedTileRequests,
        fixture_tile_requests: browserFixture.mapTileRequestCount()
      },
      passed: routedTileRequests > 0 && browserFixture.mapTileRequestCount() > 0
    });

    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    const fixturePlugin = page.getByRole("button", { name: /Map window fixture/ });
    await checkVisible(record, fixturePlugin, {
      check: `${browserName} discovered the test-only map window Plugin through Core`,
      expected: fixture.manifest.display_name,
      page
    });
    await fixturePlugin.click();
    const fixtureOperation = page.getByRole("button", { name: /Inspect map windows/ });
    await checkVisible(record, fixtureOperation, {
      check: `${browserName} exposed the map-area Plugin operation`,
      expected: fixture.operation.display_name,
      page
    });
    await fixtureOperation.click();
    await checkVisible(record, page.getByRole("button", { name: "Draw area", exact: true }), {
      check: `${browserName} opened real map-area controls for the selected Plugin`,
      expected: "Draw area control visible",
      page
    });

    const zoomIn = page.locator(".maplibregl-ctrl-zoom-in");
    await checkVisible(record, zoomIn, {
      check: `${browserName} exposed native MapLibre zoom controls before area selection`,
      expected: "visible zoom-in control",
      page
    });
    const pointerTilesBefore = browserFixture.mapTileRequestCount();
    const pointerMaximumTileZoomBefore = maximumRoutedTileZoom;
    let pointerClickCompleted = false;
    let pointerClickError;
    try {
      await zoomIn.click({ timeout: 2_000 });
      pointerClickCompleted = true;
      await waitUntil(() => maximumRoutedTileZoom > pointerMaximumTileZoomBefore, 10_000, signal);
    } catch (error) {
      pointerClickError = errorMessage(error);
    }
    const pointerTilesAfter = browserFixture.mapTileRequestCount();
    const pointerMaximumTileZoomAfter = maximumRoutedTileZoom;
    const zoomPointerAttempt = {
      activated: pointerClickCompleted && pointerMaximumTileZoomAfter > pointerMaximumTileZoomBefore,
      click_completed: pointerClickCompleted,
      observable_map_change: pointerMaximumTileZoomAfter > pointerMaximumTileZoomBefore,
      maximum_requested_tile_zoom_before: pointerMaximumTileZoomBefore,
      maximum_requested_tile_zoom_after: pointerMaximumTileZoomAfter,
      fixture_tile_requests_before: pointerTilesBefore,
      fixture_tile_requests_after: pointerTilesAfter,
      ...(pointerClickError ? { error: pointerClickError } : {})
    };
    const routedBeforeKeyboardZoom = routedTileRequests;
    await zoomIn.focus();
    const keyboardControlFocused = await zoomIn.evaluate((element) => document.activeElement === element);
    const remainingZoomSteps = zoomPointerAttempt.activated ? 15 : 16;
    for (let index = 0; index < remainingZoomSteps; index += 1) await zoomIn.press("Enter");
    await waitUntil(() => routedTileRequests > routedBeforeKeyboardZoom, 10_000, signal);
    record({
      check: `${browserName} used the visible zoom control's keyboard interaction to continue the map-window journey`,
      expected: { focused: true, zoom_steps: 16, additional_fixture_tile_requests: true },
      actual: {
        focused: keyboardControlFocused,
        zoom_steps: remainingZoomSteps + (zoomPointerAttempt.activated ? 1 : 0),
        routed_tile_requests_before: routedBeforeKeyboardZoom,
        routed_tile_requests_after: routedTileRequests
      },
      passed: keyboardControlFocused && routedTileRequests > routedBeforeKeyboardZoom
    });

    const map = page.getByTestId("map-canvas");
    await checkVisible(record, map, {
      check: `${browserName} retained a reachable map canvas while selecting a Plugin area`,
      expected: "visible map canvas",
      page
    });
    await page.getByRole("button", { name: "Draw area", exact: true }).click();
    await checkVisible(record, page.getByText("Drag on the map. Escape cancels.", { exact: true }), {
      check: `${browserName} entered the documented map-area drawing state`,
      expected: "drawing guidance visible",
      page
    });
    const mapBox = await requiredBox(map, "map canvas");
    const start = { x: mapBox.x + mapBox.width * 0.46, y: mapBox.y + mapBox.height * 0.46 };
    const end = { x: start.x + 36, y: start.y + 36 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
    const selectedArea = page.getByTestId("map-area-selection");
    await checkVisible(record, selectedArea, {
      check: `${browserName} rendered the bounded map-area selection from the pointer drag`,
      expected: "visible selected-area region",
      page
    });
    const selectedAreaBox = await requiredBox(selectedArea, "selected map area");
    record({
      check: `${browserName} preserved the requested 36 by 36 pixel map-area drag`,
      expected: { width: 36, height: 36, tolerance: 1 },
      actual: selectedAreaBox,
      passed: Math.abs(selectedAreaBox.width - 36) <= 1 && Math.abs(selectedAreaBox.height - 36) <= 1
    });
    await checkVisible(record, page.getByRole("button", { name: "Search", exact: true }), {
      check: `${browserName} converted a bounded real map drag into a searchable area`,
      expected: "Search control visible after map-area drawing",
      page
    });

    const pluginPath = `/plugins/${fixture.manifest.plugin_id}/operations/${fixture.operation.operation_id}`;
    const pluginRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).origin === browserFixture.coreOrigin &&
        new URL(request.url()).pathname === pluginPath,
      { timeout: 15_000 }
    );
    const pluginResponsePromise = waitForCoreResponse(
      page,
      browserFixture.coreOrigin,
      "POST",
      pluginPath
    );
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const [pluginRequest, rawPluginResponse] = await Promise.all([pluginRequestPromise, pluginResponsePromise]);
    const pluginRequestBody = pluginRequest.postDataJSON();
    record({
      check: `${browserName} submitted the independently expected bounded map area through Core`,
      expected: fixture.expectedRequest,
      actual: pluginRequestBody,
      passed:
        isMapArea(pluginRequestBody) &&
        sameMapArea(
          pluginRequestBody,
          fixture.expectedRequest.area,
          fixture.expectedRequest.coordinate_tolerance
        )
    });
    const pluginResponse = await responseObservation(rawPluginResponse);
    record({
      check: `${browserName} received the deterministic spatial fixture through the public Core Plugin route`,
      expected: {
        status: 200,
        feature_id: fixture.result.features[0].id,
        connector_id: fixture.result.provenance.connector_id,
        attribution: fixture.result.attribution.text
      },
      actual: pluginResponse,
      passed:
        pluginResponse.status === 200 &&
        isSpatialOperationResult(pluginResponse.body) &&
        pluginResponse.body.features.length === fixture.result.features.length &&
        pluginResponse.body.features[0]?.id === fixture.result.features[0].id &&
        pluginResponse.body.features[0]?.title === fixture.result.features[0].title &&
        pluginResponse.body.provenance.connector_id === fixture.result.provenance.connector_id &&
        pluginResponse.body.provenance.source === fixture.result.provenance.source &&
        pluginResponse.body.attribution.text === fixture.result.attribution.text &&
        pluginResponse.body.attribution.url === fixture.result.attribution.url
    });

    const title = fixture.operation.display_name;
    const window = page.getByRole("complementary", { name: title });
    const workspace = page.locator(".map-window-workspace");
    await checkVisible(record, window, {
      check: `${browserName} rendered the real spatial-results map window`,
      expected: { title, result_count: fixture.result.features.length },
      page
    });
    await checkVisible(record, window.getByRole("list", { name: "Spatial results" }), {
      check: `${browserName} rendered fixture results inside the map window`,
      expected: fixture.result.features[0].title,
      page
    });
    await checkVisible(
      record,
      window
        .locator(".spatial-map-window__result", { hasText: fixture.result.features[0].title })
        .filter({ hasText: fixture.result.features[0].id }),
      {
        check: `${browserName} rendered the expected fixture feature row and title`,
        expected: { feature_id: fixture.result.features[0].id, title: fixture.result.features[0].title },
        page
      }
    );

    const titleBar = window.locator(".map-window__bar");
    const initialWindowBox = await requiredBox(window, "spatial results window");
    const workspaceBox = await requiredBox(workspace, "map window workspace");
    const titleBarBox = await requiredBox(titleBar, "spatial results title bar");
    await page.mouse.move(titleBarBox.x + titleBarBox.width / 2, titleBarBox.y + titleBarBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(workspaceBox.x + workspaceBox.width - 4, workspaceBox.y + workspaceBox.height / 2, { steps: 12 });
    await page.mouse.up();
    await checkAttribute(record, window, "data-placement", "docked", {
      check: `${browserName} attached a pointer-dragged map window to the workspace edge`,
      page
    });
    await checkAttribute(record, window, "data-edge", "right", {
      check: `${browserName} selected the right edge from the pointer drag destination`,
      page
    });
    const dockedWindowBox = await requiredBox(window, "right-docked spatial results window");
    record({
      check: `${browserName} rendered the pointer-docked window against the workspace boundary`,
      expected: { workspace_right: workspaceBox.x + workspaceBox.width, changed_position: true },
      actual: {
        workspace_right: workspaceBox.x + workspaceBox.width,
        window_right: dockedWindowBox.x + dockedWindowBox.width,
        initial: initialWindowBox,
        docked: dockedWindowBox
      },
      passed:
        Math.abs(dockedWindowBox.x + dockedWindowBox.width - (workspaceBox.x + workspaceBox.width)) <= 3 &&
        Math.abs(dockedWindowBox.x - initialWindowBox.x) > 3
    });
    await captureScreenshot(page, join(artifacts, `${browserName}-pointer-docked.png`), consoleLog);

    const dockedTitleBarBox = await requiredBox(titleBar, "right-docked spatial results title bar");
    const pointerDetachStart = {
      x: dockedTitleBarBox.x + dockedTitleBarBox.width / 2,
      y: dockedTitleBarBox.y + dockedTitleBarBox.height / 2
    };
    const pointerDetachEnd = { x: pointerDetachStart.x - 96, y: pointerDetachStart.y };
    await page.mouse.move(pointerDetachStart.x, pointerDetachStart.y);
    await page.mouse.down();
    await page.mouse.move(pointerDetachEnd.x, pointerDetachEnd.y, { steps: 12 });
    await page.mouse.up();
    await checkAttribute(record, window, "data-placement", "floating", {
      check: `${browserName} detached the right-docked map window with an inward pointer drag`,
      page
    });
    await checkAttribute(record, window, "data-edge", null, {
      check: `${browserName} cleared edge attachment after the inward pointer drag`,
      page
    });
    const pointerDetachedWindowBox = await requiredBox(window, "pointer-detached spatial results window");
    record({
      check: `${browserName} moved the pointer-detached window away from the workspace boundary`,
      expected: { right_boundary_gap: ">3" },
      actual: {
        workspace_right: workspaceBox.x + workspaceBox.width,
        window_right: pointerDetachedWindowBox.x + pointerDetachedWindowBox.width
      },
      passed: workspaceBox.x + workspaceBox.width - (pointerDetachedWindowBox.x + pointerDetachedWindowBox.width) > 3
    });
    const pointerDetachedMove = window.locator("[data-map-window-move]");
    await pointerDetachedMove.focus();
    await pointerDetachedMove.press("Alt+ArrowRight");
    await checkAttribute(record, window, "data-edge", "right", {
      check: `${browserName} reattached the pointer-detached window for collapsed-handle coverage`,
      page
    });

    await window.getByRole("button", { name: `Collapse ${title} window` }).click();
    await checkAttribute(record, window, "data-collapsed", "true", {
      check: `${browserName} collapsed the attached map window into its edge handle`,
      page
    });
    const handle = window.getByRole("button", { name: new RegExp(`^Expand ${escapeRegExp(title)} window`) });
    await checkVisible(record, handle, {
      check: `${browserName} exposed the documented collapsed-handle restore control`,
      expected: `Expand ${title} window`,
      page
    });
    const peek = window.getByRole("region", { name: `${title} collapsed window details` });
    await checkVisible(record, peek, {
      check: `${browserName} kept collapsed map-window metadata and controls reachable`,
      expected: { title, result_count: fixture.result.features.length, attribution: fixture.result.attribution.text },
      page
    });
    const peekText = await peek.innerText();
    record({
      check: `${browserName} exposed the collapsed window's result count and attribution`,
      expected: { result_count: `${fixture.result.features.length} result`, attribution: fixture.result.attribution.text },
      actual: { text: peekText },
      passed: peekText.includes(`${fixture.result.features.length} result`) && peekText.includes(fixture.result.attribution.text)
    });
    const collapsedClose = peek.getByRole("button", { name: `Close ${title} window` });
    await checkVisible(record, collapsedClose, {
      check: `${browserName} exposed the actual collapsed-window close button`,
      expected: `Close ${title} window`,
      page
    });
    const collapsedCloseBox = await requiredBox(collapsedClose, "collapsed map window close button");
    record({
      check: `${browserName} kept the collapsed-window close button enabled and within the map workspace`,
      expected: { enabled: true, within_workspace: true },
      actual: { enabled: await collapsedClose.isEnabled(), control: collapsedCloseBox, workspace: workspaceBox },
      passed: (await collapsedClose.isEnabled()) && boxOverlaps(collapsedCloseBox, workspaceBox)
    });

    await focusAfterSettledFrames(handle, page);
    await handle.press("Enter");
    await checkAttribute(record, window, "data-collapsed", null, {
      check: `${browserName} restored the collapsed map window with its keyboard-reachable handle`,
      page
    });
    const restoreFocus = await window.locator(".map-window__collapse").evaluate((element) => document.activeElement === element);
    record({
      check: `${browserName} restored keyboard focus to a reachable active map-window control`,
      expected: { collapse_control_focused: true },
      actual: { collapse_control_focused: restoreFocus },
      passed: restoreFocus
    });

    const move = window.locator("[data-map-window-move]");
    await move.focus();
    await move.press("Alt+ArrowUp");
    await checkAttribute(record, window, "data-edge", "top", {
      check: `${browserName} used Alt plus ArrowUp to attach the restored window to the top edge`,
      page
    });
    const topOffsetBeforeMove = Number(await window.getAttribute("data-dock-offset"));
    await move.press("ArrowRight");
    const topOffsetAfterMove = Number(await window.getAttribute("data-dock-offset"));
    record({
      check: `${browserName} moved a top-attached window along its documented keyboard axis`,
      expected: { edge: "top", changed_offset: true },
      actual: { edge: await window.getAttribute("data-edge"), before: topOffsetBeforeMove, after: topOffsetAfterMove },
      passed:
        (await window.getAttribute("data-edge")) === "top" &&
        Number.isFinite(topOffsetBeforeMove) &&
        Number.isFinite(topOffsetAfterMove) &&
        topOffsetAfterMove > topOffsetBeforeMove
    });
    await move.press("ArrowDown");
    await checkAttribute(record, window, "data-placement", "floating", {
      check: `${browserName} used the top edge's inward ArrowDown transition to detach the window`,
      page
    });
    await checkAttribute(record, window, "data-edge", null, {
      check: `${browserName} cleared its edge attachment after keyboard detachment`,
      page
    });

    await move.focus();
    await move.press("Alt+ArrowRight");
    await checkAttribute(record, window, "data-edge", "right", {
      check: `${browserName} used the same keyboard attachment transition before resize`,
      page
    });
    await window.getByRole("button", { name: `Collapse ${title} window` }).click();
    const resizeHandle = window.getByRole("button", { name: new RegExp(`^Expand ${escapeRegExp(title)} window`) });
    await resizeHandle.focus();
    await resizeHandle.press("End");
    await page.setViewportSize({ width: 900, height: 640 });
    await waitUntil(async () => isHandleReachable(resizeHandle, workspace), 10_000, signal);
    const resizedWorkspaceBox = await requiredBox(workspace, "resized map window workspace");
    const resizedHandleBox = await requiredBox(resizeHandle, "resized collapsed map window handle");
    record({
      check: `${browserName} kept the collapsed handle reachable after viewport resizing`,
      expected: { handle_within_workspace: true, collapsed: true, edge: "right" },
      actual: {
        workspace: resizedWorkspaceBox,
        handle: resizedHandleBox,
        collapsed: await window.getAttribute("data-collapsed"),
        edge: await window.getAttribute("data-edge")
      },
      passed:
        boxContains(resizedWorkspaceBox, resizedHandleBox) &&
        (await window.getAttribute("data-collapsed")) === "true" &&
        (await window.getAttribute("data-edge")) === "right"
    });
    await captureScreenshot(page, join(artifacts, `${browserName}-viewport-resize.png`), consoleLog);
    await focusAfterSettledFrames(resizeHandle, page);
    await resizeHandle.press("Enter");
    await checkVisible(record, window.locator(".map-window__bar"), {
      check: `${browserName} restored the resized collapsed handle into a usable map window`,
      expected: "visible map window title bar",
      page
    });

    await window.getByRole("button", { name: `Collapse ${title} window` }).click();
    const movedHandle = window.getByRole("button", { name: new RegExp(`^Expand ${escapeRegExp(title)} window`) });
    const handleBeforeMove = await requiredBox(movedHandle, "collapsed map window handle");
    const offsetBeforeMove = Number(await window.getAttribute("data-dock-offset"));
    await page.mouse.move(handleBeforeMove.x + handleBeforeMove.width / 2, handleBeforeMove.y + handleBeforeMove.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBeforeMove.x + handleBeforeMove.width / 2, handleBeforeMove.y + handleBeforeMove.height / 2 + 56, {
      steps: 8
    });
    await page.mouse.up();
    const handleAfterMove = await requiredBox(movedHandle, "moved collapsed map window handle");
    const offsetAfterMove = Number(await window.getAttribute("data-dock-offset"));
    record({
      check: `${browserName} moved the collapsed handle parallel to its attached edge without restoring it`,
      expected: { placement: "docked", edge: "right", collapsed: true, changed_offset: true },
      actual: {
        placement: await window.getAttribute("data-placement"),
        edge: await window.getAttribute("data-edge"),
        collapsed: await window.getAttribute("data-collapsed"),
        offset_before: offsetBeforeMove,
        offset_after: offsetAfterMove,
        box_before: handleBeforeMove,
        box_after: handleAfterMove
      },
      passed:
        (await window.getAttribute("data-placement")) === "docked" &&
        (await window.getAttribute("data-edge")) === "right" &&
        (await window.getAttribute("data-collapsed")) === "true" &&
        Number.isFinite(offsetBeforeMove) &&
        Number.isFinite(offsetAfterMove) &&
        Math.abs(offsetAfterMove - offsetBeforeMove) > 0.001 &&
        Math.abs(handleAfterMove.y - handleBeforeMove.y) > 3
    });
    await captureScreenshot(page, join(artifacts, `${browserName}-collapsed-handle.png`), consoleLog);
    await focusAfterSettledFrames(movedHandle, page);
    await movedHandle.press("Enter");
    await checkAttribute(record, window, "data-collapsed", null, {
      check: `${browserName} restored the pointer-moved collapsed handle after its click-suppression frame settled`,
      page
    });

    await window.getByRole("button", { name: `Collapse ${title} window` }).click();
    const finalClose = window
      .getByRole("region", { name: `${title} collapsed window details` })
      .getByRole("button", { name: `Close ${title} window` });
    await finalClose.click();
    await window.waitFor({ state: "detached", timeout: 15_000 });
    record({
      check: `${browserName} activated the reachable collapsed-window close button and removed the map window`,
      expected: { remaining_windows: 0 },
      actual: { remaining_windows: await window.count() },
      passed: (await window.count()) === 0
    });

    record({
      check: `${browserName} activated the visible native MapLibre zoom control with a normal pointer click`,
      expected: { activated: true, click_completed: true, observable_map_change: true },
      actual: zoomPointerAttempt,
      passed: zoomPointerAttempt.activated && zoomPointerAttempt.click_completed && zoomPointerAttempt.observable_map_change
    });

    writeJSON(runtimePath, {
      browser_engine: browserName,
      browser_version: browser.version(),
      fixture_plugin_id: fixture.manifest.plugin_id,
      fixture_operation_id: fixture.operation.operation_id,
      map_fixture_requests: browserFixture.mapTileRequestCount(),
      status: "passed"
    });
  } catch (error) {
    failure = error;
    writeJSON(runtimePath, {
      browser_engine: browserName,
      browser_version: browser.version(),
      fixture_plugin_id: fixture.manifest.plugin_id,
      fixture_operation_id: fixture.operation.operation_id,
      map_fixture_requests: browserFixture.mapTileRequestCount(),
      status: "failed",
      failure: errorMessage(error)
    });
    if (page) {
      await page.screenshot({ path: failureScreenshot, fullPage: true }).catch((screenshotError) => {
        appendJSON(consoleLog, {
          event: "diagnostic-error",
          artifact: failureScreenshot,
          message: errorMessage(screenshotError)
        });
      });
      const html = await page.content().catch(() => undefined);
      if (html !== undefined) writeFileSync(failureHTML, html);
    }
    throw error;
  } finally {
    await Promise.allSettled([...pendingDiagnostics]);
    await context.tracing.stop({ path: tracePath }).catch((traceError) => {
      appendJSON(consoleLog, { event: "diagnostic-error", artifact: tracePath, message: errorMessage(traceError) });
    });
    await context.close().catch((closeError) => {
      appendJSON(consoleLog, { event: "diagnostic-error", target: "browser context", message: errorMessage(closeError) });
    });
    await browser.close().catch((closeError) => {
      appendJSON(consoleLog, { event: "diagnostic-error", target: "browser", message: errorMessage(closeError) });
    });
    if (failure) {
      appendJSON(consoleLog, {
        event: "journey-failure",
        message: errorMessage(failure),
        screenshot: failureScreenshot,
        html: failureHTML,
        trace: tracePath,
        reproduction
      });
    }
  }
}

function validateFixture(value) {
  if (!value || typeof value !== "object") throw new Error("map-window fixture must be an object");
  const manifest = value.manifest;
  const expectedRequest = value.expected_request;
  const result = value.result;
  if (!manifest || typeof manifest !== "object") throw new Error("map-window fixture manifest must be an object");
  if (
    !expectedRequest ||
    typeof expectedRequest !== "object" ||
    !isMapArea(expectedRequest.area) ||
    !Number.isFinite(expectedRequest.coordinate_tolerance) ||
    expectedRequest.coordinate_tolerance <= 0
  ) {
    throw new Error("map-window fixture must define an expected valid map-area request and positive tolerance");
  }
  const { core_to_plugin_protocol_major: protocolMajor, ...publicManifest } = manifest;
  if (!isPluginManifest(publicManifest)) throw new Error("map-window fixture manifest does not satisfy PluginManifest");
  if (!isSpatialOperationResult(result)) throw new Error("map-window fixture result does not satisfy SpatialOperationResult");
  if (protocolMajor !== 1) {
    throw new Error("map-window fixture must use Core-to-Plugin protocol major 1");
  }
  const operation = manifest.operations.find((candidate) => candidate.operation_id === "inspect_map_windows");
  if (!operation || operation.interaction?.kind !== "map_area") {
    throw new Error("map-window fixture must expose inspect_map_windows as a map-area operation");
  }
  if (manifest.plugin_id !== "map_windows" || result.provenance.connector_id !== manifest.plugin_id) {
    throw new Error("map-window fixture Plugin identity and result provenance must agree");
  }
  if (result.features.length !== 1 || result.features[0]?.id !== "fixture-window-area") {
    throw new Error("map-window fixture must retain its single deterministic spatial feature");
  }
  return { manifest, operation, expectedRequest, result };
}

async function waitForCoreResponse(page, coreOrigin, method, path) {
  return page.waitForResponse(
    (response) => {
      const request = response.request();
      const url = new URL(response.url());
      return request.method() === method && url.origin === coreOrigin && url.pathname === path;
    },
    { timeout: 15_000 }
  );
}

async function responseObservation(response) {
  const headers = sanitizedResponseHeaders(response.headers());
  const contentType = headers["content-type"] ?? "";
  let bodyText;
  let body;
  let parseError;
  try {
    bodyText = await response.text();
    if (contentType.includes("json")) body = JSON.parse(bodyText);
  } catch (error) {
    parseError = errorMessage(error);
  }
  return {
    status: response.status(),
    headers,
    ...(bodyText === undefined ? {} : { body_text: bodyText }),
    ...(body === undefined ? {} : { body }),
    ...(parseError ? { parse_error: parseError } : {})
  };
}

async function checkVisible(record, locator, { check, expected, page }) {
  let actual;
  try {
    await locator.waitFor({ state: "visible", timeout: 15_000 });
    actual = { visible: await locator.isVisible(), count: await locator.count() };
  } catch (error) {
    actual = {
      visible: false,
      count: await locator.count().catch(() => 0),
      url: page.url(),
      error: errorMessage(error)
    };
  }
  record({ check, expected, actual, passed: actual.visible === true && actual.count > 0 });
}

async function checkAttribute(record, locator, attribute, expected, { check, page }) {
  let actual;
  try {
    await locator.waitFor({ state: "attached", timeout: 15_000 });
    await page.waitForFunction(
      ({ attribute, expected, selector }) => document.querySelector(selector)?.getAttribute(attribute) === expected,
      { attribute, expected, selector: `#${await locator.getAttribute("id")}` },
      { timeout: 15_000 }
    );
    actual = await locator.getAttribute(attribute);
  } catch (error) {
    actual = { value: await locator.getAttribute(attribute).catch(() => null), error: errorMessage(error), url: page.url() };
  }
  record({ check, expected, actual, passed: actual === expected });
}

async function requiredBox(locator, name) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${name} must have a visible bounding box`);
  return box;
}

async function isHandleReachable(handle, workspace) {
  const [handleBox, workspaceBox, visible] = await Promise.all([
    handle.boundingBox(),
    workspace.boundingBox(),
    handle.isVisible()
  ]);
  return Boolean(handleBox && workspaceBox && visible && boxContains(workspaceBox, handleBox));
}

function boxContains(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function boxOverlaps(inner, outer) {
  return (
    inner.x < outer.x + outer.width &&
    inner.x + inner.width > outer.x &&
    inner.y < outer.y + outer.height &&
    inner.y + inner.height > outer.y
  );
}

async function focusAfterSettledFrames(locator, page) {
  await locator.focus();
  const element = await locator.elementHandle();
  if (!element) throw new Error("map window control must be attached before keyboard interaction");
  await page.waitForFunction((control) => document.activeElement === control, element, { timeout: 15_000 });
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })
  );
}

async function waitUntil(predicate, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function captureScreenshot(page, path, consoleLog) {
  await page.screenshot({ path, fullPage: true }).catch((error) => {
    appendJSON(consoleLog, { event: "diagnostic-error", artifact: path, message: errorMessage(error) });
  });
}

function attachDiagnostics(page, { consoleLog, requestLog, coreOrigin, pending }) {
  page.on("console", (message) => {
    appendJSON(consoleLog, {
      timestamp: new Date().toISOString(),
      event: "console",
      type: message.type(),
      text: message.text(),
      location: message.location()
    });
  });
  page.on("pageerror", (error) => {
    appendJSON(consoleLog, {
      timestamp: new Date().toISOString(),
      event: "pageerror",
      name: error.name,
      message: error.message,
      stack: error.stack
    });
  });
  page.on("request", (request) => {
    appendJSON(requestLog, {
      timestamp: new Date().toISOString(),
      event: "request",
      method: request.method(),
      url: request.url(),
      resource_type: request.resourceType()
    });
  });
  page.on("requestfailed", (request) => {
    appendJSON(requestLog, {
      timestamp: new Date().toISOString(),
      event: "requestfailed",
      method: request.method(),
      url: request.url(),
      resource_type: request.resourceType(),
      failure: request.failure()
    });
  });
  page.on("response", (response) => {
    const diagnostic = logResponse(response, requestLog, coreOrigin);
    pending.add(diagnostic);
    void diagnostic.finally(() => pending.delete(diagnostic));
  });
}

async function logResponse(response, requestLog, coreOrigin) {
  const headers = response.headers();
  const contentType = headers["content-type"] ?? "";
  let body;
  let bodyError;
  if (response.url().startsWith(coreOrigin) && (contentType.includes("json") || contentType.startsWith("text/"))) {
    try {
      body = await response.text();
    } catch (error) {
      bodyError = errorMessage(error);
    }
  }
  appendJSON(requestLog, {
    timestamp: new Date().toISOString(),
    event: "response",
    method: response.request().method(),
    url: response.url(),
    status: response.status(),
    headers: sanitizedResponseHeaders(headers),
    ...(body === undefined ? {} : { body }),
    ...(bodyError ? { body_error: bodyError } : {})
  });
}

function parseArguments(args) {
  let browser = "chromium";
  let headed = false;
  for (const argument of args) {
    if (argument === "--headed") {
      headed = true;
      continue;
    }
    if (argument.startsWith("--browser=")) {
      browser = argument.slice("--browser=".length);
      continue;
    }
    throw new Error(`unknown map-window acceptance argument: ${argument}`);
  }
  if (!Object.hasOwn(browserTypes, browser)) {
    throw new Error(`--browser must be chromium or webkit; received ${browser}`);
  }
  return { browser, headed };
}

function sanitizedResponseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "set-cookie"));
}

function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJSON(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function mapTileZoom(requestUrl) {
  const match = new URL(requestUrl).pathname.match(/\/256\/(\d+)\/\d+\/\d+\.png$/u);
  if (!match?.[1]) return undefined;
  return Number(match[1]);
}

function sameMapArea(actual, expected, tolerance) {
  return ["west", "south", "east", "north"].every(
    (key) => Math.abs(actual[key] - expected[key]) <= tolerance
  );
}
