import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AtlasAPIError, AtlasClient } from "@the-drunken-coder/atlas-sdk";
import { chromium, firefox, webkit } from "playwright";
import { runAcceptance } from "../support/stack.mjs";
import { buildCommandInterface, prepareBrowserServers } from "./support/servers.mjs";

const options = parseArguments(process.argv.slice(2));
const browserTypes = { chromium, firefox, webkit };
const browserType = browserTypes[options.browser];
const reproduction =
  "npm run test:acceptance:browser-geofeatures -- --browser=" +
  options.browser +
  (options.headed ? " --headed" : "");
const composeFixture = "tests/acceptance/browser/geofeatures-compose.yml";

if (!existsSync(browserType.executablePath())) {
  throw new Error(
    "Playwright " +
      options.browser +
      " is required at " +
      browserType.executablePath() +
      ". Install it with: node node_modules/playwright/cli.js install " +
      options.browser
  );
}

assertFixtureContracts();

let fixture;

await runAcceptance({
  name: "browser-geofeatures-" + options.browser,
  fixtureVariant: options.browser,
  reproduction,
  additionalComposeFiles: [composeFixture],
  prepare: async ({ artifacts }) => {
    fixture = await prepareBrowserServers({ artifacts });
    return {
      environment: { ATLAS_ACCEPTANCE_CORS_ORIGINS: fixture.appOrigin },
      metadata: {
        browser_engine: options.browser,
        plugin_fixture: "real Building Scan manifest and health; operation not invoked",
        ...fixture.metadata
      },
      cleanup: fixture.cleanup
    };
  },
  run: async ({ runID, baseUrl, apiKey, admin, artifacts, record, signal }) => {
    if (!fixture) throw new Error("browser fixture preparation did not run");
    fixture.pointCoreAt(baseUrl);
    const buildRoot = await buildCommandInterface({ coreOrigin: fixture.coreOrigin, artifacts, signal });
    fixture.serveAppFrom(buildRoot);

    const suffix = runID.replaceAll(/[^a-z0-9]/gu, "").slice(-10);
    const alias = "Browser line " + suffix;
    const concurrentAlias = "Concurrent line " + suffix;
    const draftAlias = "Discarded draft " + suffix;
    assertTextFixture("alias", alias, 255);
    assertTextFixture("concurrent alias", concurrentAlias, 255);
    assertTextFixture("draft alias", draftAlias, 255);

    const writer = new AtlasClient({
      baseUrl,
      apiKey,
      sync: false,
      pollIntervalMs: 0,
      requestTimeoutMs: 10_000
    });
    try {
      await runJourney({
        browserType,
        browserName: options.browser,
        headed: options.headed,
        fixture,
        writer,
        alias,
        concurrentAlias,
        draftAlias,
        admin,
        artifacts,
        record,
        signal
      });
    } finally {
      writer.sync.stop();
    }
  }
});

async function runJourney({
  browserType,
  browserName,
  headed,
  fixture,
  writer,
  alias,
  concurrentAlias,
  draftAlias,
  admin,
  artifacts,
  record,
  signal
}) {
  const consoleLog = join(artifacts, browserName + "-console.jsonl");
  const requestLog = join(artifacts, browserName + "-requests.jsonl");
  const tracePath = join(artifacts, browserName + "-trace.zip");
  const failureScreenshot = join(artifacts, browserName + "-failure.png");
  const failureHTML = join(artifacts, browserName + "-failure.html");
  const runtimePath = join(artifacts, browserName + "-runtime.json");
  const browser = await browserType.launch({ headless: !headed });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  });
  const pendingDiagnostics = new Set();
  let routedTileRequests = 0;
  let page;
  let failure;

  writeJSON(runtimePath, {
    browser_engine: browserName,
    browser_version: browser.version(),
    status: "running"
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await context.route("https://api.maptiler.com/maps/openstreetmap-dark/**", async (route) => {
    routedTileRequests += 1;
    await route.continue({ url: fixture.fixtureTileUrl });
  });

  try {
    page = await context.newPage();
    attachDiagnostics(page, {
      consoleLog,
      requestLog,
      coreOrigin: fixture.coreOrigin,
      pending: pendingDiagnostics
    });
    await page.goto(fixture.appOrigin + "/map", { waitUntil: "domcontentloaded", timeout: 20_000 });

    await checkVisible(record, page.getByRole("form", { name: "Atlas login" }), {
      check: browserName + " displayed the public login shell",
      expected: "Atlas login form visible",
      page
    });
    await page.getByLabel("Username").fill(admin.username);
    await page.getByLabel("Password").fill(admin.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await checkVisible(record, page.getByRole("button", { name: "Geo Features" }), {
      check: browserName + " completed legitimate Core login",
      expected: "authenticated Geo Features navigation visible",
      page
    });

    const mapCanvas = page.locator(".maplibregl-canvas");
    await checkVisible(record, mapCanvas, {
      check: browserName + " loaded the real MapLibre canvas",
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
      check: browserName + " used a live WebGL-backed MapLibre renderer",
      expected: { canvas: true, positive_dimensions: true, webgl2: true },
      actual: webgl,
      passed: webgl.canvas && webgl.width > 0 && webgl.height > 0 && webgl.webgl2
    });
    await waitUntil(() => fixture.mapTileRequestCount() > 0, 10_000, signal);
    record({
      check: browserName + " loaded the deterministic local map fixture",
      expected: { routed_tile_requests: ">0", fixture_tile_requests: ">0" },
      actual: {
        routed_tile_requests: routedTileRequests,
        fixture_tile_requests: fixture.mapTileRequestCount()
      },
      passed: routedTileRequests > 0 && fixture.mapTileRequestCount() > 0
    });

    const created = await createLineThroughMap({
      page,
      fixture,
      alias,
      browserName,
      record,
      signal
    });
    const entityID = created.payload.entity_id;
    const createdGeometry = created.payload.components.geometry;
    assertResourceID(entityID);

    const independentCreateRead = await writer.entities.get(entityID, { fresh: true, signal });
    record({
      check: browserName + " creation persisted through real Core",
      expected: {
        entity_id: entityID,
        entity_type: "geofeature",
        alias,
        geometry: created.coordinates,
        version: created.payload.metadata.version
      },
      actual: summarizeEntity(independentCreateRead),
      passed:
        independentCreateRead.entity_id === entityID &&
        independentCreateRead.entity_type === "geofeature" &&
        independentCreateRead.alias === alias &&
        independentCreateRead.metadata.version === created.payload.metadata.version &&
        sameGeometry(independentCreateRead.components.geometry, {
          type: "LineString",
          coordinates: created.coordinates
        })
    });

    await selectCreatedFeatureOnMap({ page, browserName, alias, record, signal });

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await checkVisible(record, page.locator('[data-vertex-key="line-0"]'), {
      check: browserName + " exposed real MapLibre vertex handles",
      expected: "three interactive line vertices",
      page
    });
    await checkCount(record, page.locator('.vertex-handle[data-vertex-key^="line-"]'), 3, {
      check: browserName + " started editing all created line vertices",
      page,
      signal
    });

    await verifyKeyboardMovement({ page, browserName, record, signal });
    await verifyPointerMovement({ page, browserName, record, signal });
    await verifyVertexDeletionAndFocus({ page, browserName, record, signal });

    const draftBeforeDrawing = await readLineCoordinateFields(page, 2);
    await verifyDrawingPrecedence({
      page,
      browserName,
      alias,
      expectedDraft: draftBeforeDrawing,
      record,
      signal
    });

    const concurrent = await writer.entities.update(
      entityID,
      { alias: concurrentAlias },
      { ifMatchVersion: created.payload.metadata.version }
    );
    await checkVisible(record, page.getByText(concurrentAlias, { exact: true }), {
      check: browserName + " displayed the independent concurrent update while retaining the edit",
      expected: concurrentAlias,
      page
    });

    const draftBeforeFailure = await readLineCoordinateFields(page, 2);
    const failedSaveResponsePromise = waitForCoreResponse(page, fixture.coreOrigin, "PATCH", "/entities/" + entityID);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const failedSaveResponse = await failedSaveResponsePromise;
    const failedSaveBody = await responseObservation(failedSaveResponse);
    record({
      check: browserName + " real stale-version save was rejected by Core",
      expected: { status: 412, error_code: "PRECONDITION_FAILED" },
      actual: failedSaveBody,
      passed:
        failedSaveBody.status === 412 &&
        failedSaveBody.body &&
        failedSaveBody.body.error_code === "PRECONDITION_FAILED"
    });

    const saveAlert = page.locator(".inspector .banner--error");
    await checkVisible(record, saveAlert, {
      check: browserName + " surfaced the failed save in the existing inspector",
      expected: "visible non-empty Core save error",
      page
    });
    const alertText = (await saveAlert.innerText()).trim();
    const draftAfterFailure = await readLineCoordinateFields(page, 2);
    const handlesAfterFailure = await page.locator('.vertex-handle[data-vertex-key^="line-"]').count();
    record({
      check: browserName + " retained the failed-save draft and editing controls",
      expected: {
        draft: draftBeforeFailure,
        line_handle_count: 2,
        save_visible: true,
        alert: "non-empty"
      },
      actual: {
        draft: draftAfterFailure,
        line_handle_count: handlesAfterFailure,
        save_visible: await page.getByRole("button", { name: "Save", exact: true }).isVisible(),
        alert: alertText
      },
      passed:
        sameCoordinates(draftAfterFailure, draftBeforeFailure) &&
        handlesAfterFailure === 2 &&
        (await page.getByRole("button", { name: "Save", exact: true }).isVisible()) &&
        alertText.length > 0
    });

    const afterFailedSave = await writer.entities.get(entityID, { fresh: true, signal });
    record({
      check: browserName + " failed browser save left the newer Core resource unchanged",
      expected: {
        entity_id: entityID,
        alias: concurrentAlias,
        geometry: createdGeometry,
        version: concurrent.metadata.version
      },
      actual: summarizeEntity(afterFailedSave),
      passed:
        afterFailedSave.alias === concurrentAlias &&
        afterFailedSave.metadata.version === concurrent.metadata.version &&
        sameGeometry(afterFailedSave.components.geometry, createdGeometry)
    });

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await checkVisible(record, page.getByRole("button", { name: "Edit", exact: true }), {
      check: browserName + " cancelled the retained failed-save edit through existing controls",
      expected: "read-only inspector restored",
      page
    });

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const successfulCoordinates = await readLineCoordinateFields(page, 3);
    const successfulLongitude = adjustedLongitude(successfulCoordinates[0][0]);
    const firstLongitude = page.getByLabel("Vertex 1 longitude");
    await firstLongitude.fill(String(successfulLongitude));
    await firstLongitude.press("Enter");

    const successfulSaveResponsePromise = waitForCoreResponse(
      page,
      fixture.coreOrigin,
      "PATCH",
      "/entities/" + entityID
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const successfulSaveResponse = await successfulSaveResponsePromise;
    const successfulSaveBody = await responseObservation(successfulSaveResponse);
    record({
      check: browserName + " accepted a current-version geometry save through the browser",
      expected: { status: 200, first_longitude: successfulLongitude },
      actual: successfulSaveBody,
      passed:
        successfulSaveBody.status === 200 &&
        successfulSaveBody.body &&
        geometryFirstLongitude(successfulSaveBody.body.components?.geometry) === successfulLongitude
    });
    await checkVisible(record, page.getByRole("button", { name: "Edit", exact: true }), {
      check: browserName + " completed the successful geometry edit",
      expected: "read-only inspector restored",
      page
    });

    await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    await checkVisible(record, page.getByRole("button", { name: "Geo Features" }), {
      check: browserName + " retained its real Core session after edit reload",
      expected: "authenticated workspace visible",
      page
    });
    await page.getByRole("button", { name: "Geo Features" }).click();
    await checkVisible(record, page.locator(".entity-row__name", { hasText: concurrentAlias }), {
      check: browserName + " reloaded the edited Geofeature from Core",
      expected: concurrentAlias,
      page
    });
    await page.getByRole("button", { name: new RegExp(escapeRegExp(concurrentAlias)) }).click();
    await checkVisible(record, page.getByText("LineString · 3 points", { exact: true }), {
      check: browserName + " displayed the reloaded persisted line geometry",
      expected: "LineString · 3 points",
      page
    });
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const reloadedLongitude = Number(await page.getByLabel("Vertex 1 longitude").inputValue());
    record({
      check: browserName + " reloaded the saved vertex coordinate into the editor",
      expected: successfulLongitude,
      actual: reloadedLongitude,
      passed: reloadedLongitude === successfulLongitude
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    const persisted = await writer.entities.get(entityID, { fresh: true, signal });
    record({
      check: browserName + " successful edit persisted independently of browser cache",
      expected: {
        entity_id: entityID,
        alias: concurrentAlias,
        first_longitude: successfulLongitude,
        version: "greater than " + concurrent.metadata.version
      },
      actual: summarizeEntity(persisted),
      passed:
        persisted.entity_id === entityID &&
        persisted.alias === concurrentAlias &&
        persisted.metadata.version > concurrent.metadata.version &&
        geometryFirstLongitude(persisted.components.geometry) === successfulLongitude
    });

    await verifyDiscardConfirmation({
      page,
      browserName,
      draftAlias,
      record
    });

    await page.getByRole("button", { name: new RegExp(escapeRegExp(concurrentAlias)) }).click();
    await verifyAndDeleteThroughBrowser({
      page,
      fixture,
      writer,
      entityID,
      concurrentAlias,
      browserName,
      record,
      signal
    });

    writeJSON(runtimePath, {
      browser_engine: browserName,
      browser_version: browser.version(),
      map_fixture_requests: fixture.mapTileRequestCount(),
      status: "passed"
    });
  } catch (error) {
    failure = error;
    writeJSON(runtimePath, {
      browser_engine: browserName,
      browser_version: browser.version(),
      map_fixture_requests: fixture.mapTileRequestCount(),
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
      appendJSON(consoleLog, {
        event: "diagnostic-error",
        artifact: tracePath,
        message: errorMessage(traceError)
      });
    });
    await context.close().catch((closeError) => {
      appendJSON(consoleLog, {
        event: "diagnostic-error",
        target: "browser context",
        message: errorMessage(closeError)
      });
    });
    await browser.close().catch((closeError) => {
      appendJSON(consoleLog, {
        event: "diagnostic-error",
        target: "browser",
        message: errorMessage(closeError)
      });
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

async function createLineThroughMap({ page, fixture, alias, browserName, record, signal }) {
  await page.getByRole("button", { name: "Geo Features" }).click();
  await page.getByRole("button", { name: "Add Geo Feature" }).click();
  await checkVisible(record, page.getByRole("textbox", { name: "Name" }), {
    check: browserName + " opened the existing Geofeature creation flow",
    expected: "focused Name field and disabled Create feature action",
    page
  });
  await page.getByRole("textbox", { name: "Name" }).fill(alias);
  await page.getByRole("button", { name: "Line", exact: true }).click();

  const drawing = page.getByTestId("geofeature-drawing");
  await checkVisible(record, drawing, {
    check: browserName + " started line drawing on the real map",
    expected: "Geofeature drawing overlay visible",
    page
  });
  const drawingBox = await requiredBox(drawing, "Geofeature drawing overlay");
  const y = Math.round(drawingBox.height * 0.5);
  const points = [
    { x: Math.round(drawingBox.width * 0.35), y },
    { x: Math.round(drawingBox.width * 0.5), y },
    { x: Math.round(drawingBox.width * 0.65), y }
  ];
  for (const point of points) {
    await drawing.click({ position: point });
  }
  await page.getByRole("button", { name: "Finish drawing", exact: true }).click();
  await checkVisible(record, page.getByLabel("Vertex 3 longitude"), {
    check: browserName + " finished a three-vertex line through map clicks",
    expected: "three editable coordinate rows",
    page
  });

  const coordinates = await readLineCoordinateFields(page, 3);
  record({
    check: browserName + " translated the three real map clicks into a valid line draft",
    expected: { type: "LineString", coordinate_count: 3, finite_positions: true },
    actual: { type: "LineString", coordinates },
    passed:
      coordinates.length === 3 &&
      coordinates.every(
        (position) =>
          position.length === 2 &&
          Number.isFinite(position[0]) &&
          Number.isFinite(position[1]) &&
          position[0] >= -180 &&
          position[0] <= 180 &&
          position[1] >= -90 &&
          position[1] <= 90
      )
  });

  const createResponsePromise = waitForCoreResponse(page, fixture.coreOrigin, "POST", "/entities");
  await page.getByRole("button", { name: "Create feature", exact: true }).click();
  const createResponse = await createResponsePromise;
  const observation = await responseObservation(createResponse);
  record({
    check: browserName + " created the Geofeature through the built browser and real Core",
    expected: {
      status: 201,
      entity_type: "geofeature",
      alias,
      geometry: { type: "LineString", coordinates }
    },
    actual: observation,
    passed:
      observation.status === 201 &&
      observation.body &&
      observation.body.entity_type === "geofeature" &&
      observation.body.alias === alias &&
      sameGeometry(observation.body.components?.geometry, { type: "LineString", coordinates })
  });
  await checkVisible(record, page.getByRole("button", { name: "Edit", exact: true }), {
    check: browserName + " opened the created Geofeature inspector",
    expected: "Edit action visible",
    page
  });
  signal.throwIfAborted();
  return { payload: observation.body, coordinates };
}

async function selectCreatedFeatureOnMap({ page, browserName, alias, record, signal }) {
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await checkVisible(record, page.locator(".entity-row__name", { hasText: alias }), {
    check: browserName + " returned to the Geofeature list before map selection",
    expected: alias,
    page
  });

  const map = page.getByTestId("map-canvas");
  const mapBox = await requiredBox(map, "map canvas");
  const candidates = [
    [0.5, 0.5],
    [0.45, 0.5],
    [0.55, 0.5],
    [0.4, 0.5],
    [0.6, 0.5]
  ];
  let targeted;
  for (const [xRatio, yRatio] of candidates) {
    signal.throwIfAborted();
    const x = mapBox.x + mapBox.width * xRatio;
    const y = mapBox.y + mapBox.height * yRatio;
    await page.mouse.move(x, y);
    const visible = await page
      .locator(".map-reticle--targeted")
      .waitFor({ state: "visible", timeout: 1_500 })
      .then(() => true)
      .catch(() => false);
    if (visible) {
      targeted = { x, y, x_ratio: xRatio, y_ratio: yRatio };
      break;
    }
  }
  record({
    check: browserName + " targeted the created Geofeature through real map hit testing",
    expected: "targeted MapLibre reticle over the created line",
    actual: targeted ?? { targeted: false, candidates },
    passed: targeted !== undefined
  });

  await page.mouse.click(targeted.x, targeted.y);
  await checkVisible(record, page.getByRole("button", { name: "Edit", exact: true }), {
    check: browserName + " selected the created Geofeature with a real map pointer",
    expected: "created Geofeature inspector visible",
    page
  });
}

async function verifyKeyboardMovement({ page, browserName, record, signal }) {
  const first = page.locator('[data-vertex-key="line-0"]');
  const before = await requiredBox(first, "first vertex handle");
  await first.focus();
  await first.press("ArrowRight");
  const afterTen = await waitForBoxDelta(first, before, { x: 10, y: 0 }, signal);
  const focusedAfterTen = await first.evaluate((element) => document.activeElement === element);
  record({
    check: browserName + " moved the focused vertex ten screen pixels with ArrowRight",
    expected: { delta_x_px: 10, delta_y_px: 0, focused: true },
    actual: { ...boxDelta(before, afterTen), focused: focusedAfterTen },
    passed: near(afterTen.x - before.x, 10, 1.5) && near(afterTen.y - before.y, 0, 1.5) && focusedAfterTen
  });

  await first.press("Shift+ArrowDown");
  const afterForty = await waitForBoxDelta(first, afterTen, { x: 0, y: 40 }, signal);
  const focusedAfterForty = await first.evaluate((element) => document.activeElement === element);
  record({
    check: browserName + " moved the focused vertex forty screen pixels with Shift+ArrowDown",
    expected: { delta_x_px: 0, delta_y_px: 40, focused: true },
    actual: { ...boxDelta(afterTen, afterForty), focused: focusedAfterForty },
    passed:
      near(afterForty.x - afterTen.x, 0, 1.5) &&
      near(afterForty.y - afterTen.y, 40, 1.5) &&
      focusedAfterForty
  });
}

async function verifyPointerMovement({ page, browserName, record, signal }) {
  const second = page.locator('[data-vertex-key="line-1"]');
  const beforeBox = await requiredBox(second, "second vertex handle");
  const beforeCoordinates = await readVertexFields(page, 2);
  const startX = beforeBox.x + beforeBox.width / 2;
  const startY = beforeBox.y + beforeBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 24, startY - 16, { steps: 4 });
  await page.mouse.up();

  const changed = await waitUntil(
    async () => {
      const next = await readVertexFields(page, 2);
      return !sameCoordinates([next], [beforeCoordinates]);
    },
    10_000,
    signal
  );
  const afterCoordinates = await readVertexFields(page, 2);
  const afterBox = await requiredBox(second, "dragged second vertex handle");
  record({
    check: browserName + " moved a vertex with a real pointer drag on MapLibre",
    expected: {
      pointer_delta_x_px: 24,
      pointer_delta_y_px: -16,
      coordinate_changed: true
    },
    actual: {
      ...boxDelta(beforeBox, afterBox),
      before_coordinates: beforeCoordinates,
      after_coordinates: afterCoordinates
    },
    passed:
      changed &&
      !sameCoordinates([afterCoordinates], [beforeCoordinates]) &&
      near(afterBox.x - beforeBox.x, 24, 2) &&
      near(afterBox.y - beforeBox.y, -16, 2)
  });
}

async function verifyVertexDeletionAndFocus({ page, browserName, record, signal }) {
  const third = page.locator('[data-vertex-key="line-2"]');
  await third.focus();
  await third.press("Delete");
  const removed = await waitUntil(
    async () => (await page.locator('.vertex-handle[data-vertex-key^="line-"]').count()) === 2,
    10_000,
    signal
  );
  const second = page.locator('[data-vertex-key="line-1"]');
  const previousFocused = await second.evaluate((element) => document.activeElement === element);
  record({
    check: browserName + " removed an allowed line vertex and focused the previous vertex",
    expected: { line_handle_count: 2, previous_vertex_focused: true },
    actual: {
      line_handle_count: await page.locator('.vertex-handle[data-vertex-key^="line-"]').count(),
      previous_vertex_focused: previousFocused
    },
    passed: removed && previousFocused
  });

  const coordinatesBeforeRefusedDelete = await readLineCoordinateFields(page, 2);
  await second.press("Delete");
  const coordinatesAfterRefusedDelete = await readLineCoordinateFields(page, 2);
  const stillFocused = await second.evaluate((element) => document.activeElement === element);
  record({
    check: browserName + " refused deletion below the valid two-point line minimum",
    expected: {
      line_handle_count: 2,
      geometry_unchanged: true,
      focused_vertex_retained: true
    },
    actual: {
      line_handle_count: await page.locator('.vertex-handle[data-vertex-key^="line-"]').count(),
      geometry_unchanged: sameCoordinates(coordinatesAfterRefusedDelete, coordinatesBeforeRefusedDelete),
      focused_vertex_retained: stillFocused
    },
    passed:
      (await page.locator('.vertex-handle[data-vertex-key^="line-"]').count()) === 2 &&
      sameCoordinates(coordinatesAfterRefusedDelete, coordinatesBeforeRefusedDelete) &&
      stillFocused
  });
}

async function verifyDrawingPrecedence({ page, browserName, alias, expectedDraft, record, signal }) {
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await checkVisible(record, page.getByRole("button", { name: /Building Scan/ }), {
    check: browserName + " discovered the real Building Scan plugin through Core",
    expected: "available Building Scan plugin",
    page
  });
  await page.getByRole("button", { name: /Building Scan/ }).click();
  await checkVisible(record, page.getByRole("button", { name: /Search buildings/ }), {
    check: browserName + " displayed Building Scan's real map-area operation",
    expected: "Search buildings operation visible",
    page
  });
  await page.getByRole("button", { name: /Search buildings/ }).click();
  await page.getByRole("button", { name: "Draw area", exact: true }).click();
  await checkVisible(record, page.getByText("Drag on the map. Escape cancels.", { exact: true }), {
    check: browserName + " entered the documented Plugin Draw area mode",
    expected: "Drag on the map. Escape cancels.",
    page
  });
  const hiddenHandleCount = await page.locator(".vertex-handle").count();
  record({
    check: browserName + " gave active drawing precedence over geometry edit handles",
    expected: { visible_edit_handle_count: 0 },
    actual: { visible_edit_handle_count: hiddenHandleCount },
    passed: hiddenHandleCount === 0
  });

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const handlesReturned = await waitUntil(
    async () => (await page.locator('.vertex-handle[data-vertex-key^="line-"]').count()) === 2,
    10_000,
    signal
  );
  record({
    check: browserName + " restored geometry edit handles when drawing ended",
    expected: { line_handle_count: 2 },
    actual: {
      line_handle_count: await page.locator('.vertex-handle[data-vertex-key^="line-"]').count()
    },
    passed: handlesReturned
  });

  await page.getByRole("button", { name: "Geo Features", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(escapeRegExp(alias)) }).click();
  await checkVisible(record, page.getByRole("button", { name: "Save", exact: true }), {
    check: browserName + " returned to the still-active geometry edit after drawing",
    expected: "Save action visible",
    page
  });
  const actualDraft = await readLineCoordinateFields(page, 2);
  record({
    check: browserName + " preserved the geometry draft while drawing owned the map",
    expected: expectedDraft,
    actual: actualDraft,
    passed: sameCoordinates(actualDraft, expectedDraft)
  });
}

async function verifyDiscardConfirmation({ page, browserName, draftAlias, record }) {
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Add Geo Feature" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(draftAlias);
  await page.getByRole("button", { name: "Point", exact: true }).click();
  const drawing = page.getByTestId("geofeature-drawing");
  const drawingBox = await requiredBox(drawing, "point drawing overlay");
  await drawing.click({
    position: {
      x: Math.round(drawingBox.width * 0.5),
      y: Math.round(drawingBox.height * 0.5)
    }
  });
  await checkVisible(record, page.getByLabel("Vertex 1 longitude"), {
    check: browserName + " created an unsaved named point draft",
    expected: "editable point draft",
    page
  });

  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  const declinedMessagePromise = handleNextDialog(page, "dismiss");
  await cancel.click();
  const declinedMessage = await declinedMessagePromise;
  const retainedName = await page.getByRole("textbox", { name: "Name" }).inputValue();
  record({
    check: browserName + " requested confirmation before discarding a named geometry draft",
    expected: {
      message: "Discard this Geo Feature draft?",
      draft_retained_after_decline: true
    },
    actual: {
      message: declinedMessage,
      retained_name: retainedName,
      geometry_visible: await page.getByLabel("Vertex 1 longitude").isVisible()
    },
    passed:
      declinedMessage === "Discard this Geo Feature draft?" &&
      retainedName === draftAlias &&
      (await page.getByLabel("Vertex 1 longitude").isVisible())
  });

  const acceptedMessagePromise = handleNextDialog(page, "accept");
  await cancel.click();
  const acceptedMessage = await acceptedMessagePromise;
  await checkVisible(record, page.getByRole("button", { name: "Add Geo Feature" }), {
    check: browserName + " discarded the draft only after confirmation",
    expected: "Geofeature list restored",
    page
  });
  record({
    check: browserName + " used the same discard confirmation for the accepted action",
    expected: "Discard this Geo Feature draft?",
    actual: acceptedMessage,
    passed: acceptedMessage === "Discard this Geo Feature draft?"
  });
}

async function verifyAndDeleteThroughBrowser({
  page,
  fixture,
  writer,
  entityID,
  concurrentAlias,
  browserName,
  record,
  signal
}) {
  const controls = await page.locator(".inspector button").evaluateAll((buttons) =>
    buttons.map((button, index) => ({
      index,
      accessible_name: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
      disabled: button.disabled
    }))
  );
  const deletionControls = controls.filter((control) => /delete|remove/iu.test(control.accessible_name));
  record({
    check: browserName + " exposed an existing browser control to delete the selected Geofeature",
    expected: {
      selected_geofeature: concurrentAlias,
      deletion_control_count: 1
    },
    actual: {
      selected_geofeature: concurrentAlias,
      inspector_controls: controls,
      deletion_controls: deletionControls
    },
    passed: deletionControls.length === 1 && deletionControls[0].disabled === false
  });

  const deleteButton = page.locator(".inspector button").nth(deletionControls[0].index);
  const deleteResponsePromise = waitForCoreResponse(page, fixture.coreOrigin, "DELETE", "/entities/" + entityID);
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await deleteButton.click();
  const deleteResponse = await deleteResponsePromise;
  const deleteObservation = await responseObservation(deleteResponse);
  record({
    check: browserName + " deleted the Geofeature through the built browser and real Core",
    expected: { status: 204 },
    actual: deleteObservation,
    passed: deleteObservation.status === 204
  });

  await checkVisible(record, page.getByRole("button", { name: "Add Geo Feature" }), {
    check: browserName + " returned to the Geofeature list after deletion",
    expected: "Geofeature list visible",
    page
  });
  const rowCount = await page.locator(".entity-row__name", { hasText: concurrentAlias }).count();
  const independentDelete = await readEntityOutcome(writer, entityID, signal);
  record({
    check: browserName + " deletion removed the Geofeature from UI and real Core",
    expected: {
      browser_row_count: 0,
      core_status: 404
    },
    actual: {
      browser_row_count: rowCount,
      core: independentDelete
    },
    passed: rowCount === 0 && independentDelete.status === 404
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
    ...(body !== undefined ? { body } : {}),
    ...(bodyError ? { body_error: bodyError } : {})
  });
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

async function checkCount(record, locator, expectedCount, { check, page, signal }) {
  const reached = await waitUntil(async () => (await locator.count()) === expectedCount, 10_000, signal);
  const actualCount = await locator.count();
  record({
    check,
    expected: { count: expectedCount },
    actual: { count: actualCount, url: page.url() },
    passed: reached && actualCount === expectedCount
  });
}

async function waitForCoreResponse(page, coreOrigin, method, pathname) {
  return page.waitForResponse(
    (response) => {
      if (response.request().method() !== method || !response.url().startsWith(coreOrigin)) return false;
      try {
        return new URL(response.url()).pathname === pathname;
      } catch {
        return false;
      }
    },
    { timeout: 15_000 }
  );
}

async function responseObservation(response) {
  const responseText = await response.text().catch(() => undefined);
  let body;
  if (responseText) {
    try {
      body = JSON.parse(responseText);
    } catch {
      body = responseText;
    }
  }
  return {
    status: response.status(),
    ...(body !== undefined ? { body } : {})
  };
}

async function readLineCoordinateFields(page, count) {
  const coordinates = [];
  for (let index = 1; index <= count; index += 1) {
    coordinates.push(await readVertexFields(page, index));
  }
  return coordinates;
}

async function readVertexFields(page, index) {
  return [
    Number(await page.getByLabel("Vertex " + index + " longitude").inputValue()),
    Number(await page.getByLabel("Vertex " + index + " latitude").inputValue())
  ];
}

async function requiredBox(locator, description) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(description + " has no rendered bounding box");
  return box;
}

async function waitForBoxDelta(locator, before, expectedDelta, signal) {
  let observed = before;
  await waitUntil(
    async () => {
      const box = await locator.boundingBox();
      if (!box) return false;
      observed = box;
      return near(box.x - before.x, expectedDelta.x, 1.5) && near(box.y - before.y, expectedDelta.y, 1.5);
    },
    10_000,
    signal
  );
  return observed;
}

async function waitUntil(predicate, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (await predicate()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return false;
}

async function handleNextDialog(page, action) {
  const dialog = await page.waitForEvent("dialog", { timeout: 10_000 });
  const message = dialog.message();
  if (action === "accept") await dialog.accept();
  else await dialog.dismiss();
  return message;
}

async function readEntityOutcome(client, entityID, signal) {
  try {
    const entity = await client.entities.get(entityID, { fresh: true, signal });
    return { status: 200, response: summarizeEntity(entity) };
  } catch (error) {
    if (error instanceof AtlasAPIError) {
      return {
        status: error.status,
        error_code: error.errorCode,
        response: error.response,
        message: error.message
      };
    }
    return {
      status: undefined,
      error: error instanceof Error ? error.name + ": " + error.message : String(error)
    };
  }
}

function summarizeEntity(entity) {
  return {
    entity_id: entity.entity_id,
    entity_type: entity.entity_type,
    alias: entity.alias,
    geometry: entity.components.geometry,
    version: entity.metadata.version
  };
}

function sameGeometry(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sameCoordinates(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function geometryFirstLongitude(geometry) {
  return geometry?.type === "LineString" ? geometry.coordinates[0]?.[0] : undefined;
}

function adjustedLongitude(longitude) {
  const adjusted = longitude <= 179.99 ? longitude + 0.01 : longitude - 0.01;
  return Number(adjusted.toFixed(8));
}

function boxDelta(before, after) {
  return {
    delta_x_px: Number((after.x - before.x).toFixed(3)),
    delta_y_px: Number((after.y - before.y).toFixed(3))
  };
}

function near(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

function assertFixtureContracts() {
  for (const browser of ["chromium", "firefox", "webkit"]) {
    assertTextFixture("browser engine", browser, 50);
  }
  assertTextFixture("plugin ID", "building_scan", 50);
  assertTextFixture("operation ID", "search_buildings", 50);
}

function assertResourceID(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/u.test(id) || id.length > 50) {
    throw new Error("browser-created Entity ID violates the current 50-character resource ID contract: " + String(id));
  }
}

function assertTextFixture(description, value, limit) {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) {
    throw new Error(description + " must contain 1 to " + limit + " characters");
  }
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
    throw new Error("unknown browser Geofeature argument: " + argument);
  }
  if (!Object.hasOwn({ chromium: true, firefox: true, webkit: true }, browser)) {
    throw new Error("--browser must be chromium, firefox, or webkit; received " + browser);
  }
  return { browser, headed };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^$(){}|[\]\\]/gu, "\\$&");
}

function sanitizedResponseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "set-cookie"));
}

function appendJSON(path, value) {
  appendFileSync(path, JSON.stringify(value) + "\n");
}

function writeJSON(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
