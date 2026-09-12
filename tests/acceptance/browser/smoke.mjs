import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AtlasClient } from "@the-drunken-coder/atlas-sdk";
import { chromium, webkit } from "playwright";
import { runAcceptance } from "../support/stack.mjs";
import { buildCommandInterface, prepareBrowserServers } from "./support/servers.mjs";

const options = parseArguments(process.argv.slice(2));
const browserTypes = { chromium, webkit };
const browserType = browserTypes[options.browser];
const reproduction = `npm run test:acceptance:browser-smoke -- --browser=${options.browser}${options.headed ? " --headed" : ""}`;

if (!existsSync(browserType.executablePath())) {
  throw new Error(
    `Playwright ${options.browser} is required at ${browserType.executablePath()}. ` +
      `Install it with: node node_modules/playwright/cli.js install ${options.browser}`
  );
}

let fixture;

await runAcceptance({
  name: `browser-smoke-${options.browser}`,
  fixtureVariant: options.browser,
  reproduction,
  prepare: async ({ artifacts }) => {
    fixture = await prepareBrowserServers({ artifacts });
    return {
      environment: { ATLAS_ACCEPTANCE_CORS_ORIGINS: fixture.appOrigin },
      metadata: { browser_engine: options.browser, ...fixture.metadata },
      cleanup: fixture.cleanup
    };
  },
  run: async ({ runID, baseUrl, apiKey, admin, artifacts, record, signal }) => {
    if (!fixture) throw new Error("browser fixture preparation did not run");
    fixture.pointCoreAt(baseUrl);
    const buildRoot = await buildCommandInterface({ coreOrigin: fixture.coreOrigin, artifacts, signal });
    fixture.serveAppFrom(buildRoot);

    const suffix = runID.replaceAll(/[^a-z0-9]/gu, "").slice(-10);
    const entityID = `browser-smoke-${suffix}`;
    const initialAlias = `Initial browser point ${suffix}`;
    const liveAlias = `Live browser point ${suffix}`;
    const initialPosition = [-71.8023, 42.2743];
    const editedPosition = [-71.79123, 42.2743];
    const writer = new AtlasClient({ baseUrl, apiKey, sync: false, pollIntervalMs: 0, requestTimeoutMs: 10_000 });
    const created = await writer.entities.create(
      {
        entity_id: entityID,
        entity_type: "geofeature",
        alias: initialAlias,
        components: { geometry: { type: "Point", coordinates: initialPosition } }
      },
      { signal }
    );
    record({
      check: "independent SDK seeded the initial browser resource",
      expected: { entity_id: entityID, alias: initialAlias, geometry: { type: "Point", coordinates: initialPosition } },
      actual: summarizeEntity(created),
      passed:
        created.entity_id === entityID &&
        created.alias === initialAlias &&
        samePosition(created.components.geometry, initialPosition)
    });

    await runJourney({
      browserType,
      browserName: options.browser,
      headed: options.headed,
      fixture,
      writer,
      entityID,
      initialAlias,
      liveAlias,
      editedPosition,
      createdVersion: created.metadata.version,
      admin,
      artifacts,
      record,
      signal
    });
  }
});

async function runJourney({
  browserType,
  browserName,
  headed,
  fixture,
  writer,
  entityID,
  initialAlias,
  liveAlias,
  editedPosition,
  createdVersion,
  admin,
  artifacts,
  record,
  signal
}) {
  const consoleLog = join(artifacts, `${browserName}-console.jsonl`);
  const requestLog = join(artifacts, `${browserName}-requests.jsonl`);
  const tracePath = join(artifacts, `${browserName}-trace.zip`);
  const failureScreenshot = join(artifacts, `${browserName}-failure.png`);
  const failureHTML = join(artifacts, `${browserName}-failure.html`);
  const browser = await browserType.launch({ headless: !headed });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  });
  const pendingDiagnostics = new Set();
  let routedTileRequests = 0;
  let page;
  let failure;

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
    await page.goto(`${fixture.appOrigin}/map`, { waitUntil: "domcontentloaded", timeout: 20_000 });

    await checkVisible(record, page.getByRole("form", { name: "Atlas login" }), {
      check: `${browserName} displayed the public login shell`,
      expected: "Atlas login form visible",
      page
    });
    await page.getByLabel("Username").fill(admin.username);
    await page.getByLabel("Password").fill(admin.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await checkVisible(record, page.getByRole("button", { name: "Geo Features" }), {
      check: `${browserName} completed legitimate Core login`,
      expected: "authenticated Geo Features navigation visible",
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
    await waitUntil(() => fixture.mapTileRequestCount() > 0, 10_000, signal);
    record({
      check: `${browserName} loaded the deterministic local map fixture`,
      expected: { routed_tile_requests: ">0", fixture_tile_requests: ">0" },
      actual: { routed_tile_requests: routedTileRequests, fixture_tile_requests: fixture.mapTileRequestCount() },
      passed: routedTileRequests > 0 && fixture.mapTileRequestCount() > 0
    });

    await page.getByRole("button", { name: "Geo Features" }).click();
    const initialRow = page.locator(".entity-row__name", { hasText: initialAlias });
    await checkVisible(record, initialRow, {
      check: `${browserName} displayed initial Core data after login`,
      expected: initialAlias,
      page
    });

    const updated = await writer.entities.update(entityID, { alias: liveAlias }, { ifMatchVersion: createdVersion });
    await checkVisible(record, page.locator(".entity-row__name", { hasText: liveAlias }), {
      check: `${browserName} displayed an independent SDK update through the live feed`,
      expected: liveAlias,
      page
    });
    const staleAliasCount = await page.locator(".entity-row__name", { hasText: initialAlias }).count();
    record({
      check: `${browserName} replaced the stale alias after the live update`,
      expected: { stale_alias_count: 0 },
      actual: { stale_alias_count: staleAliasCount },
      passed: staleAliasCount === 0
    });

    await page.getByRole("button", { name: new RegExp(liveAlias) }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const longitude = page.getByLabel("Vertex 1 longitude");
    await checkVisible(record, longitude, {
      check: `${browserName} opened the existing geometry editor`,
      expected: "Vertex 1 longitude field visible",
      page
    });
    await longitude.fill(String(editedPosition[0]));
    await longitude.press("Tab");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await checkVisible(record, page.getByRole("button", { name: "Edit", exact: true }), {
      check: `${browserName} completed the geometry save`,
      expected: "editor closed after Core accepted the update",
      page
    });

    await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    await checkVisible(record, page.getByRole("button", { name: "Geo Features" }), {
      check: `${browserName} retained the authenticated Core session after reload`,
      expected: "authenticated workspace visible without another login",
      page
    });
    await page.getByRole("button", { name: "Geo Features" }).click();
    await checkVisible(record, page.locator(".entity-row__name", { hasText: liveAlias }), {
      check: `${browserName} reloaded the edited resource from Core`,
      expected: liveAlias,
      page
    });
    await page.getByRole("button", { name: new RegExp(liveAlias) }).click();
    const expectedSummary = `Point · ${editedPosition[1].toFixed(5)}, ${editedPosition[0].toFixed(5)}`;
    await checkVisible(record, page.getByText(expectedSummary, { exact: true }), {
      check: `${browserName} displayed the persisted geometry after reload`,
      expected: expectedSummary,
      page
    });

    const persisted = await writer.entities.get(entityID, { fresh: true, signal });
    record({
      check: `${browserName} edit persisted in real Core independently of the browser cache`,
      expected: { entity_id: entityID, alias: liveAlias, geometry: { type: "Point", coordinates: editedPosition } },
      actual: summarizeEntity(persisted),
      passed:
        persisted.entity_id === entityID &&
        persisted.alias === liveAlias &&
        persisted.metadata.version > updated.metadata.version &&
        samePosition(persisted.components.geometry, editedPosition)
    });

    const transport = fixture.transportObservations();
    const sessionCookie = (await context.cookies(fixture.coreOrigin)).find((cookie) => cookie.name === "atlas_session");
    const login = transport.find(
      (entry) => entry.event === "request" && entry.method === "POST" && entry.path === "/admin/auth/login"
    );
    const authenticatedSession = transport.find(
      (entry) =>
        entry.event === "request" &&
        entry.method === "GET" &&
        entry.path === "/admin/auth/me" &&
        entry.cookie_names.includes("atlas_session")
    );
    const feed = transport.find(
      (entry) =>
        entry.event === "upgrade" && entry.path?.startsWith("/feed") && entry.cookie_names.includes("atlas_session")
    );
    const browserEdit = transport.find(
      (entry) =>
        entry.event === "request" &&
        entry.method === "PATCH" &&
        entry.path === `/entities/${entityID}` &&
        entry.cookie_names.includes("atlas_session")
    );
    record({
      check: `${browserName} used the configured browser origin for real Core login and writes`,
      expected: { login_origin: fixture.appOrigin, edit_origin: fixture.appOrigin },
      actual: { login_origin: login?.origin, edit_origin: browserEdit?.origin },
      passed: login?.origin === fixture.appOrigin && browserEdit?.origin === fixture.appOrigin
    });
    record({
      check: `${browserName} retained Core's protected session cookie attributes`,
      expected: { name: "atlas_session", httpOnly: true, secure: true, sameSite: "None" },
      actual: sessionCookie
        ? {
            name: sessionCookie.name,
            httpOnly: sessionCookie.httpOnly,
            secure: sessionCookie.secure,
            sameSite: sessionCookie.sameSite
          }
        : null,
      passed:
        sessionCookie?.name === "atlas_session" &&
        sessionCookie.httpOnly &&
        sessionCookie.secure &&
        sessionCookie.sameSite === "None"
    });
    record({
      check: `${browserName} sent the Core session cookie for reload, feed, and edit`,
      expected: { session_check_atlas_session: true, feed_atlas_session: true, edit_atlas_session: true },
      actual: {
        session_check_atlas_session: Boolean(authenticatedSession),
        feed_atlas_session: Boolean(feed),
        edit_atlas_session: Boolean(browserEdit)
      },
      passed: Boolean(authenticatedSession && feed && browserEdit)
    });

    writeFileSync(
      join(artifacts, `${browserName}-summary.json`),
      `${JSON.stringify(
        {
          browser_engine: browserName,
          browser_version: browser.version(),
          app_origin: fixture.appOrigin,
          core_proxy_origin: fixture.coreOrigin,
          map_fixture_requests: fixture.mapTileRequestCount(),
          status: "passed"
        },
        null,
        2
      )}\n`
    );
  } catch (error) {
    failure = error;
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
      appendJSON(consoleLog, {
        event: "diagnostic-error",
        target: "browser context",
        message: errorMessage(closeError)
      });
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

async function waitUntil(predicate, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

function samePosition(geometry, expected) {
  return (
    geometry?.type === "Point" &&
    geometry.coordinates.length === expected.length &&
    geometry.coordinates.every((coordinate, index) => coordinate === expected[index])
  );
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
    throw new Error(`unknown browser smoke argument: ${argument}`);
  }
  if (!Object.hasOwn({ chromium: true, webkit: true }, browser)) {
    throw new Error(`--browser must be chromium or webkit; received ${browser}`);
  }
  return { browser, headed };
}

function sanitizedResponseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "set-cookie"));
}

function appendJSON(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
