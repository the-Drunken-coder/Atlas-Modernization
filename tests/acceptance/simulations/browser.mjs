import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AtlasClient, isAtlasAPIError } from "@the-drunken-coder/atlas-sdk";
import { chromium, webkit } from "playwright";
import { runAcceptance } from "../support/stack.mjs";
import { createSimulationServerFixture, simulationFixtureVariant } from "./support/server-fixture.mjs";
import {
  prepareTaskFixture,
  taskFixtureCatalog,
  taskFixtureManifest,
  taskFixtureQueuedCommand,
  taskFixtureVariant
} from "./support/task-fixture.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const taskFixtureComposePath = fileURLToPath(new URL("./task-fixture.compose.yml", import.meta.url));
const options = parseArguments(process.argv.slice(2));
const browserTypes = { chromium, webkit };
const browserType = browserTypes[options.browser];
const reproduction =
  `npm run build:simulations && node tests/acceptance/simulations/browser.mjs --browser=${options.browser}` +
  (options.headed ? " --headed" : "");
const runInputs = {
  assetCount: 2,
  ticks: 100,
  tickMs: 250,
  startLatitude: 38.5,
  startLongitude: -77.25
};
const fixture = createSimulationServerFixture();

await runAcceptance({
  name: `simulations-browser-${options.browser}`,
  reproduction,
  additionalComposeFiles: [taskFixtureComposePath],
  fixtureVariant: {
    browser: options.browser,
    simulation: simulationFixtureVariant,
    task: taskFixtureVariant
  },
  prepare: prepareBrowserFixture,
  run: async ({ runID, baseUrl, apiKey, artifacts, record, signal }) => {
    const simulation = await fixture.start({ coreBaseUrl: baseUrl, apiKey, signal });
    const core = new AtlasClient({
      baseUrl,
      apiKey,
      sync: false,
      pollIntervalMs: 0,
      requestTimeoutMs: 10_000
    });
    const replacementToken = `replacement-${randomUUID()}`;
    const unrelatedEntityToken = `unrelated-entity-${randomUUID()}`;
    const unrelatedObjectToken = `unrelated-object-${randomUUID()}`;
    const unrelatedEntityID = shortID("browser-unrelated-entity");
    const unrelatedObjectID = shortID("browser-unrelated-object");
    let replacementID;

    try {
      await verifyLocalTarget(simulation.url, baseUrl, apiKey, record, signal);
      const result = await runBrowserJourney({
        browserType,
        browserName: options.browser,
        headed: options.headed,
        simulationUrl: simulation.url,
        runID,
        core,
        apiKey,
        artifacts,
        record,
        signal,
        replacementToken,
        unrelatedEntityID,
        unrelatedEntityToken,
        unrelatedObjectID,
        unrelatedObjectToken
      });
      replacementID = result.replacementID;
    } finally {
      await Promise.allSettled([
        replacementID ? core.entities.delete(replacementID, { instanceToken: replacementToken }) : Promise.resolve(),
        core.entities.delete(unrelatedEntityID, { instanceToken: unrelatedEntityToken }),
        core.objects.delete(unrelatedObjectID, { instanceToken: unrelatedObjectToken })
      ]);
      core.sync.stop();
    }
  }
});

async function prepareBrowserFixture(context) {
  requireBuiltBrowserAssets(context.artifacts);
  requireBrowserExecutable(browserType, options.browser);
  const taskFixture = prepareTaskFixture(context);
  try {
    const simulationFixture = await fixture.prepare(context);
    return {
      environment: taskFixture.environment,
      metadata: {
        browser: {
          engine: options.browser,
          executable: browserType.executablePath(),
          headed: options.headed
        },
        simulation: simulationFixture.metadata,
        task: taskFixture.metadata
      },
      cleanup: async () => {
        try {
          await simulationFixture.cleanup?.();
        } finally {
          await taskFixture.cleanup?.();
        }
      }
    };
  } catch (error) {
    await taskFixture.cleanup?.();
    throw error;
  }
}

async function runBrowserJourney({
  browserType,
  browserName,
  headed,
  simulationUrl,
  runID,
  core,
  apiKey,
  artifacts,
  record,
  signal,
  replacementToken,
  unrelatedEntityID,
  unrelatedEntityToken,
  unrelatedObjectID,
  unrelatedObjectToken
}) {
  const consoleLog = join(artifacts, `${browserName}-console.jsonl`);
  const requestLog = join(artifacts, `${browserName}-requests.jsonl`);
  const tracePath = join(artifacts, `${browserName}-trace.zip`);
  const failureScreenshot = join(artifacts, `${browserName}-failure.png`);
  const failureHTML = join(artifacts, `${browserName}-failure.html`);
  const browser = await browserType.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const observations = { eventStreams: [], mutations: [] };
  const pendingDiagnostics = new Set();
  let page;
  let failure;
  let replacementID;

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  try {
    page = await context.newPage();
    attachDiagnostics(page, { requestLog, consoleLog, simulationUrl, observations, pendingDiagnostics });
    await page.goto(simulationUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });

    await recordVisible(record, page.getByRole("heading", { name: "Atlas Simulations" }), {
      check: `${browserName} loaded the built simulation workbench`,
      expected: "Atlas Simulations heading visible",
      page
    });
    await recordVisible(record, page.getByText("Core reachable", { exact: true }), {
      check: `${browserName} workbench reached the disposable Core`,
      expected: "Core reachable status visible",
      page
    });
    const targetState = await page.evaluate(async () => {
      const response = await fetch("/api/targets", { headers: { Accept: "application/json" } });
      return { status: response.status, text: await response.text() };
    });
    const browserTargets = parseJSON(targetState.text, "browser target response");
    const keyInput = page.getByLabel("API key");
    record({
      check: `${browserName} exposes only the local target without disclosing its configured credential`,
      expected: {
        status: 200,
        default_target_id: "local",
        deployed_targets: 0,
        api_key_input_type: "password",
        api_key_input_value: "",
        credential_disclosed: false
      },
      actual: {
        status: targetState.status,
        response: browserTargets,
        deployed_targets: browserTargets.targets?.filter((target) => target.deployed).length,
        api_key_input_type: await keyInput.getAttribute("type"),
        api_key_input_value: await keyInput.inputValue(),
        credential_disclosed: targetState.text.includes(apiKey)
      },
      passed:
        targetState.status === 200 &&
        browserTargets.defaultTargetId === "local" &&
        browserTargets.targets?.length === 1 &&
        browserTargets.targets[0]?.deployed === false &&
        (await keyInput.getAttribute("type")) === "password" &&
        (await keyInput.inputValue()) === "" &&
        !targetState.text.includes(apiKey)
    });
    record({
      check: `${browserName} local journey does not show or accept deployed-target confirmation`,
      expected: { deployed_warning_count: 0, deployed_confirmation_count: 0 },
      actual: {
        deployed_warning_count: await page.getByRole("alert", { name: "Deployed Core selected" }).count(),
        deployed_confirmation_count: await page
          .getByRole("checkbox", { name: "I understand this start will mutate the deployed Core." })
          .count()
      },
      passed:
        (await page.getByRole("alert", { name: "Deployed Core selected" }).count()) === 0 &&
        (await page
          .getByRole("checkbox", { name: "I understand this start will mutate the deployed Core." })
          .count()) === 0
    });

    const scenario = page.getByRole("button", { name: /Moving assets Creates assets and updates/u });
    await recordVisible(record, scenario, {
      check: `${browserName} lists the actual moving-assets scenario`,
      expected: "Moving assets scenario visible",
      page
    });
    await scenario.click();
    await fillNumber(page, "Asset count", runInputs.assetCount);
    await fillNumber(page, "Ticks", runInputs.ticks);
    await fillNumber(page, "Tick ms", runInputs.tickMs);
    await fillNumber(page, "Start latitude", runInputs.startLatitude);
    await fillNumber(page, "Start longitude", runInputs.startLongitude);
    await page.getByLabel("JSON input").fill(JSON.stringify({ acceptance_run_id: runID }));

    const eventSourceState = await page.evaluate(() => ({
      available: typeof EventSource === "function",
      constructor: Object.prototype.toString.call(EventSource.prototype)
    }));
    record({
      check: `${browserName} provides the browser EventSource implementation used by the workbench`,
      expected: { available: true, constructor: "[object EventSource]" },
      actual: eventSourceState,
      passed: eventSourceState.available && eventSourceState.constructor === "[object EventSource]"
    });

    await page.getByRole("button", { name: "Start", exact: true }).click();
    await recordVisible(record, page.locator(".status-pill.running"), {
      check: `${browserName} starts a bounded run through the visible control`,
      expected: "running status visible",
      page
    });
    const simulationRunID = (await page.locator(".run-details dd").first().textContent())?.trim();
    if (!simulationRunID) throw new Error("The running workbench did not display a run ID");
    await recordVisible(record, page.getByText(`Telemetry tick 1/${runInputs.ticks}`, { exact: true }), {
      check: `${browserName} renders a real streamed telemetry event`,
      expected: `Telemetry tick 1/${runInputs.ticks}`,
      page
    });
    await waitUntil(() => observations.eventStreams.some((entry) => entry.status === 200), 10_000, signal);
    const stream = observations.eventStreams.find((entry) => entry.status === 200);
    record({
      check: `${browserName} observes progress through the real simulation SSE route`,
      expected: {
        url: `${simulationUrl}/api/runs/${encodeURIComponent(simulationRunID)}/events`,
        status: 200,
        content_type: "text/event-stream"
      },
      actual: stream,
      passed:
        stream?.url === `${simulationUrl}/api/runs/${encodeURIComponent(simulationRunID)}/events` &&
        stream.status === 200 &&
        stream.contentType?.startsWith("text/event-stream")
    });

    const progressRun = await readSimulationRun(simulationUrl, simulationRunID, signal);
    const entityIDs = progressRun.createdResources
      .filter((resource) => resource.type === "entity")
      .map((resource) => resource.id);
    const entities = await readEntities(core, entityIDs, signal);
    record({
      check: "independent Core reads observe the browser-started simulation resources",
      expected: {
        entity_count: runInputs.assetCount,
        simulation_run_id: simulationRunID,
        acceptance_run_id: runID
      },
      actual: entities.map(entityState),
      passed:
        entities.length === runInputs.assetCount &&
        entities.every(
          (entity) =>
            entity.components.custom_simulation?.run_id === simulationRunID &&
            entity.components.custom_simulation?.acceptance_run_id === runID
        )
    });

    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await recordVisible(record, page.locator(".status-pill.cancelled"), {
      check: `${browserName} stops the active run through the visible control`,
      expected: "cancelled status visible",
      page
    });
    await waitUntil(
      () =>
        observations.mutations.some(
          (entry) => entry.method === "POST" && entry.path.endsWith("/stop") && entry.status === 200
        ),
      10_000,
      signal
    );
    const stopped = await readSimulationRun(simulationUrl, simulationRunID, signal);
    record({
      check: "independent simulation read confirms the browser stop settled the run",
      expected: { status: "cancelled", cleaned: false },
      actual: { status: stopped.status, cleaned: stopped.cleaned },
      passed: stopped.status === "cancelled" && stopped.cleaned === false
    });

    const taskSetup = await createCompletedTask({ core, entityIDs, runID, record, signal });
    replacementID = taskSetup.replacementID;
    await core.entities.create(
      {
        entity_id: unrelatedEntityID,
        entity_type: "asset",
        alias: "unrelated browser acceptance Entity"
      },
      { instanceToken: unrelatedEntityToken, signal }
    );
    await core.objects.create(
      {
        object_id: unrelatedObjectID,
        type: "image",
        extra: { owner: "unrelated browser acceptance fixture" }
      },
      { instanceToken: unrelatedObjectToken, signal }
    );
    await core.entities.delete(replacementID, { signal });
    await core.entities.create(
      {
        entity_id: replacementID,
        entity_type: "asset",
        alias: "replacement browser acceptance Entity",
        components: { custom_simulation: { owner: "replacement" } }
      },
      { instanceToken: replacementToken, signal }
    );

    await page.getByRole("button", { name: "Cleanup", exact: true }).click();
    await recordVisible(record, page.locator(".status-pill.cleaned"), {
      check: `${browserName} completes cleanup through the visible control`,
      expected: "cleaned status visible",
      page
    });
    await recordVisible(record, page.getByText("Cleanup complete", { exact: true }), {
      check: `${browserName} renders the streamed cleanup completion event`,
      expected: "Cleanup complete",
      page
    });
    await waitUntil(
      () =>
        observations.mutations.some(
          (entry) => entry.method === "POST" && entry.path.endsWith("/cleanup") && entry.status === 200
        ),
      10_000,
      signal
    );
    const cleaned = await readSimulationRun(simulationUrl, simulationRunID, signal);
    record({
      check: "independent simulation read confirms the browser cleanup completed",
      expected: { status: "cancelled", cleaned: true, created_resources: stopped.createdResources },
      actual: {
        status: cleaned.status,
        cleaned: cleaned.cleaned,
        created_resources: cleaned.createdResources
      },
      passed:
        cleaned.status === "cancelled" &&
        cleaned.cleaned === true &&
        isDeepStrictEqual(cleaned.createdResources, stopped.createdResources)
    });
    await verifyCleanupState({
      core,
      entityIDs,
      replacementID,
      unrelatedEntityID,
      unrelatedObjectID,
      task: taskSetup.task,
      signal,
      record
    });

    await Promise.allSettled([...pendingDiagnostics]);
    const mutations = observations.mutations.filter((entry) => entry.status !== undefined);
    record({
      check: `${browserName} performs the start, stop, and cleanup mutations through the actual server`,
      expected: [
        { method: "POST", path: "/api/runs", status: 201 },
        { method: "POST", path: `/api/runs/${simulationRunID}/stop`, status: 200 },
        { method: "POST", path: `/api/runs/${simulationRunID}/cleanup`, status: 200 }
      ],
      actual: mutations,
      passed:
        mutations.some((entry) => entry.method === "POST" && entry.path === "/api/runs" && entry.status === 201) &&
        mutations.some(
          (entry) =>
            entry.method === "POST" && entry.path === `/api/runs/${simulationRunID}/stop` && entry.status === 200
        ) &&
        mutations.some(
          (entry) =>
            entry.method === "POST" && entry.path === `/api/runs/${simulationRunID}/cleanup` && entry.status === 200
        )
    });
    const diagnostics = [readOptional(consoleLog), readOptional(requestLog)].join("\n");
    record({
      check: `${browserName} browser diagnostics do not contain the configured Core API key`,
      expected: { credential_disclosed: false },
      actual: { credential_disclosed: diagnostics.includes(apiKey) },
      passed: !diagnostics.includes(apiKey)
    });
    writeFileSync(
      join(artifacts, `${browserName}-summary.json`),
      `${JSON.stringify(
        {
          browser_engine: browserName,
          browser_version: browser.version(),
          simulation_origin: simulationUrl,
          simulation_run_id: simulationRunID,
          status: "passed"
        },
        null,
        2
      )}\n`
    );
    return { replacementID };
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

async function createCompletedTask({ core, entityIDs, runID, record, signal }) {
  if (entityIDs.length !== runInputs.assetCount) {
    throw new Error(
      `Browser run expected ${runInputs.assetCount} Entity resources, observed ${JSON.stringify(entityIDs)}`
    );
  }
  const [replacementID, taskAssetID] = entityIDs;
  const catalog = await core.commandCatalog();
  record({
    check: "Task fixture overlay exposes the canonical Task conformance catalog",
    expected: taskFixtureCatalog,
    actual: catalog,
    passed: isDeepStrictEqual(catalog, taskFixtureCatalog)
  });

  const runtimeID = shortID("browser-simulation-runtime");
  const input = { value: `retain through browser cleanup ${runID}` };
  const output = { result: `completed before browser cleanup ${runID}` };
  await core.runtime.begin(taskAssetID, { runtime_id: runtimeID }, { signal });
  await core.runtime.ready(taskAssetID, { runtime_id: runtimeID, manifest: taskFixtureManifest }, { signal });
  const created = await core.tasks.create(
    { asset_id: taskAssetID, command: taskFixtureQueuedCommand, input },
    { idempotencyKey: shortID("browser-simulation-task"), signal }
  );
  const delivery = await core.runtime.tasks(taskAssetID, { runtimeId: runtimeID, signal });
  record({
    check: "registered runtime receives the nonempty browser-journey Task",
    expected: { task_id: created.task_id, input, status: "pending" },
    actual: delivery.tasks.map(taskState),
    passed:
      delivery.tasks.length === 1 &&
      matchesTask(delivery.tasks[0], { taskID: created.task_id, assetID: taskAssetID, input, status: "pending" })
  });
  await core.tasks.acknowledge(created.task_id, { runtimeId: runtimeID, signal });
  await core.tasks.start(created.task_id, { runtimeId: runtimeID, signal });
  await core.tasks.complete(created.task_id, { runtimeId: runtimeID, output, signal });
  const completed = await core.tasks.get(created.task_id, { fresh: true, signal });
  record({
    check: "runtime completes the nonempty Task before browser cleanup",
    expected: { task_id: created.task_id, asset_id: taskAssetID, input, output, status: "completed" },
    actual: taskState(completed),
    passed: matchesTask(completed, {
      taskID: created.task_id,
      assetID: taskAssetID,
      input,
      output,
      status: "completed"
    })
  });
  return { replacementID, task: { taskID: created.task_id, assetID: taskAssetID, input, output } };
}

async function verifyCleanupState({
  core,
  entityIDs,
  replacementID,
  unrelatedEntityID,
  unrelatedObjectID,
  task,
  signal,
  record
}) {
  const deletedEntityIDs = entityIDs.filter((id) => id !== replacementID);
  const missing = await Promise.all(
    deletedEntityIDs.map((id) => captureMissing(() => core.entities.get(id, { fresh: true, signal }), id))
  );
  record({
    check: "independent Core reads confirm cleanup removed each remaining run-owned Entity",
    expected: deletedEntityIDs.map((id) => ({ id, status: 404, error_code: "ENTITY_NOT_FOUND" })),
    actual: missing,
    passed:
      missing.length === deletedEntityIDs.length &&
      missing.every((entry) => entry.status === 404 && entry.error_code === "ENTITY_NOT_FOUND")
  });

  const [replacement, unrelatedEntity, unrelatedObject, retainedTask] = await Promise.all([
    core.entities.get(replacementID, { fresh: true, signal }),
    core.entities.get(unrelatedEntityID, { fresh: true, signal }),
    core.objects.get(unrelatedObjectID, { fresh: true, signal }),
    core.tasks.get(task.taskID, { fresh: true, signal })
  ]);
  record({
    check: "independent Core reads confirm ownership-safe cleanup preserves replacement and unrelated instances",
    expected: {
      replacement: { id: replacementID, alias: "replacement browser acceptance Entity" },
      unrelated_entity: { id: unrelatedEntityID, alias: "unrelated browser acceptance Entity" },
      unrelated_object: { id: unrelatedObjectID, owner: "unrelated browser acceptance fixture" }
    },
    actual: {
      replacement: { id: replacement.entity_id, alias: replacement.alias },
      unrelated_entity: { id: unrelatedEntity.entity_id, alias: unrelatedEntity.alias },
      unrelated_object: { id: unrelatedObject.object_id, owner: unrelatedObject.extra?.owner }
    },
    passed:
      replacement.entity_id === replacementID &&
      replacement.alias === "replacement browser acceptance Entity" &&
      unrelatedEntity.entity_id === unrelatedEntityID &&
      unrelatedEntity.alias === "unrelated browser acceptance Entity" &&
      unrelatedObject.object_id === unrelatedObjectID &&
      unrelatedObject.extra?.owner === "unrelated browser acceptance fixture"
  });
  record({
    check: "independent Core read confirms cleanup retains the completed nonempty Task",
    expected: {
      task_id: task.taskID,
      asset_id: task.assetID,
      command: taskFixtureQueuedCommand,
      input: task.input,
      output: task.output,
      status: "completed"
    },
    actual: taskState(retainedTask),
    passed: matchesTask(retainedTask, {
      taskID: task.taskID,
      assetID: task.assetID,
      input: task.input,
      output: task.output,
      status: "completed"
    })
  });
}

async function verifyLocalTarget(simulationUrl, coreBaseUrl, apiKey, record, signal) {
  const response = await fetch(`${simulationUrl}/api/targets`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  });
  const raw = await response.text();
  const body = parseJSON(raw, "simulation target list");
  record({
    check: "simulation server exposes only the disposable loopback target",
    expected: {
      status: 200,
      default_target_id: "local",
      targets: [{ id: "local", baseUrl: coreBaseUrl, deployed: false, apiKeyConfigured: true }],
      credential_disclosed: false
    },
    actual: {
      status: response.status,
      default_target_id: body.defaultTargetId,
      targets: body.targets,
      credential_disclosed: raw.includes(apiKey)
    },
    passed:
      response.status === 200 &&
      body.defaultTargetId === "local" &&
      body.targets?.length === 1 &&
      body.targets[0]?.id === "local" &&
      body.targets[0]?.baseUrl === coreBaseUrl &&
      body.targets[0]?.deployed === false &&
      body.targets[0]?.apiKeyConfigured === true &&
      !raw.includes(apiKey)
  });
}

function attachDiagnostics(page, { requestLog, consoleLog, simulationUrl, observations, pendingDiagnostics }) {
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
    const url = new URL(request.url());
    appendJSON(requestLog, {
      timestamp: new Date().toISOString(),
      event: "request",
      method: request.method(),
      url: request.url(),
      resource_type: request.resourceType(),
      ...(request.postData() ? { body: request.postData() } : {})
    });
    if (request.url().startsWith(simulationUrl) && request.method() === "POST") {
      observations.mutations.push({ method: request.method(), path: url.pathname });
    }
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
    const diagnostic = logResponse(response, requestLog, simulationUrl, observations);
    pendingDiagnostics.add(diagnostic);
    void diagnostic.finally(() => pendingDiagnostics.delete(diagnostic));
  });
}

async function logResponse(response, requestLog, simulationUrl, observations) {
  const request = response.request();
  const url = new URL(response.url());
  const contentType = (await response.headerValue("content-type")) ?? "";
  const summary = {
    method: request.method(),
    path: url.pathname,
    url: response.url(),
    status: response.status(),
    contentType
  };
  if (response.url().startsWith(simulationUrl) && request.method() === "POST") {
    const mutation = observations.mutations.find(
      (entry) => entry.method === request.method() && entry.path === url.pathname && entry.status === undefined
    );
    if (mutation) mutation.status = response.status();
  }
  if (response.url().startsWith(simulationUrl) && url.pathname.endsWith("/events")) {
    observations.eventStreams.push(summary);
  }
  let body;
  let bodyError;
  if (response.url().startsWith(simulationUrl) && contentType.includes("application/json")) {
    try {
      body = await response.text();
    } catch (error) {
      bodyError = errorMessage(error);
    }
  }
  appendJSON(requestLog, {
    timestamp: new Date().toISOString(),
    event: "response",
    ...summary,
    ...(body !== undefined ? { body } : {}),
    ...(bodyError ? { body_error: bodyError } : {})
  });
}

async function readSimulationRun(simulationUrl, runID, signal) {
  const response = await fetch(`${simulationUrl}/api/runs/${encodeURIComponent(runID)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Reading simulation run returned HTTP ${response.status}: ${raw}`);
  return parseJSON(raw, "simulation run response").run;
}

async function readEntities(core, ids, signal) {
  return await Promise.all(ids.map((id) => core.entities.get(id, { fresh: true, signal })));
}

async function captureMissing(operation, id) {
  try {
    await operation();
    return { id, status: 200 };
  } catch (error) {
    if (isAtlasAPIError(error)) {
      return { id, status: error.status, error_code: error.errorCode, message: error.message };
    }
    return { id, error: errorMessage(error) };
  }
}

function matchesTask(task, { taskID, assetID, input, output, status }) {
  return (
    task.task_id === taskID &&
    task.asset_id === assetID &&
    task.command === taskFixtureQueuedCommand &&
    task.status === status &&
    isDeepStrictEqual(task.input, input) &&
    (output === undefined || isDeepStrictEqual(task.output, output))
  );
}

function taskState(task) {
  return {
    task_id: task.task_id,
    asset_id: task.asset_id,
    command: task.command,
    input: task.input,
    output: task.output,
    status: task.status
  };
}

function entityState(entity) {
  return {
    entity_id: entity.entity_id,
    alias: entity.alias,
    custom_simulation: entity.components.custom_simulation
  };
}

async function recordVisible(record, locator, { check, expected, page }) {
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

async function fillNumber(page, label, value) {
  const field = page.getByLabel(label);
  await field.fill(String(value));
  await field.press("Tab");
}

async function waitUntil(predicate, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Expected browser observation within ${timeoutMs} ms`);
}

function requireBuiltBrowserAssets(artifacts) {
  const buildRoot = join(repositoryRoot, "simulations", "dist", "client");
  const indexPath = join(buildRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`Built simulation browser assets are required at ${indexPath}. Run: npm run build:simulations`);
  }
  const assetsDirectory = join(buildRoot, "assets");
  const assets = existsSync(assetsDirectory)
    ? readdirSync(assetsDirectory)
        .filter((name) => statSync(join(assetsDirectory, name)).isFile())
        .sort()
        .map((name) => ({
          name,
          bytes: statSync(join(assetsDirectory, name)).size,
          sha256: createHash("sha256")
            .update(readFileSync(join(assetsDirectory, name)))
            .digest("hex")
        }))
    : [];
  if (assets.length === 0) throw new Error(`Built simulation browser assets are missing from ${assetsDirectory}`);
  writeFileSync(
    join(artifacts, "browser-build.json"),
    `${JSON.stringify(
      {
        index: {
          path: indexPath,
          bytes: statSync(indexPath).size,
          sha256: createHash("sha256").update(readFileSync(indexPath)).digest("hex")
        },
        assets
      },
      null,
      2
    )}\n`
  );
}

function requireBrowserExecutable(type, name) {
  if (existsSync(type.executablePath())) return;
  throw new Error(
    `Playwright ${name} is required at ${type.executablePath()}. ` +
      `Install it with: node node_modules/playwright/cli.js install ${name}`
  );
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
    throw new Error(`unknown simulation browser argument: ${argument}`);
  }
  if (!Object.hasOwn({ chromium: true, webkit: true }, browser)) {
    throw new Error(`--browser must be chromium or webkit; received ${browser}`);
  }
  return { browser, headed };
}

function shortID(prefix) {
  return `${prefix}-${randomUUID()
    .replaceAll("-", "")
    .slice(0, 50 - prefix.length - 1)}`;
}

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function parseJSON(raw, description) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${description} was not valid JSON: ${raw}`);
  }
}

function appendJSON(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
