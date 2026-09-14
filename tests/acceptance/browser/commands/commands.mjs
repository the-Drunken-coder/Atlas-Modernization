import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AtlasClient, isAtlasAPIError, isAtlasTransportError } from "@the-drunken-coder/atlas-sdk";
import { chromium, webkit } from "playwright";
import { runAcceptance } from "../../support/stack.mjs";
import { prepareBrowserServers } from "../support/servers.mjs";
import { buildCommandFixture } from "./build.mjs";
import { createFeedTransportGate } from "./feed-transport-gate.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const catalogPath = join(repositoryRoot, "packages/protocol/conformance/tasking/fixtures/catalog.json");
const manifestPath = join(repositoryRoot, "packages/protocol/conformance/tasking/fixtures/manifest.json");
const composePath = fileURLToPath(new URL("./task-fixture.compose.yml", import.meta.url));
const catalogText = readFileSync(catalogPath, "utf8");
const catalog = JSON.parse(catalogText);
const manifestText = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
const queuedCommand = "fixture.queued";
const fixtureInput = { value: "browser-command-fixture" };
const options = parseArguments(process.argv.slice(2));
const browserTypes = { chromium, webkit };
const browserType = browserTypes[options.browser];
const reproduction = `npm run build:sdk && node tests/acceptance/browser/commands/commands.mjs --browser=${options.browser}${options.headed ? " --headed" : ""}`;

if (!existsSync(browserType.executablePath())) {
  throw new Error(
    `Playwright ${options.browser} is required at ${browserType.executablePath()}. ` +
      `Install it with: node node_modules/playwright/cli.js install ${options.browser}`
  );
}

let fixture;

await runAcceptance({
  name: `browser-commands-${options.browser}`,
  reproduction,
  additionalComposeFiles: [composePath],
  fixtureVariant: {
    name: "browser-command-catalog-and-input-overlay",
    catalog: "packages/protocol/conformance/tasking/fixtures/catalog.json",
    manifest: "packages/protocol/conformance/tasking/fixtures/manifest.json",
    input: "tests/acceptance/browser/commands/command-input-registry.fixture.ts"
  },
  prepare: async ({ artifacts }) => {
    const taskFixture = prepareTaskFixture(artifacts);
    try {
      const browserFixture = await prepareBrowserServers({ artifacts });
      fixture = browserFixture;
      return {
        environment: {
          ATLAS_ACCEPTANCE_COMMAND_FIXTURE_DIR: taskFixture.directory,
          ATLAS_ACCEPTANCE_CORS_ORIGINS: browserFixture.appOrigin
        },
        metadata: {
          ...taskFixture.metadata,
          ...browserFixture.metadata,
          browser_engine: options.browser,
          interaction_deadline_ms: 15_000,
          recovery_deadline_ms: 30_000,
          command_build_deadline_ms: 600_000
        },
        cleanup: async () => {
          const results = await Promise.allSettled([browserFixture.cleanup(), taskFixture.cleanup()]);
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason));
        }
      };
    } catch (error) {
      taskFixture.cleanup();
      throw error;
    }
  },
  run: async ({ runID, baseUrl, apiKey, admin, artifacts, record, signal }) => {
    if (!fixture) throw new Error("browser fixture preparation did not run");
    fixture.pointCoreAt(baseUrl);
    const buildRoot = await buildCommandFixture({ coreOrigin: fixture.coreOrigin, artifacts, signal });
    fixture.serveAppFrom(buildRoot);

    const suffix = runID.replaceAll(/[^a-z0-9]/gu, "").slice(-12);
    const assetID = `cmd-${suffix}`;
    const runtimeID = `rt-${randomUUID()}`;
    const assetAlias = `Command Fixture ${suffix}`;
    const client = new AtlasClient({
      baseUrl,
      apiKey,
      sync: false,
      pollIntervalMs: 0,
      requestTimeoutMs: 10_000
    });

    const actualCatalog = await requireAPI(record, "load the fixture Command Catalog", () => client.commandCatalog());
    record({
      check: "fixture Core exposes the canonical Task conformance catalog",
      expected: catalog,
      actual: actualCatalog,
      passed: isDeepStrictEqual(actualCatalog, catalog)
    });
    const createdAsset = await requireAPI(record, "create the browser Command Asset", () =>
      client.entities.create({ entity_id: assetID, entity_type: "asset", alias: assetAlias }, { signal })
    );
    record({
      check: "browser Command fixture uses a bounded opaque Asset identifier",
      expected: { entity_id: assetID, maximum_length: 50 },
      actual: { entity_id: createdAsset.entity_id, length: createdAsset.entity_id.length },
      passed: createdAsset.entity_id === assetID && createdAsset.entity_id.length <= 50
    });
    await requireAPI(record, "register the browser Command runtime", () =>
      client.runtime.begin(assetID, { runtime_id: runtimeID }, { signal })
    );
    await requireAPI(record, "publish the canonical browser Command manifest", () =>
      client.runtime.ready(assetID, { runtime_id: runtimeID, manifest }, { signal })
    );
    const readyAsset = await requireAPI(record, "read the runtime-ready browser Command Asset", () =>
      client.entities.get(assetID, { fresh: true, signal })
    );
    record({
      check: "real Core retains the canonical runtime manifest used by the browser",
      expected: manifest,
      actual: readyAsset.command_manifest,
      passed: isDeepStrictEqual(readyAsset.command_manifest, manifest)
    });

    await runJourney({
      browserType,
      browserName: options.browser,
      headed: options.headed,
      fixture,
      client,
      assetID,
      runtimeID,
      assetAlias,
      admin,
      artifacts,
      record,
      signal,
      reproduction
    });
  }
});

async function runJourney({
  browserType,
  browserName,
  headed,
  fixture,
  client,
  assetID,
  runtimeID,
  assetAlias,
  admin,
  artifacts,
  record,
  signal,
  reproduction
}) {
  const consoleLog = join(artifacts, `${browserName}-console.jsonl`);
  const requestLog = join(artifacts, `${browserName}-requests.jsonl`);
  const tracePath = join(artifacts, `${browserName}-trace.zip`);
  const finalScreenshot = join(artifacts, `${browserName}-final.png`);
  const failureScreenshot = join(artifacts, `${browserName}-failure.png`);
  const failureHTML = join(artifacts, `${browserName}-failure.html`);
  const feedTransportLog = join(artifacts, `${browserName}-feed-transport.jsonl`);
  const browser = await browserType.launch({ headless: !headed });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const pendingDiagnostics = new Set();
  let routedTileRequests = 0;
  let feedSevered = false;
  let page;
  let failure;

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await context.route("https://api.maptiler.com/maps/openstreetmap-dark/**", async (route) => {
    routedTileRequests += 1;
    await route.continue({ url: fixture.fixtureTileUrl });
  });
  const feedTransport = await createFeedTransportGate(context, {
    coreOrigin: fixture.coreOrigin,
    logPath: feedTransportLog
  });

  try {
    page = await context.newPage();
    attachDiagnostics(page, { consoleLog, requestLog, coreOrigin: fixture.coreOrigin, pending: pendingDiagnostics });
    await page.goto(`${fixture.appOrigin}/map`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await login(page, admin, record, browserName);
    await verifyMapRuntime(page, fixture, () => routedTileRequests, record, browserName, signal);
    await openAsset(page, assetAlias, record, browserName);
    await verifyCommandAvailable(page, record, browserName);

    const normalTask = await issueQueuedCommand(page, record, browserName, "normal issuance");
    await verifyFreshPendingTask(client, assetID, runtimeID, normalTask, record, signal, "normal issuance");
    await verifyVisibleTaskStatus(page, record, browserName, "Pending", "normal issuance");
    await transitionTask(client, runtimeID, normalTask.task_id, "acknowledged", record, signal);
    await verifyVisibleTaskStatus(page, record, browserName, "Acknowledged", "normal issuance");
    await transitionTask(client, runtimeID, normalTask.task_id, "in_progress", record, signal);
    await verifyVisibleTaskStatus(page, record, browserName, "In progress", "normal issuance");
    await progressTask(client, runtimeID, normalTask.task_id, 0.4, record, signal);
    await verifyVisibleTaskStatus(page, record, browserName, "In progress", "normal issuance", "40%");
    const normalOutput = { result: "normal command completed" };
    const normalCompleted = await completeTask(client, runtimeID, normalTask.task_id, normalOutput, record, signal);
    await verifyVisibleCompletedTask(page, normalCompleted, normalOutput, record, browserName, "normal issuance");

    const recoveryTask = await issueQueuedCommand(page, record, browserName, "connection-loss issuance");
    await verifyFreshPendingTask(client, assetID, runtimeID, recoveryTask, record, signal, "connection-loss issuance");
    await verifyVisibleTaskStatus(page, record, browserName, "Pending", "connection-loss issuance");

    const feedUpgradesBeforeSeverance = fixture
      .transportObservations()
      .filter((entry) => entry.event === "upgrade" && entry.path?.startsWith("/feed")).length;
    const severance = await feedTransport.sever();
    feedSevered = true;
    const blockedReconnect = await waitUntil(
      () => feedTransport.snapshot().blocked_connections > severance.blocked_connections,
      10_000,
      signal
    );
    const severedTransport = feedTransport.snapshot();
    const feedUpgradesWhileSevered = fixture
      .transportObservations()
      .filter((entry) => entry.event === "upgrade" && entry.path?.startsWith("/feed")).length;
    record({
      check: `${browserName} test support severed the established real Core feed before UI assessment`,
      expected: {
        upstream_feed_upgrades: ">=1",
        established_connections_closed: ">=1",
        reconnect_connections_blocked: ">=1",
        blocked_reconnect_reached_upstream: false
      },
      actual: {
        upstream_feed_upgrades_before: feedUpgradesBeforeSeverance,
        upstream_feed_upgrades_while_severed: feedUpgradesWhileSevered,
        ...severedTransport,
        wait_error: blockedReconnect.error
      },
      passed:
        feedUpgradesBeforeSeverance >= 1 &&
        severedTransport.closed_connections >= 1 &&
        severedTransport.blocked_connections >= 1 &&
        feedUpgradesWhileSevered === feedUpgradesBeforeSeverance
    });
    const connectionError = page.getByRole("button", { name: "Atlas connection error" });
    await requireVisible(record, connectionError, {
      check: `${browserName} visibly reported the live Core connection loss`,
      expected: "Atlas connection error control visible",
      page,
      timeoutMs: 30_000
    });
    await connectionError.click();
    await requireVisible(record, page.getByRole("button", { name: "Retry connection" }), {
      check: `${browserName} exposed its documented connection recovery control`,
      expected: "Retry connection button visible",
      page
    });

    await transitionTask(client, runtimeID, recoveryTask.task_id, "acknowledged", record, signal);
    await transitionTask(client, runtimeID, recoveryTask.task_id, "in_progress", record, signal);
    const recoveryOutput = { result: "completed while browser disconnected" };
    const recoveryCompleted = await completeTask(
      client,
      runtimeID,
      recoveryTask.task_id,
      recoveryOutput,
      record,
      signal
    );
    const feedTransportBeforeRecovery = feedTransport.snapshot();
    feedTransport.restore();
    feedSevered = false;
    await page.getByRole("button", { name: "Retry connection" }).click();
    await requireVisible(record, page.getByRole("status", { name: "Atlas connection Online" }), {
      check: `${browserName} recovered its real Core connection after operator retry`,
      expected: "Atlas connection Online",
      page,
      timeoutMs: 30_000
    });
    const restoredFeed = await waitUntil(
      () => feedTransport.snapshot().forwarded_connections > feedTransportBeforeRecovery.forwarded_connections,
      10_000,
      signal
    );
    const recoveredTransport = feedTransport.snapshot();
    record({
      check: `${browserName} operator retry restored a new real Core feed connection`,
      expected: { additional_forwarded_connection: true },
      actual: { ...recoveredTransport, wait_error: restoredFeed.error },
      passed: recoveredTransport.forwarded_connections > feedTransportBeforeRecovery.forwarded_connections
    });
    await verifyVisibleCompletedTask(
      page,
      recoveryCompleted,
      recoveryOutput,
      record,
      browserName,
      "connection recovery"
    );

    await verifyCommandAvailable(page, record, browserName);
    const sessionCookie = (await context.cookies(fixture.coreOrigin)).find((cookie) => cookie.name === "atlas_session");
    record({
      check: `${browserName} held Core's real protected session cookie before expiry`,
      expected: { present: true, httpOnly: true, secure: true, sameSite: "None" },
      actual: sessionCookie
        ? {
            present: true,
            httpOnly: sessionCookie.httpOnly,
            secure: sessionCookie.secure,
            sameSite: sessionCookie.sameSite
          }
        : { present: false },
      passed: Boolean(sessionCookie?.httpOnly && sessionCookie.secure && sessionCookie.sameSite === "None")
    });
    await context.clearCookies({ name: "atlas_session" });
    const expiredResponse = await issueAndCaptureTaskResponse(
      page,
      record,
      browserName,
      "session-expired issuance attempt"
    );
    const expiredPayload = await responsePayload(expiredResponse);
    record({
      check: `${browserName} received Core's real unauthorized response after browser session expiry`,
      expected: { status: 401, error_code: "UNAUTHORIZED" },
      actual: { status: expiredResponse.status(), response: expiredPayload },
      passed:
        expiredResponse.status() === 401 &&
        typeof expiredPayload === "object" &&
        expiredPayload !== null &&
        expiredPayload.error_code === "UNAUTHORIZED"
    });
    await requireVisible(record, page.getByRole("form", { name: "Atlas login" }), {
      check: `${browserName} returned to the real login shell after session expiry`,
      expected: "Atlas login form visible",
      page
    });
    await requireVisible(record, page.getByText("Your session has expired. Please sign in again.", { exact: true }), {
      check: `${browserName} explained the session-expiry recovery action`,
      expected: "Your session has expired. Please sign in again.",
      page
    });
    const deliveryAfterExpiredAttempt = await requireAPI(
      record,
      "read runtime Tasks after expired browser request",
      () => client.runtime.tasks(assetID, { runtimeId: runtimeID, signal })
    );
    record({
      check: "expired browser request did not create an authoritative Task",
      expected: { delivered_tasks: [] },
      actual: deliveryState(deliveryAfterExpiredAttempt),
      passed: deliveryAfterExpiredAttempt.tasks.length === 0
    });

    await login(page, admin, record, browserName, "after session expiry");
    await openAsset(page, assetAlias, record, browserName, "after session expiry");
    await verifyVisibleCompletedTask(
      page,
      normalCompleted,
      normalOutput,
      record,
      browserName,
      "session recovery retained normal"
    );
    await verifyVisibleCompletedTask(
      page,
      recoveryCompleted,
      recoveryOutput,
      record,
      browserName,
      "session recovery retained disconnected"
    );
    const postLoginTask = await issueQueuedCommand(page, record, browserName, "post-session recovery issuance");
    await verifyFreshPendingTask(
      client,
      assetID,
      runtimeID,
      postLoginTask,
      record,
      signal,
      "post-session recovery issuance"
    );
    const postLoginOutput = { result: "command completed after session recovery" };
    await transitionTask(client, runtimeID, postLoginTask.task_id, "acknowledged", record, signal);
    await transitionTask(client, runtimeID, postLoginTask.task_id, "in_progress", record, signal);
    const postLoginCompleted = await completeTask(
      client,
      runtimeID,
      postLoginTask.task_id,
      postLoginOutput,
      record,
      signal
    );
    await verifyVisibleCompletedTask(
      page,
      postLoginCompleted,
      postLoginOutput,
      record,
      browserName,
      "post-session recovery issuance"
    );

    const cancellationTask = await issueQueuedCommand(page, record, browserName, "cancellation issuance");
    await verifyFreshPendingTask(client, assetID, runtimeID, cancellationTask, record, signal, "cancellation issuance");
    await verifyVisibleTaskStatus(page, record, browserName, "Pending", "cancellation issuance");

    const transport = fixture.transportObservations();
    const taskRequests = transport.filter(
      (entry) => entry.event === "request" && entry.method === "POST" && entry.path === "/tasks"
    );
    const authenticatedTaskRequests = taskRequests.filter((entry) => entry.cookie_names.includes("atlas_session"));
    const unauthenticatedTaskRequests = taskRequests.filter((entry) => !entry.cookie_names.includes("atlas_session"));
    const authenticatedFeeds = transport.filter(
      (entry) =>
        entry.event === "upgrade" && entry.path?.startsWith("/feed") && entry.cookie_names.includes("atlas_session")
    );
    record({
      check: `${browserName} used real cookie-authenticated Command and reconnect transport`,
      expected: { authenticated_task_requests: 4, unauthenticated_task_requests: 1, authenticated_feeds: ">=2" },
      actual: {
        authenticated_task_requests: authenticatedTaskRequests.length,
        unauthenticated_task_requests: unauthenticatedTaskRequests.length,
        authenticated_feeds: authenticatedFeeds.length
      },
      passed:
        authenticatedTaskRequests.length === 4 &&
        unauthenticatedTaskRequests.length === 1 &&
        authenticatedFeeds.length >= 2
    });

    await cancelIssuedTaskThroughUI(page, client, cancellationTask, record, browserName, signal);

    await page.screenshot({ path: finalScreenshot, fullPage: true });
    writeFileSync(
      join(artifacts, `${browserName}-summary.json`),
      `${JSON.stringify(
        {
          browser_engine: browserName,
          browser_version: browser.version(),
          app_origin: fixture.appOrigin,
          core_proxy_origin: fixture.coreOrigin,
          map_fixture_requests: fixture.mapTileRequestCount(),
          tasks: [normalTask.task_id, recoveryTask.task_id, postLoginTask.task_id, cancellationTask.task_id],
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
          error: errorState(screenshotError)
        });
      });
      const html = await page.content().catch(() => undefined);
      if (html !== undefined) writeFileSync(failureHTML, html);
    }
    throw error;
  } finally {
    if (feedSevered) feedTransport.restore();
    await Promise.allSettled([...pendingDiagnostics]);
    await context.tracing.stop({ path: tracePath }).catch((traceError) => {
      appendJSON(consoleLog, { event: "diagnostic-error", artifact: tracePath, error: errorState(traceError) });
    });
    await context.close().catch((closeError) => {
      appendJSON(consoleLog, { event: "diagnostic-error", target: "browser context", error: errorState(closeError) });
    });
    await browser.close().catch((closeError) => {
      appendJSON(consoleLog, { event: "diagnostic-error", target: "browser", error: errorState(closeError) });
    });
    if (failure) {
      appendJSON(consoleLog, {
        event: "journey-failure",
        error: errorState(failure),
        screenshot: failureScreenshot,
        html: failureHTML,
        trace: tracePath,
        reproduction
      });
    }
  }
}

async function login(page, admin, record, browserName, phase = "initial login") {
  await requireVisible(record, page.getByRole("form", { name: "Atlas login" }), {
    check: `${browserName} displayed the public login shell for ${phase}`,
    expected: "Atlas login form visible",
    page
  });
  await page.getByLabel("Username").fill(admin.username);
  await page.getByLabel("Password").fill(admin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await requireVisible(record, page.getByRole("button", { name: "Assets" }), {
    check: `${browserName} completed ${phase} through real Core`,
    expected: "authenticated Assets navigation visible",
    page
  });
}

async function verifyMapRuntime(page, fixture, routedTileRequestCount, record, browserName, signal) {
  const mapCanvas = page.locator(".maplibregl-canvas");
  await requireVisible(record, mapCanvas, {
    check: `${browserName} loaded the real MapLibre canvas`,
    expected: "visible MapLibre canvas",
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
  const tileObservation = await waitUntil(() => fixture.mapTileRequestCount() > 0, 10_000, signal);
  record({
    check: `${browserName} loaded the deterministic map fixture through MapLibre`,
    expected: { routed_tile_requests: ">0", fixture_tile_requests: ">0" },
    actual: {
      routed_tile_requests: routedTileRequestCount(),
      fixture_tile_requests: fixture.mapTileRequestCount(),
      wait_error: tileObservation.error
    },
    passed: routedTileRequestCount() > 0 && fixture.mapTileRequestCount() > 0
  });
}

async function openAsset(page, assetAlias, record, browserName, phase = "initial load") {
  await page.getByRole("button", { name: "Assets" }).click();
  const assetRow = page.getByRole("button", { name: new RegExp(escapeRegExp(assetAlias), "u") });
  await requireVisible(record, assetRow, {
    check: `${browserName} displayed the real Command Asset on ${phase}`,
    expected: assetAlias,
    page
  });
  await assetRow.click();
}

async function verifyCommandAvailable(page, record, browserName) {
  const command = queuedCommandButton(page);
  await requireVisible(record, command, {
    check: `${browserName} displayed the canonical queued Command through the existing Command list`,
    expected: "Queued Fixture Command button visible",
    page
  });
  const actual = { enabled: await command.isEnabled(), text: await command.innerText() };
  record({
    check: `${browserName} exposed the canonical Command's runtime capabilities`,
    expected: { enabled: true, details: "Queued · Cancel yes · Progress yes" },
    actual,
    passed: actual.enabled && actual.text.includes("Queued · Cancel yes · Progress yes")
  });
}

function queuedCommandButton(page) {
  return page.getByRole("button", { name: /^Queued Fixture/u });
}

async function issueQueuedCommand(page, record, browserName, phase) {
  const response = await issueAndCaptureTaskResponse(page, record, browserName, phase);
  const payload = await responsePayload(response);
  const taskID = typeof payload === "object" && payload !== null ? payload.task_id : undefined;
  record({
    check: `${browserName} issued ${phase} through the existing Command control`,
    expected: { status: 201, command: queuedCommand, input: fixtureInput, task_id: "opaque string <=50 chars" },
    actual: { status: response.status(), response: payload },
    passed:
      response.status() === 201 &&
      typeof payload === "object" &&
      payload !== null &&
      payload.command === queuedCommand &&
      isDeepStrictEqual(payload.input, fixtureInput) &&
      payload.status === "pending" &&
      typeof taskID === "string" &&
      taskID.length > 0 &&
      taskID.length <= 50
  });
  return payload;
}

async function issueAndCaptureTaskResponse(page, record, browserName, phase) {
  try {
    const responsePromise = waitForTaskResponse(page);
    await queuedCommandButton(page).click();
    return await responsePromise;
  } catch (error) {
    record({
      check: `${browserName} produced a Task API response for ${phase}`,
      expected: { method: "POST", path: "/tasks", deadline_ms: 15_000 },
      actual: { url: page.url(), error: errorState(error) },
      passed: false
    });
  }
}

function waitForTaskResponse(page) {
  return page.waitForResponse(
    (response) => response.url().endsWith("/tasks") && response.request().method() === "POST",
    { timeout: 15_000 }
  );
}

async function verifyFreshPendingTask(client, assetID, runtimeID, browserTask, record, signal, phase) {
  const fresh = await requireAPI(record, `read authoritative Task after ${phase}`, () =>
    client.tasks.get(browserTask.task_id, { fresh: true, signal })
  );
  record({
    check: `${phase} matches authoritative Core Task state`,
    expected: {
      task_id: browserTask.task_id,
      asset_id: assetID,
      command: queuedCommand,
      input: fixtureInput,
      status: "pending"
    },
    actual: taskState(fresh),
    passed:
      fresh.task_id === browserTask.task_id &&
      fresh.asset_id === assetID &&
      fresh.command === queuedCommand &&
      isDeepStrictEqual(fresh.input, fixtureInput) &&
      fresh.status === "pending"
  });
  const delivery = await requireAPI(record, `deliver authoritative Task after ${phase}`, () =>
    client.runtime.tasks(assetID, { runtimeId: runtimeID, signal })
  );
  record({
    check: `${phase} reached the actual Asset runtime interface`,
    expected: { task_ids: [browserTask.task_id], statuses: ["pending"] },
    actual: deliveryState(delivery),
    passed:
      delivery.tasks.length === 1 &&
      delivery.tasks[0].task_id === browserTask.task_id &&
      delivery.tasks[0].status === "pending"
  });
}

async function transitionTask(client, runtimeID, taskID, expectedStatus, record, signal) {
  const operations = {
    acknowledged: () => client.tasks.acknowledge(taskID, { runtimeId: runtimeID, signal }),
    in_progress: () => client.tasks.start(taskID, { runtimeId: runtimeID, signal })
  };
  const transitioned = await requireAPI(
    record,
    `transition Task ${taskID} to ${expectedStatus}`,
    operations[expectedStatus]
  );
  const fresh = await requireAPI(record, `read Task ${taskID} after ${expectedStatus}`, () =>
    client.tasks.get(taskID, { fresh: true, signal })
  );
  record({
    check: `real runtime transition persisted authoritative ${expectedStatus} Task state`,
    expected: { task_id: taskID, status: expectedStatus },
    actual: { returned: taskState(transitioned), fresh: taskState(fresh) },
    passed: transitioned.status === expectedStatus && fresh.task_id === taskID && fresh.status === expectedStatus
  });
}

async function progressTask(client, runtimeID, taskID, progress, record, signal) {
  const progressed = await requireAPI(record, `progress Task ${taskID}`, () =>
    client.tasks.progress(taskID, { progress }, { runtimeId: runtimeID, signal })
  );
  const fresh = await requireAPI(record, `read progressed Task ${taskID}`, () =>
    client.tasks.get(taskID, { fresh: true, signal })
  );
  record({
    check: "real runtime progress persisted within the published zero-to-one range",
    expected: { task_id: taskID, status: "in_progress", progress },
    actual: { returned: taskState(progressed), fresh: taskState(fresh) },
    passed:
      progress >= 0 &&
      progress <= 1 &&
      progressed.progress === progress &&
      fresh.task_id === taskID &&
      fresh.status === "in_progress" &&
      fresh.progress === progress
  });
}

async function completeTask(client, runtimeID, taskID, output, record, signal) {
  const completed = await requireAPI(record, `complete Task ${taskID}`, () =>
    client.tasks.complete(taskID, { runtimeId: runtimeID, output, signal })
  );
  const fresh = await requireAPI(record, `read completed Task ${taskID}`, () =>
    client.tasks.get(taskID, { fresh: true, signal })
  );
  record({
    check: "real runtime completion persisted authoritative semantic output",
    expected: { task_id: taskID, status: "completed", output },
    actual: { returned: taskState(completed), fresh: taskState(fresh) },
    passed:
      completed.status === "completed" &&
      fresh.task_id === taskID &&
      fresh.status === "completed" &&
      isDeepStrictEqual(fresh.output, output)
  });
  return fresh;
}

async function verifyVisibleTaskStatus(page, record, browserName, status, phase, message) {
  const row = page.locator(".task-row").filter({ hasText: queuedCommand }).filter({ hasText: status }).first();
  await requireVisible(record, row, {
    check: `${browserName} visibly reported ${status} for ${phase}`,
    expected: message ? `${status} and ${message}` : status,
    page
  });
  const text = await row.innerText();
  record({
    check: `${browserName} Task row matched the authoritative ${status} state for ${phase}`,
    expected: { command: queuedCommand, status, ...(message ? { message } : {}) },
    actual: { text },
    passed: text.includes(queuedCommand) && text.includes(status) && (!message || text.includes(message))
  });
}

async function verifyVisibleCompletedTask(page, authoritative, output, record, browserName, phase) {
  await verifyVisibleTaskStatus(page, record, browserName, "Completed", phase, "Output available");
  const observed = await readVisibleTaskPayload(page, authoritative.task_id);
  record({
    check: `${browserName} visible Task payload matched authoritative completion for ${phase}`,
    expected: { task_id: authoritative.task_id, status: "completed", output },
    actual: observed,
    passed:
      observed.task_id === authoritative.task_id &&
      observed.status === "completed" &&
      isDeepStrictEqual(observed.output, output)
  });
}

async function cancelIssuedTaskThroughUI(page, client, task, record, browserName, signal) {
  const pendingRow = page.locator(".task-row").filter({ hasText: queuedCommand }).filter({ hasText: "Pending" }).first();
  const cancelControl = pendingRow.getByRole("button", { name: /cancel/iu });
  await requireVisible(record, cancelControl, {
    check: `${browserName} exposed an operator cancellation control for the issued pending Task`,
    expected: { task_id: task.task_id, status: "pending", cancellation_control: "visible button within Task row" },
    page
  });
  await cancelControl.click();

  let authoritative;
  const cancellation = await waitUntil(async () => {
    authoritative = await client.tasks.get(task.task_id, { fresh: true, signal });
    return authoritative.status === "cancelled";
  }, 15_000, signal);
  record({
    check: `${browserName} operator cancellation persisted authoritative cancelled Task state`,
    expected: { task_id: task.task_id, status: "cancelled" },
    actual: { task: authoritative ? taskState(authoritative) : undefined, wait_error: cancellation.error },
    passed: authoritative?.task_id === task.task_id && authoritative.status === "cancelled"
  });
  await verifyVisibleTaskStatus(page, record, browserName, "Cancelled", "cancellation issuance");
}

async function readVisibleTaskPayload(page, taskID) {
  const drawers = page.getByRole("button", { name: "Task payload", exact: true });
  const count = await drawers.count();
  const observations = [];
  for (let index = 0; index < count; index += 1) {
    const toggle = drawers.nth(index);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const drawer = toggle.locator("xpath=../..");
    const serialized = await drawer.locator("pre").textContent();
    let payload;
    try {
      payload = JSON.parse(serialized ?? "null");
    } catch (error) {
      observations.push({ parse_error: errorState(error), serialized });
      continue;
    }
    observations.push(payload);
    if (payload?.task_id === taskID) return payload;
  }
  return { task_id: undefined, searched_for: taskID, visible_payloads: observations };
}

async function requireVisible(record, locator, { check, expected, page, timeoutMs = 15_000 }) {
  let actual;
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    actual = { visible: await locator.isVisible(), count: await locator.count() };
  } catch (error) {
    actual = { visible: false, count: await locator.count().catch(() => 0), url: page.url(), error: errorState(error) };
  }
  record({ check, expected, actual, passed: actual.visible === true && actual.count > 0 });
  return locator;
}

async function requireAPI(record, description, operation) {
  try {
    return await operation();
  } catch (error) {
    record({
      check: `public API succeeded: ${description}`,
      expected: "successful Atlas response",
      actual: errorState(error),
      passed: false
    });
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
    appendJSON(consoleLog, { timestamp: new Date().toISOString(), event: "pageerror", error: errorState(error) });
  });
  page.on("request", (request) => {
    const isLogin = request.url().endsWith("/admin/auth/login");
    appendJSON(requestLog, {
      timestamp: new Date().toISOString(),
      event: "request",
      method: request.method(),
      url: request.url(),
      resource_type: request.resourceType(),
      headers: sanitizedHeaders(request.headers()),
      ...(request.postData() === null ? {} : { body: isLogin ? "[redacted login credentials]" : request.postData() })
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
      bodyError = errorState(error);
    }
  }
  appendJSON(requestLog, {
    timestamp: new Date().toISOString(),
    event: "response",
    method: response.request().method(),
    url: response.url(),
    status: response.status(),
    headers: sanitizedHeaders(headers),
    ...(body !== undefined ? { body } : {}),
    ...(bodyError ? { body_error: bodyError } : {})
  });
}

async function responsePayload(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function waitUntil(predicate, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (await predicate()) return {};
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return { error: `condition was not met within ${timeoutMs} ms` };
}

function deliveryState(delivery) {
  return { task_ids: delivery.tasks.map((task) => task.task_id), statuses: delivery.tasks.map((task) => task.status) };
}

function taskState(task) {
  return {
    task_id: task.task_id,
    asset_id: task.asset_id,
    command: task.command,
    input: task.input,
    status: task.status,
    ...(Object.hasOwn(task, "progress") ? { progress: task.progress } : {}),
    ...(Object.hasOwn(task, "output") ? { output: task.output } : {}),
    ...(Object.hasOwn(task, "failure") ? { failure: task.failure } : {}),
    ...(Object.hasOwn(task, "cancellation") ? { cancellation: task.cancellation } : {})
  };
}

function errorState(error) {
  if (isAtlasAPIError(error)) {
    return {
      name: "AtlasAPIError",
      status: error.status,
      error_code: error.errorCode,
      message: error.message,
      response: error.response
    };
  }
  if (isAtlasTransportError(error)) return { name: "AtlasTransportError", message: error.message };
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { value: String(error) };
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
    throw new Error(`unknown browser Command argument: ${argument}`);
  }
  if (!Object.hasOwn({ chromium: true, webkit: true }, browser)) {
    throw new Error(`--browser must be chromium or webkit; received ${browser}`);
  }
  return { browser, headed };
}

function sanitizedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !["authorization", "cookie", "set-cookie"].includes(name.toLowerCase()))
  );
}

function prepareTaskFixture(artifacts) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-browser-command-fixture-"));
  try {
    chmodSync(directory, 0o755);
    const replacementPath = join(directory, "command_catalog.go");
    const overlayPath = join(directory, "overlay.json");
    const replacementTarget = "/packages/protocol/generated/go/atlasprotocol/command_catalog.go";
    const replacementSource = "/acceptance-command-fixture/command_catalog.go";
    writeFileSync(
      replacementPath,
      "// Code generated for browser Command acceptance. DO NOT EDIT.\n\n" +
        "package atlasprotocol\n\n" +
        "// CommandCatalogJSON is the canonical conformance catalog embedded only in this acceptance Core.\n" +
        `const CommandCatalogJSON = ${JSON.stringify(catalogText)}\n`,
      { mode: 0o644 }
    );
    writeFileSync(
      overlayPath,
      `${JSON.stringify({ Replace: { [replacementTarget]: replacementSource } }, null, 2)}\n`,
      {
        mode: 0o644
      }
    );
    const metadata = {
      variant: "browser-command-catalog-and-input-overlay",
      catalog: {
        source: "packages/protocol/conformance/tasking/fixtures/catalog.json",
        sha256: sha256(catalogText),
        commands: catalog.map(({ command }) => command)
      },
      manifest: {
        source: "packages/protocol/conformance/tasking/fixtures/manifest.json",
        sha256: sha256(manifestText),
        commands: manifest.map(({ command }) => command)
      },
      core_overlay: { target: replacementTarget, source: replacementSource },
      browser_input_overlay: "tests/acceptance/browser/commands/command-input-registry.fixture.ts",
      cancellation_control: "unavailable in shipped Command Interface"
    };
    writeFileSync(join(artifacts, "command-fixture.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    return {
      directory,
      metadata,
      cleanup: () => rmSync(directory, { force: true, recursive: true })
    };
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function appendJSON(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}
