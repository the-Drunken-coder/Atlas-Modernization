import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  AtlasClient,
  isAtlasAPIError,
  isRFC3339Timestamp,
} from "@the-drunken-coder/atlas-sdk";
import { parseRunEvent } from "../../../simulations/src/client/run-state.ts";
import { runAcceptance } from "../support/stack.mjs";
import { parseBrowserRunSummary } from "./support/browser-run-contracts.mjs";
import { assessCancelledObservationWindow } from "./support/cancelled-observation-window.mjs";
import {
  assessCleanupCompletionOrder,
  assessCleanupResourceEvents,
  resourceKey,
} from "./support/cleanup-event-contract.mjs";
import {
  createSimulationServerFixture,
  simulationFixtureVariant,
} from "./support/server-fixture.mjs";
import {
  assessCompletedEventOrder,
  assessExpectedSuccessEvents,
  assessReplayAssertionParity,
  orderAssertionResults,
} from "./support/run-event-replay-contract.mjs";
import { eventStreamResponseError } from "./support/sse-response-contract.mjs";

const reproduction =
  "npm run build:sdk && node --import ./simulations/node_modules/tsx/dist/loader.mjs tests/acceptance/simulations/observations-objects.mjs";
const scenarioID = "observations-objects";
const nightly = process.env.ATLAS_ACCEPTANCE_NIGHTLY === "1";
const normalInputs = {
  assetCount: nightly ? 3 : 2,
  observations: nightly ? 8 : 3,
  tickMs: 50,
  startLatitude: 38.8123,
  startLongitude: -77.1634,
};
const cancellationInputs = {
  assetCount: 2,
  observations: nightly ? 8 : 5,
  tickMs: 200,
  startLatitude: 37.88,
  startLongitude: -76.04,
};
const observationJSON = { collection: "acceptance-observations" };
const standardRequestTimeoutMs = 15_000;
const cleanupRequestTimeoutMs = 35_000;
const fixture = createSimulationServerFixture();

await runAcceptance({
  name: "simulations-observations-objects",
  reproduction,
  fixtureVariant: {
    ...simulationFixtureVariant,
    cardinality: nightly ? "nightly-expanded" : "required-bounded",
  },
  prepare: fixture.prepare,
  run: async ({ runID, baseUrl, apiKey, artifacts, record, signal }) => {
    const simulation = await fixture.start({
      coreBaseUrl: baseUrl,
      apiKey,
      signal,
    });
    const api = createSimulationAPI(
      simulation.url,
      join(artifacts, "simulation-http.jsonl"),
      signal,
    );
    const core = new AtlasClient({
      baseUrl,
      apiKey,
      sync: false,
      pollIntervalMs: 0,
      requestTimeoutMs: 10_000,
    });
    const unrelatedEntityID = shortID("acpt-unrelated-observer");
    const unrelatedObjectID = shortID("acpt-unrelated-observation");
    const unrelatedEntityToken = `unrelated-entity-${randomUUID()}`;
    const unrelatedObjectToken = `unrelated-object-${randomUUID()}`;
    let replacementEntityID;
    let replacementObjectID;
    let replacementEntityToken;
    let replacementObjectToken;

    try {
      verifyServerHealth(simulation.health, baseUrl, record);
      const { target, scenarioName } = await verifyLocalTargetAndScenario(
        api,
        baseUrl,
        apiKey,
        record,
      );
      if (nightly) await recordInvalidInputFault(api, record);

      const normal = await startRun(
        api,
        normalInputs,
        observationJSON,
        target,
        scenarioName,
      );
      const normalStream = await collectRunEvents({
        api,
        runID: normal.id,
        artifactBase: join(artifacts, "observations-objects-completed"),
        signal,
        until: (events) =>
          events.some(
            (event) => event.type === "status" && event.status !== "running",
          ),
      });
      const normalSummary = await readRun(
        api,
        normal.id,
        normalInputs,
        observationJSON,
        target,
        scenarioName,
        { startedAt: normal.startedAt },
      );
      recordCompletedStream(
        normal,
        normalSummary,
        normalStream.events,
        normalInputs,
        record,
      );
      recordCreatedResourceSet(normalSummary, normalInputs, record);
      await recordPersistedObservations(
        core,
        normalSummary,
        normalInputs,
        observationJSON,
        record,
        signal,
      );

      replacementEntityID = normalSummary.createdResources.find(
        (resource) => resource.type === "entity",
      )?.id;
      replacementObjectID = normalSummary.createdResources.find(
        (resource) => resource.type === "object",
      )?.id;
      if (!replacementEntityID || !replacementObjectID) {
        throw new Error(
          "observations-objects did not expose both Entity and Object cleanup candidates",
        );
      }
      replacementEntityToken = `replacement-entity-${randomUUID()}`;
      replacementObjectToken = `replacement-object-${randomUUID()}`;
      await core.entities.create(
        {
          entity_id: unrelatedEntityID,
          entity_type: "asset",
          alias: "unrelated observations acceptance Entity",
        },
        { instanceToken: unrelatedEntityToken, signal },
      );
      await core.objects.create(
        {
          object_id: unrelatedObjectID,
          type: "observation",
          usage_hints: ["thumbnail"],
          extra: { owner: "unrelated observations acceptance Object" },
        },
        { instanceToken: unrelatedObjectToken, signal },
      );
      await core.entities.delete(replacementEntityID);
      await core.entities.create(
        {
          entity_id: replacementEntityID,
          entity_type: "asset",
          alias: "replacement observations acceptance Entity",
        },
        { instanceToken: replacementEntityToken, signal },
      );
      await core.objects.delete(replacementObjectID);
      await core.objects.create(
        {
          object_id: replacementObjectID,
          type: "observation",
          usage_hints: ["thumbnail"],
          extra: { owner: "replacement observations acceptance Object" },
        },
        { instanceToken: replacementObjectToken, signal },
      );

      recordLocalLedgerState(
        normal.id,
        simulation.cleanupLedgerDirectory,
        artifacts,
        record,
        "before completed cleanup",
      );

      const cleanedNormal = await api.json(
        "POST",
        `/api/runs/${encodeURIComponent(normal.id)}/cleanup`,
      );
      const cleanedNormalSummary = parseBrowserRunSummary(
        cleanedNormal.body.run,
        {
          context: "completed cleanup response",
          runID: normal.id,
          scenarioID,
          scenarioName,
          target,
          inputs: normalInputs,
          jsonInput: observationJSON,
          lifecycle: {
            startedAt: normal.startedAt,
            finishedAt: normalSummary.finishedAt,
          },
        },
      );
      const normalCleanupStream = await collectRunEvents({
        api,
        runID: normal.id,
        artifactBase: join(artifacts, "observations-objects-completed-cleanup"),
        signal,
        until: (events) =>
          events.some(
            (event) => event.type === "cleanup" && event.resource === undefined,
          ),
      });
      recordCleanupEvents(
        normalSummary,
        cleanedNormalSummary,
        normalCleanupStream.events,
        new Set([
          `entity:${replacementEntityID}`,
          `object:${replacementObjectID}`,
        ]),
        record,
      );
      await recordDeletedRunResources(
        core,
        normalSummary.createdResources,
        new Set([replacementEntityID, replacementObjectID]),
        signal,
        record,
        "cleanup removes the remaining run-owned observation resources",
      );
      await recordProtectedResources(
        core,
        {
          replacementEntityID,
          replacementObjectID,
          unrelatedEntityID,
          unrelatedObjectID,
        },
        signal,
        record,
      );
      recordLocalLedgerState(
        normal.id,
        simulation.cleanupLedgerDirectory,
        artifacts,
        record,
        "after completed cleanup",
      );

      const cancelled = await startRun(
        api,
        cancellationInputs,
        observationJSON,
        target,
        scenarioName,
      );
      const cancellationProgress = await collectRunEvents({
        api,
        runID: cancelled.id,
        artifactBase: join(artifacts, "observations-objects-cancel-progress"),
        signal,
        until: (events) =>
          events.some(
            (event) =>
              event.type === "log" &&
              event.message.startsWith("Observation 1 linked "),
          ) &&
          events.some(
            (event) =>
              event.type === "resource" && event.resource?.type === "object",
          ),
      });
      const cancellationProgressContract = assessExpectedSuccessEvents(
        cancellationProgress.events,
        cancelled.id,
      );
      const cancelledRun = await api.json(
        "POST",
        `/api/runs/${encodeURIComponent(cancelled.id)}/stop`,
      );
      const cancelledRunSummary = parseBrowserRunSummary(
        cancelledRun.body.run,
        {
          context: "stop response",
          runID: cancelled.id,
          scenarioID,
          scenarioName,
          target,
          inputs: cancellationInputs,
          jsonInput: observationJSON,
          lifecycle: { startedAt: cancelled.startedAt },
        },
      );
      record({
        check:
          "observations-objects accepts cancellation through its public route",
        expected: {
          status: 200,
          run_status: "cancelled",
          cleaned: false,
          event_contract: cancellationProgressContract.expected,
        },
        actual: {
          status: cancelledRun.status,
          run_status: cancelledRunSummary.status,
          cleaned: cancelledRunSummary.cleaned,
          progress_events: cancellationProgress.events.length,
          event_contract: cancellationProgressContract.actual,
        },
        passed:
          cancelledRun.status === 200 &&
          cancelledRunSummary.status === "cancelled" &&
          cancelledRunSummary.cleaned === false &&
          cancellationProgress.events.length > 0 &&
          cancellationProgressContract.passed,
      });
      const cancellationStability = await collectRunEventsForWindow({
        api,
        runID: cancelled.id,
        artifactBase: join(artifacts, "observations-objects-cancel-stability"),
        signal,
        windowMs: cancellationInputs.tickMs + 25,
      });
      const cancelledSummary = await readRun(
        api,
        cancelled.id,
        cancellationInputs,
        observationJSON,
        target,
        scenarioName,
        {
          startedAt: cancelled.startedAt,
          finishedAt: cancelledRunSummary.finishedAt,
        },
      );
      const stableResources = resourceKeys(cancelledSummary.createdResources);
      const cancellationWindow = assessCancelledObservationWindow(
        cancellationStability.snapshots,
      );
      const cancellationStabilityEvents =
        cancellationStability.snapshots.flatMap((snapshot) => snapshot.events);
      const cancellationStabilityContract = assessExpectedSuccessEvents(
        cancellationStabilityEvents,
        cancelled.id,
      );
      const cancelledResources = cancellationWindow.baseline?.resources ?? [];
      const cancelledObservationLogs =
        cancellationWindow.baseline?.observationLogs ?? [];
      const stopResponseResources = resourceKeys(
        cancelledRunSummary.createdResources,
      );
      record({
        check:
          "cancelled observations stop producing resources and observation logs after one tick",
        expected: {
          wait_ms_at_least: cancellationInputs.tickMs,
          resources: cancelledResources,
          observation_logs: cancelledObservationLogs,
          event_contract: cancellationStabilityContract.expected,
        },
        actual: {
          observed_window_ms: cancellationStability.observedWindowMs,
          snapshot_count: cancellationStability.snapshots.length,
          resources: stableResources,
          stop_response_resources: stopResponseResources,
          replay_prefix_resources: cancelledResources,
          observation_windows: cancellationWindow.states,
          event_contract: cancellationStabilityContract.actual,
        },
        passed:
          cancellationStability.observedWindowMs >= cancellationInputs.tickMs &&
          isDeepStrictEqual(stopResponseResources, cancelledResources) &&
          isDeepStrictEqual(stableResources, cancelledResources) &&
          cancellationWindow.passed &&
          cancellationStabilityContract.passed,
      });
      record({
        check: "observations reread preserves the confirmed cancelled status",
        expected: { status: cancelledRunSummary.status, cleaned: false },
        actual: {
          status: cancelledSummary.status,
          cleaned: cancelledSummary.cleaned,
        },
        passed:
          cancelledSummary.status === cancelledRunSummary.status &&
          cancelledSummary.cleaned === false,
      });
      recordCancellationAssertionPhase(
        cancellationProgress.events,
        cancellationStabilityEvents,
        cancelledRunSummary,
        cancelledSummary,
        cancellationInputs,
        record,
      );
      recordCreatedResourceSet(cancelledSummary, cancellationInputs, record);
      recordLocalLedgerState(
        cancelled.id,
        simulation.cleanupLedgerDirectory,
        artifacts,
        record,
        "before cancelled cleanup",
      );
      const cleanedCancelled = await api.json(
        "POST",
        `/api/runs/${encodeURIComponent(cancelled.id)}/cleanup`,
      );
      const cleanedCancelledSummary = parseBrowserRunSummary(
        cleanedCancelled.body.run,
        {
          context: "cancelled cleanup response",
          runID: cancelled.id,
          scenarioID,
          scenarioName,
          target,
          inputs: cancellationInputs,
          jsonInput: observationJSON,
          lifecycle: {
            startedAt: cancelled.startedAt,
            finishedAt: cancelledRunSummary.finishedAt,
          },
        },
      );
      const cancelledCleanupStream = await collectRunEvents({
        api,
        runID: cancelled.id,
        artifactBase: join(artifacts, "observations-objects-cancelled-cleanup"),
        signal,
        until: (events) =>
          events.some(
            (event) => event.type === "cleanup" && event.resource === undefined,
          ),
      });
      recordCleanupEvents(
        cancelledSummary,
        cleanedCancelledSummary,
        cancelledCleanupStream.events,
        new Set(),
        record,
      );
      await recordDeletedRunResources(
        core,
        cancelledSummary.createdResources,
        new Set(),
        signal,
        record,
        "cancelled observations-objects cleanup removes only its recorded resources",
      );
      await recordProtectedResources(
        core,
        {
          replacementEntityID,
          replacementObjectID,
          unrelatedEntityID,
          unrelatedObjectID,
        },
        signal,
        record,
        "cancelled observations cleanup preserves replacement and unrelated resource instances",
      );
      recordLocalLedgerState(
        cancelled.id,
        simulation.cleanupLedgerDirectory,
        artifacts,
        record,
        "after cancelled cleanup",
      );

      const allIDs = [
        ...normalSummary.createdResources.map((resource) => resource.id),
        ...cancelledSummary.createdResources.map((resource) => resource.id),
        unrelatedEntityID,
        unrelatedObjectID,
      ];
      record({
        check: "observation acceptance IDs stay within the Core limit",
        expected: { unique: true, maximum_length: 50 },
        actual: { ids: allIDs, lengths: allIDs.map((id) => id.length) },
        passed:
          new Set(allIDs).size === allIDs.length &&
          allIDs.every((id) => id.length <= 50),
      });
    } finally {
      await Promise.allSettled([
        replacementEntityID && replacementEntityToken
          ? core.entities.delete(replacementEntityID, {
              instanceToken: replacementEntityToken,
            })
          : Promise.resolve(),
        replacementObjectID && replacementObjectToken
          ? core.objects.delete(replacementObjectID, {
              instanceToken: replacementObjectToken,
            })
          : Promise.resolve(),
        core.entities.delete(unrelatedEntityID, {
          instanceToken: unrelatedEntityToken,
        }),
        core.objects.delete(unrelatedObjectID, {
          instanceToken: unrelatedObjectToken,
        }),
      ]);
      core.sync.stop();
    }
  },
});

function createSimulationAPI(baseUrl, logPath, acceptanceSignal) {
  const request = async (method, path, body) => {
    const startedAt = new Date().toISOString();
    const timeoutMs = path.endsWith("/cleanup")
      ? cleanupRequestTimeoutMs
      : standardRequestTimeoutMs;
    const headers = new Headers({ Accept: "application/json" });
    if (method === "POST") headers.set("X-Atlas-Simulations-Request", "1");
    if (body !== undefined) headers.set("Content-Type", "application/json");
    let response;
    let raw = "";
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([
          acceptanceSignal,
          AbortSignal.timeout(timeoutMs),
        ]),
      });
      raw = await response.text();
      const parsed = parseJSON(raw, `${method} ${path}`);
      appendJSON(logPath, {
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        method,
        path,
        ...(body === undefined ? {} : { request: body }),
        timeout_ms: timeoutMs,
        status: response.status,
        response: parsed,
      });
      return { status: response.status, body: parsed, raw };
    } catch (error) {
      appendJSON(logPath, {
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        method,
        path,
        ...(body === undefined ? {} : { request: body }),
        timeout_ms: timeoutMs,
        status: response?.status,
        raw_response: raw,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  return {
    async json(method, path, body) {
      const result = await request(method, path, body);
      if (!result.status.toString().startsWith("2")) {
        throw new Error(
          `${method} ${path} returned HTTP ${result.status}: ${result.raw}`,
        );
      }
      return result;
    },
    request,
    baseUrl,
  };
}

async function verifyLocalTargetAndScenario(api, coreBaseUrl, apiKey, record) {
  const [targets, scenarios] = await Promise.all([
    api.json("GET", "/api/targets"),
    api.json("GET", "/api/scenarios"),
  ]);
  const scenario = scenarios.body.scenarios.find(
    (candidate) => candidate.id === "observations-objects",
  );
  const target = targets.body.targets[0];
  record({
    check:
      "observations acceptance exposes only the disposable loopback target",
    expected: {
      target_id: "local",
      target_label: "Local Core",
      default_target_id: "local",
      deployed: false,
      api_key_configured: true,
      credentials_disclosed: false,
    },
    actual: {
      target_id: target?.id,
      target_label: target?.label,
      default_target_id: targets.body.defaultTargetId,
      targets: targets.body.targets,
      api_key_configured: target?.apiKeyConfigured,
      credentials_disclosed: JSON.stringify(targets.body).includes(apiKey),
    },
    passed:
      targets.body.defaultTargetId === "local" &&
      targets.body.targets.length === 1 &&
      target?.id === "local" &&
      target?.label === "Local Core" &&
      target?.baseUrl === coreBaseUrl &&
      target?.deployed === false &&
      target?.apiKeyConfigured === true &&
      !JSON.stringify(targets.body).includes(apiKey),
  });
  record({
    check: "actual server registers the observations-objects contract",
    expected: {
      scenario_id: scenarioID,
      user_visible_descriptor_text: "nonempty name, summary, and input labels",
      accepts_json: true,
      input_fields: [
        { key: "assetCount", default_value: 2, min: 1, max: 10, step: 1 },
        {
          key: "observations",
          default_value: 4,
          min: 1,
          max: 50,
          step: 1,
        },
        {
          key: "tickMs",
          default_value: 200,
          min: 0,
          max: 10_000,
          step: 50,
        },
        {
          key: "startLatitude",
          default_value: 38.88,
          min: -90,
          max: 89.9557,
          step: 0.0001,
        },
        {
          key: "startLongitude",
          default_value: -77.04,
          min: -180,
          max: 179.9459,
          step: 0.0001,
        },
      ],
    },
    actual: scenario,
    passed:
      hasScenarioDescriptorPresentation(scenario) &&
      scenario.acceptsJson === true &&
      hasExactNumberFields(scenario, [
        ["assetCount", 2, 1, 10, 1],
        ["observations", 4, 1, 50, 1],
        ["tickMs", 200, 0, 10_000, 50],
        ["startLatitude", 38.88, -90, 89.9557, 0.0001],
        ["startLongitude", -77.04, -180, 179.9459, 0.0001],
      ]),
  });
  return { target, scenarioName: scenario.name };
}

function verifyServerHealth(health, coreBaseUrl, record) {
  record({
    check: "actual simulation server reports the disposable Core healthy",
    expected: { ok: true, status: 200, base_url: coreBaseUrl },
    actual: health,
    passed:
      health.ok === true &&
      health.status === 200 &&
      health.target?.baseUrl === coreBaseUrl &&
      health.target?.deployed === false,
  });
}

async function recordInvalidInputFault(api, record) {
  const response = await api.request("POST", "/api/runs", {
    scenarioId: "observations-objects",
    targetId: "local",
    inputs: { assetCount: 0 },
  });
  record({
    check:
      "nightly observations input fault rejects an invalid asset cardinality",
    expected: { status: 400, message: "Asset count must be at least 1" },
    actual: response,
    passed:
      response.status === 400 &&
      response.body.message === "Asset count must be at least 1",
  });
}

async function startRun(api, inputs, jsonInput, target, scenarioName) {
  const response = await api.json("POST", "/api/runs", {
    scenarioId: "observations-objects",
    targetId: "local",
    inputs,
    jsonInput: JSON.stringify(jsonInput),
  });
  const run = parseBrowserRunSummary(response.body.run, {
    context: "start response",
    scenarioID,
    scenarioName,
    target,
    inputs,
    jsonInput,
  });
  if (response.status !== 201 || run.scenarioId !== scenarioID) {
    throw new Error(
      `Starting observations-objects expected HTTP 201, observed ${response.raw}`,
    );
  }
  return run;
}

async function readRun(
  api,
  runID,
  inputs,
  jsonInput,
  target,
  scenarioName,
  lifecycle,
) {
  const response = await api.json(
    "GET",
    `/api/runs/${encodeURIComponent(runID)}`,
  );
  return parseBrowserRunSummary(response.body.run, {
    context: "run read response",
    runID,
    scenarioID,
    scenarioName,
    target,
    inputs,
    jsonInput,
    lifecycle,
  });
}

function recordCompletedStream(started, completed, events, inputs, record) {
  const initial = events.at(0);
  const resources = events.filter((event) => event.type === "resource");
  const logs = events.filter((event) => event.type === "log");
  const eventContract = assessExpectedSuccessEvents(events, started.id);
  const completionOrder = assessCompletedEventOrder(events);
  const assertionReplay = assessReplayAssertionParity(
    events,
    completed.assertions,
  );
  const expectedAssertionResults = [
    { id: "assert-1", name: "Observer assets persisted", passed: true },
    { id: "assert-2", name: "Tracks persisted", passed: true },
    { id: "assert-3", name: "Object references persisted", passed: true },
  ];
  const expectedAssertionIDs = expectedAssertionResults.map(
    (assertion) => assertion.id,
  );
  const streamAssertionResults = assertionReplay.streamResults;
  const summaryAssertionResults = assertionReplay.summaryResults;
  const streamAssertionSemantics =
    streamAssertionResults.map(assertionResultState);
  const summaryAssertionSemantics =
    summaryAssertionResults.map(assertionResultState);
  const actualAssertionIDs = streamAssertionResults.map(
    (assertion) => assertion.id,
  );
  const terminal = events.find(
    (event) => event.type === "status" && event.status !== "running",
  );
  const expectedResources = completed.createdResources
    .map((resource) => `${resource.type}:${resource.id}`)
    .sort();
  const actualResources = resources
    .map((event) => `${event.resource?.type}:${event.resource?.id}`)
    .sort();
  const observersByIndex = new Map(
    completed.createdResources.flatMap((resource) => {
      const asset =
        resource.type === "entity"
          ? observerEntityIndex(completed.id, resource.id)
          : undefined;
      return asset === undefined ? [] : [[asset, resource.id]];
    }),
  );
  const tracksByObservation = new Map(
    completed.createdResources.flatMap((resource) => {
      const observation =
        resource.type === "entity"
          ? trackEntityIndex(completed.id, resource.id)
          : undefined;
      return observation === undefined ? [] : [[observation, resource.id]];
    }),
  );
  const expectedLogs = Array.from(
    { length: inputs.observations },
    (_, index) => {
      const observation = index + 1;
      return `Observation ${observation} linked ${observersByIndex.get((index % inputs.assetCount) + 1)} to ${tracksByObservation.get(observation)}`;
    },
  );
  const actualLogs = logs.map((event) => event.message);
  record({
    check: "actual server event stream completes observations-objects",
    expected: {
      start_status: "running",
      start_cleaned: false,
      start_created_resources: [],
      start_assertions: [],
      initial_event: { type: "status", status: "running" },
      status: "completed",
      completed_cleaned: false,
      resources: expectedResources,
      logs: expectedLogs,
      assertion_ids: expectedAssertionIDs,
      assertion_ids_unique: true,
      assertion_results: expectedAssertionResults,
      event_contract: eventContract.expected,
      completion_order: completionOrder.expected,
      assertion_message_parity: assertionReplay.expected,
    },
    actual: {
      started_run: {
        id: started.id,
        status: started.status,
        cleaned: started.cleaned,
        created_resources: started.createdResources,
        assertions: started.assertions,
      },
      completed_run: { status: completed.status, cleaned: completed.cleaned },
      initial,
      terminal,
      resources: actualResources,
      logs: actualLogs,
      assertion_ids: actualAssertionIDs,
      assertion_ids_unique:
        new Set(actualAssertionIDs).size === actualAssertionIDs.length,
      stream_assertion_results: streamAssertionResults,
      summary_assertion_results: summaryAssertionResults,
      event_contract: eventContract.actual,
      completion_order: completionOrder.actual,
    },
    passed:
      started.status === "running" &&
      started.cleaned === false &&
      started.createdResources.length === 0 &&
      started.assertions.length === 0 &&
      initial?.type === "status" &&
      initial.status === "running" &&
      completed.status === "completed" &&
      completed.cleaned === false &&
      terminal?.status === "completed" &&
      isDeepStrictEqual(actualResources, expectedResources) &&
      isDeepStrictEqual(actualLogs, expectedLogs) &&
      isDeepStrictEqual(actualAssertionIDs, expectedAssertionIDs) &&
      new Set(actualAssertionIDs).size === actualAssertionIDs.length &&
      isDeepStrictEqual(streamAssertionSemantics, expectedAssertionResults) &&
      isDeepStrictEqual(summaryAssertionSemantics, expectedAssertionResults) &&
      assertionReplay.passed &&
      eventContract.passed &&
      completionOrder.passed &&
      strictlyIncreasing(events.map((event) => event.sequence)),
  });
}

function resourceKeys(resources) {
  return resources.map((resource) => `${resource.type}:${resource.id}`).sort();
}

function observationLogMessages(events) {
  return events
    .filter(
      (event) =>
        event.type === "log" && event.message.startsWith("Observation "),
    )
    .map((event) => event.message);
}

function assertionResultState(assertion) {
  return {
    id: assertion?.id,
    name: assertion?.name,
    passed: assertion?.passed,
  };
}

function recordCancellationAssertionPhase(
  progressEvents,
  postStopEvents,
  stopped,
  reread,
  inputs,
  record,
) {
  const progressAssertions = orderAssertionResults(
    progressEvents
      .filter((event) => event.type === "assertion")
      .map((event) => event.assertion),
  );
  const stoppedAssertions = orderAssertionResults(stopped.assertions);
  const rereadAssertions = orderAssertionResults(reread.assertions);
  const postStopReplay = assessReplayAssertionParity(
    postStopEvents,
    reread.assertions,
  );
  const observationPairs = observedObservationPairs(progressEvents);
  const verifierAssertions = expectedVerifierAssertions(inputs);
  const allObservationPairsRecorded =
    observationPairs.length === inputs.observations &&
    observationPairs.every((observation, index) => observation === index + 1);
  const allowedAssertions = allObservationPairsRecorded
    ? (assertions) =>
        assertions.length === 0 ||
        isDeepStrictEqual(assertions, verifierAssertions)
    : (assertions) => assertions.length === 0;
  record({
    check:
      "cancelled observations preserve only source-valid verifier assertions across the stop phase",
    expected: {
      pre_stop_observation_pairs: inputs.observations,
      ...(allObservationPairsRecorded
        ? { allowed_assertions: [[], verifierAssertions] }
        : { allowed_assertions: [] }),
      pre_stop_assertions_retained_by_stop_summary: true,
      stop_assertions_retained_by_cancelled_summary: true,
      post_stop_replay_matches_cancelled_summary: postStopReplay.expected,
    },
    actual: {
      pre_stop_observation_pairs: observationPairs,
      pre_stop_assertions: progressAssertions,
      stop_summary_assertions: stoppedAssertions,
      cancelled_summary_assertions: rereadAssertions,
      post_stop_replay: postStopReplay.actual,
    },
    passed:
      hasUniqueAssertionIDs(progressAssertions) &&
      hasUniqueAssertionIDs(stoppedAssertions) &&
      hasUniqueAssertionIDs(rereadAssertions) &&
      allowedAssertions(progressAssertions) &&
      allowedAssertions(stoppedAssertions) &&
      allowedAssertions(rereadAssertions) &&
      assertionResultsAreSubset(progressAssertions, stoppedAssertions) &&
      assertionResultsAreSubset(stoppedAssertions, rereadAssertions) &&
      postStopReplay.passed,
  });
}

function observedObservationPairs(events) {
  return [
    ...new Set(
      events.flatMap((event) => {
        if (event.type !== "log") return [];
        const match = /^Observation ([1-9]\d*) linked /u.exec(event.message);
        return match ? [Number(match[1])] : [];
      }),
    ),
  ].sort((left, right) => left - right);
}

function expectedVerifierAssertions(inputs) {
  return [
    {
      id: "assert-1",
      name: "Observer assets persisted",
      passed: true,
      message: `${inputs.assetCount}/${inputs.assetCount} observers persisted`,
    },
    {
      id: "assert-2",
      name: "Tracks persisted",
      passed: true,
      message: `${inputs.observations}/${inputs.observations} tracks persisted`,
    },
    {
      id: "assert-3",
      name: "Object references persisted",
      passed: true,
      message: `${inputs.observations}/${inputs.observations} objects linked`,
    },
  ];
}

function assertionResultsAreSubset(expected, actual) {
  const actualByID = new Map(
    actual.map((assertion) => [assertion.id, assertion]),
  );
  return expected.every((assertion) =>
    isDeepStrictEqual(actualByID.get(assertion.id), assertion),
  );
}

function hasUniqueAssertionIDs(assertions) {
  return (
    new Set(assertions.map((assertion) => assertion.id)).size ===
    assertions.length
  );
}

function recordCreatedResourceSet(run, inputs, record) {
  const expectedEntityCount = inputs.assetCount + inputs.observations;
  const expectedObjectCount = inputs.observations;
  const completed = run.status === "completed";
  const actualEntityCount = run.createdResources.filter(
    (resource) => resource.type === "entity",
  ).length;
  const actualObjectCount = run.createdResources.filter(
    (resource) => resource.type === "object",
  ).length;
  record({
    check:
      "observations-objects records only its complete Entity and Object resource set",
    expected: {
      resource_types: ["entity", "object"],
      ...(completed
        ? {
            total: expectedEntityCount + expectedObjectCount,
            entity: expectedEntityCount,
            object: expectedObjectCount,
          }
        : { partial_run: true }),
    },
    actual: {
      total: run.createdResources.length,
      entity: actualEntityCount,
      object: actualObjectCount,
      resources: run.createdResources,
    },
    passed:
      run.createdResources.every(
        (resource) => resource.type === "entity" || resource.type === "object",
      ) &&
      (!completed ||
        (run.createdResources.length ===
          expectedEntityCount + expectedObjectCount &&
          actualEntityCount === expectedEntityCount &&
          actualObjectCount === expectedObjectCount)),
  });
}

async function recordPersistedObservations(
  core,
  run,
  inputs,
  jsonInput,
  record,
  signal,
) {
  const expectedEntityCount = inputs.assetCount + inputs.observations;
  const entities = await Promise.all(
    run.createdResources
      .filter((resource) => resource.type === "entity")
      .map((resource) =>
        core.entities.get(resource.id, { fresh: true, signal }),
      ),
  );
  const objects = await Promise.all(
    run.createdResources
      .filter((resource) => resource.type === "object")
      .map((resource) =>
        core.objects.get(resource.id, { fresh: true, signal }),
      ),
  );
  const observers = entities.filter(
    (entity) => entity.subtype === "simulated-observer",
  );
  const tracks = entities.filter((entity) => entity.entity_type === "track");
  const entitySetComplete =
    entities.length === expectedEntityCount &&
    observers.length + tracks.length === entities.length;
  const indexedTracks = tracks.map((track) => ({
    track,
    observation: trackEntityIndex(run.id, track.entity_id),
  }));
  const trackByObservation = new Map();
  const trackMappingComplete =
    indexedTracks.length === inputs.observations &&
    indexedTracks.every(({ track, observation }) => {
      if (
        observation === undefined ||
        observation < 1 ||
        observation > inputs.observations ||
        trackByObservation.has(observation)
      ) {
        return false;
      }
      trackByObservation.set(observation, track);
      return true;
    }) &&
    trackByObservation.size === inputs.observations;
  const indexedObservers = observers.map((observer) => ({
    observer,
    asset: observerEntityIndex(run.id, observer.entity_id),
  }));
  const observerByIndex = new Map();
  const observerMappingComplete =
    indexedObservers.length === inputs.assetCount &&
    indexedObservers.every(({ observer, asset }) => {
      if (
        asset === undefined ||
        asset < 1 ||
        asset > inputs.assetCount ||
        observerByIndex.has(asset)
      ) {
        return false;
      }
      observerByIndex.set(asset, observer);
      return true;
    }) &&
    observerByIndex.size === inputs.assetCount;
  const expectedTracks = Array.from(
    { length: inputs.observations },
    (_, index) => {
      const observation = index + 1;
      const latitude = Number(
        (inputs.startLatitude + 0.01 + index * 0.0007).toFixed(6),
      );
      const longitude = Number(
        (inputs.startLongitude + 0.01 + index * 0.0009).toFixed(6),
      );
      return {
        observation,
        alias: `Observed ${run.id} track ${observation}`,
        observer: observerByIndex.get((index % inputs.assetCount) + 1),
        track: trackByObservation.get(observation),
        latitude,
        longitude,
        classification: observation % 2 === 1 ? "unknown" : "neutral",
      };
    },
  );
  const indexedObjects = objects.map((object) => ({
    object,
    observation: observationObjectIndex(run.id, object.object_id),
  }));
  const objectByObservation = new Map();
  const objectMappingComplete =
    indexedObjects.length === inputs.observations &&
    indexedObjects.every(({ object, observation }) => {
      if (
        observation === undefined ||
        observation < 1 ||
        observation > inputs.observations ||
        objectByObservation.has(observation)
      ) {
        return false;
      }
      objectByObservation.set(observation, object);
      return true;
    }) &&
    objectByObservation.size === inputs.observations;
  const expectedObjects = Array.from(
    { length: inputs.observations },
    (_, index) => {
      const observation = index + 1;
      return {
        object: objectByObservation.get(observation),
        observation,
        trackID: expectedTracks[index].track?.entity_id,
      };
    },
  );
  record({
    check:
      "independent SDK reads verify persisted observer, track, Object bytes, and relations",
    expected: {
      entities: {
        total: expectedEntityCount,
        observers: inputs.assetCount,
        tracks: inputs.observations,
      },
      observers: inputs.assetCount,
      observer_telemetry: { heading_deg: 90, speed_m_s: 4 },
      observer_heartbeat: "valid RFC3339 last_seen timestamp",
      observer_status: "observing",
      observer_custom_simulation: {
        run_id: run.id,
        collection: jsonInput.collection,
      },
      observer_sensor_refs: indexedObservers.map(({ observer, asset }) => ({
        asset,
        sensor_refs: [
          {
            sensor_id: `${observer.entity_id}-camera`,
            type: "camera",
            horizontal_fov: 60,
          },
        ],
      })),
      tracks: expectedTracks.map(
        ({ observation, alias, latitude, longitude, classification }) => ({
          observation,
          alias,
          subtype: "simulated-observation",
          latitude,
          longitude,
          classification,
          status: "observed",
          telemetry_last_update: "valid RFC3339 timestamp",
          status_last_update: "valid RFC3339 timestamp",
        }),
      ),
      objects: expectedObjects.map(({ object, observation, trackID }) => ({
        object_id: object?.object_id,
        observation,
        usage_hints: ["thumbnail"],
        referenced_by: [{ entity_id: trackID }],
      })),
      object_bytes: "metadata-only objects have null path and size_bytes",
      collection: jsonInput.collection,
    },
    actual: {
      entities: entities.map((entity) => entityState(entity)),
      observers: observers.map((entity) => entityState(entity)),
      observer_index_mapping: indexedObservers.map(({ observer, asset }) => ({
        entity_id: observer.entity_id,
        asset,
      })),
      tracks: tracks.map((entity) => entityState(entity)),
      track_index_mapping: indexedTracks.map(({ track, observation }) => ({
        entity_id: track.entity_id,
        observation,
      })),
      objects: objects.map((object) => objectState(object)),
      object_index_mapping: indexedObjects.map(({ object, observation }) => ({
        object_id: object.object_id,
        observation,
      })),
    },
    passed:
      entitySetComplete &&
      observerMappingComplete &&
      Array.from({ length: inputs.assetCount }, (_, index) => {
        const observer = observerByIndex.get(index + 1);
        const latitude = inputs.startLatitude + index * 0.001;
        const longitude = inputs.startLongitude + index * 0.001;
        return (
          observer?.entity_type === "asset" &&
          observer.alias === `Observer ${run.id} ${index + 1}` &&
          observer.components.custom_simulation?.run_id === run.id &&
          observer.components.custom_simulation?.collection ===
            jsonInput.collection &&
          isDeepStrictEqual(observer.components.sensor_refs, [
            {
              sensor_id: `${observer.entity_id}-camera`,
              type: "camera",
              horizontal_fov: 60,
            },
          ]) &&
          approximatelyEqual(
            observer.components.telemetry?.latitude,
            latitude,
          ) &&
          approximatelyEqual(
            observer.components.telemetry?.longitude,
            longitude,
          ) &&
          observer.components.telemetry?.heading_deg === 90 &&
          observer.components.telemetry?.speed_m_s === 4 &&
          isRFC3339Timestamp(observer.components.heartbeat?.last_seen) &&
          approximatelyEqual(
            observer.components.geometry?.coordinates?.[0],
            longitude,
          ) &&
          approximatelyEqual(
            observer.components.geometry?.coordinates?.[1],
            latitude,
          ) &&
          observer.components.status?.value === "observing"
        );
      }).every(Boolean) &&
      trackMappingComplete &&
      expectedTracks.every((expected) => {
        const simulation = expected.track?.components.custom_simulation;
        return (
          expected.track?.alias === expected.alias &&
          expected.track.subtype === "simulated-observation" &&
          expected.track.components.telemetry?.latitude === expected.latitude &&
          expected.track.components.telemetry?.longitude ===
            expected.longitude &&
          isRFC3339Timestamp(
            expected.track.components.telemetry?.last_update,
          ) &&
          isDeepStrictEqual(expected.track.components.geometry?.coordinates, [
            expected.longitude,
            expected.latitude,
          ]) &&
          expected.track.components.mil_view?.classification ===
            expected.classification &&
          expected.track.components.status?.value === "observed" &&
          isRFC3339Timestamp(expected.track.components.status?.last_update) &&
          simulation?.run_id === run.id &&
          simulation?.observer_id === expected.observer?.entity_id &&
          simulation?.observation_index === expected.observation &&
          simulation?.collection === jsonInput.collection
        );
      }) &&
      objects.length === inputs.observations &&
      objectMappingComplete &&
      expectedObjects.every(({ object, trackID }) => {
        return (
          object?.type === "observation" &&
          isDeepStrictEqual(object.usage_hints, ["thumbnail"]) &&
          object.path === null &&
          object.size_bytes === null &&
          object.content_type === null &&
          object.bucket === null &&
          isDeepStrictEqual(object.referenced_by, [{ entity_id: trackID }])
        );
      }),
  });
}

function recordCleanupEvents(run, cleaned, events, preserved, record) {
  const cleanupResources = assessCleanupResourceEvents(
    events,
    run.createdResources,
    preserved,
  );
  const cleanupCompletion = assessCleanupCompletionOrder(events);
  const eventContract = assessExpectedSuccessEvents(events, run.id);
  const assertionReplay = assessReplayAssertionParity(
    events,
    cleaned.assertions,
  );
  const expected = run.createdResources.map(resourceKey).sort();
  const stopEventIndex = events.findIndex(
    (event) => event.type === "log" && event.message === "Stop requested",
  );
  const cancelledStatusIndex = events.findIndex(
    (event) => event.type === "status" && event.status === "cancelled",
  );
  const requiresCancellationLifecycle = run.status === "cancelled";
  const sequences = events.map((event) => event.sequence);
  const runIDs = [...new Set(events.map((event) => event.runId))];
  record({
    check:
      "observations cleanup reports every recorded Entity and Object resource",
    expected: {
      status: run.status,
      cleaned: true,
      resources: expected,
      cleanup_events: cleanupResources.expected,
      cleanup_completion: cleanupCompletion.expected,
      event_contract: eventContract.expected,
      assertion_message_parity: assertionReplay.expected,
      created_resources: run.createdResources,
      assertions: run.assertions,
      run_id: run.id,
      strictly_increasing_sequences: true,
      ...(requiresCancellationLifecycle
        ? {
            cancellation_lifecycle: [
              { type: "log", message: "Stop requested" },
              { type: "status", status: "cancelled" },
            ],
          }
        : {}),
    },
    actual: {
      status: cleaned.status,
      cleaned: cleaned.cleaned,
      resources: cleanupResources.actual.map(resourceKey),
      cleanup_events: cleanupResources.actual,
      cleanup_completion: cleanupCompletion.actual,
      event_contract: eventContract.actual,
      assertion_message_parity: assertionReplay.actual,
      created_resources: cleaned.createdResources,
      assertions: cleaned.assertions,
      run_ids: runIDs,
      sequences,
      ...(requiresCancellationLifecycle
        ? {
            cancellation_lifecycle: {
              stop_log_index: stopEventIndex,
              cancelled_status_index: cancelledStatusIndex,
            },
          }
        : {}),
    },
    passed:
      cleaned.status === run.status &&
      cleaned.cleaned === true &&
      isDeepStrictEqual(cleanupResources.actual.map(resourceKey), expected) &&
      cleanupResources.passed &&
      cleanupCompletion.passed &&
      eventContract.passed &&
      assertionReplay.passed &&
      isDeepStrictEqual(cleaned.createdResources, run.createdResources) &&
      isDeepStrictEqual(cleaned.assertions, run.assertions) &&
      strictlyIncreasing(sequences) &&
      events.every((event) => event.runId === run.id) &&
      (!requiresCancellationLifecycle ||
        (stopEventIndex !== -1 &&
          cancelledStatusIndex !== -1 &&
          stopEventIndex < cancelledStatusIndex)),
  });
}

async function recordDeletedRunResources(
  core,
  resources,
  preserved,
  signal,
  record,
  check,
) {
  const actual = await Promise.all(
    resources
      .filter((resource) => !preserved.has(resource.id))
      .map((resource) => captureMissing(core, resource, signal)),
  );
  record({
    check,
    expected: resources
      .filter((resource) => !preserved.has(resource.id))
      .map((resource) => ({
        type: resource.type,
        id: resource.id,
        status: 404,
        error_code:
          resource.type === "entity" ? "ENTITY_NOT_FOUND" : "OBJECT_NOT_FOUND",
      })),
    actual,
    passed:
      actual.length ===
        resources.filter((resource) => !preserved.has(resource.id)).length &&
      actual.every(
        (result) =>
          result.status === 404 &&
          result.error_code ===
            (result.type === "entity"
              ? "ENTITY_NOT_FOUND"
              : "OBJECT_NOT_FOUND"),
      ),
  });
}

async function recordProtectedResources(
  core,
  ids,
  signal,
  record,
  check = "observations cleanup preserves replacement and unrelated resource instances",
) {
  const [
    replacementEntity,
    replacementObject,
    unrelatedEntity,
    unrelatedObject,
  ] = await Promise.all([
    core.entities.get(ids.replacementEntityID, { fresh: true, signal }),
    core.objects.get(ids.replacementObjectID, { fresh: true, signal }),
    core.entities.get(ids.unrelatedEntityID, { fresh: true, signal }),
    core.objects.get(ids.unrelatedObjectID, { fresh: true, signal }),
  ]);
  record({
    check,
    expected: {
      replacement_entity: "replacement observations acceptance Entity",
      replacement_object: "replacement observations acceptance Object",
      unrelated_entity: "unrelated observations acceptance Entity",
      unrelated_object: "unrelated observations acceptance Object",
    },
    actual: {
      replacement_entity: replacementEntity.alias,
      replacement_object: replacementObject.extra?.owner,
      unrelated_entity: unrelatedEntity.alias,
      unrelated_object: unrelatedObject.extra?.owner,
    },
    passed:
      replacementEntity.alias ===
        "replacement observations acceptance Entity" &&
      replacementObject.extra?.owner ===
        "replacement observations acceptance Object" &&
      unrelatedEntity.alias === "unrelated observations acceptance Entity" &&
      unrelatedObject.extra?.owner ===
        "unrelated observations acceptance Object",
  });
}

async function captureMissing(core, resource, signal) {
  try {
    if (resource.type === "entity") {
      await core.entities.get(resource.id, { fresh: true, signal });
    } else if (resource.type === "object") {
      await core.objects.get(resource.id, { fresh: true, signal });
    } else {
      throw new Error(`Unsupported run resource type: ${resource.type}`);
    }
    return { type: resource.type, id: resource.id, status: 200 };
  } catch (error) {
    if (!isAtlasAPIError(error)) throw error;
    return {
      type: resource.type,
      id: resource.id,
      status: error.status,
      error_code: error.errorCode,
      response: error.response,
    };
  }
}

async function collectRunEvents({ api, runID, artifactBase, signal, until }) {
  const events = [];
  let raw = "";
  try {
    const response = await fetch(
      `${api.baseUrl}/api/runs/${encodeURIComponent(runID)}/events`,
      {
        headers: { Accept: "text/event-stream" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      },
    );
    const responseError = eventStreamResponseError(response);
    if (responseError) {
      raw = await response.text();
      throw new Error(`${responseError}: ${raw}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const text = decoder.decode(result.value, { stream: true });
      raw += text;
      pending += text;
      let separator = pending.indexOf("\n\n");
      while (separator !== -1) {
        const event = parseEventFrame(pending.slice(0, separator));
        pending = pending.slice(separator + 2);
        if (event) events.push(event);
        separator = pending.indexOf("\n\n");
      }
      if (until(events)) {
        await reader.cancel();
        return { events, raw };
      }
    }
    throw new Error(
      "Simulation event stream ended before its acceptance condition",
    );
  } finally {
    writeFileSync(`${artifactBase}.sse`, raw);
    writeFileSync(
      `${artifactBase}.events.json`,
      `${JSON.stringify(events, null, 2)}\n`,
    );
  }
}

/**
 * Terminal run streams can remain open after replay. Keep the stream open for
 * the observation window so activity in a later chunk cannot hide behind the
 * cancelled marker in an earlier chunk.
 */
async function collectRunEventsForWindow({
  api,
  runID,
  artifactBase,
  signal,
  windowMs,
}) {
  const startedAt = Date.now();
  const events = [];
  let raw = "";
  let reader;
  try {
    const response = await fetch(
      `${api.baseUrl}/api/runs/${encodeURIComponent(runID)}/events`,
      {
        headers: { Accept: "text/event-stream" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      },
    );
    const responseError = eventStreamResponseError(response);
    if (responseError) {
      raw = await response.text();
      throw new Error(`${responseError}: ${raw}`);
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const deadline = Date.now() + windowMs;
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        await reader.cancel();
        return {
          snapshots: [{ events, raw }],
          observedWindowMs: Date.now() - startedAt,
        };
      }
      const result = await Promise.race([
        reader.read(),
        delay(remainingMs, undefined, { signal }).then(() => undefined),
      ]);
      if (result === undefined) {
        await reader.cancel();
        return {
          snapshots: [{ events, raw }],
          observedWindowMs: Date.now() - startedAt,
        };
      }
      if (result.done) {
        throw new Error(
          "Simulation event stream ended before the cancellation observation window",
        );
      }
      const text = decoder.decode(result.value, { stream: true });
      raw += text;
      pending += text;
      let separator = pending.indexOf("\n\n");
      while (separator !== -1) {
        const event = parseEventFrame(pending.slice(0, separator));
        pending = pending.slice(separator + 2);
        if (event) events.push(event);
        separator = pending.indexOf("\n\n");
      }
    }
  } finally {
    await reader?.cancel();
    writeFileSync(`${artifactBase}.sse`, raw);
    writeFileSync(
      `${artifactBase}.events.json`,
      `${JSON.stringify([{ events, raw }], null, 2)}\n`,
    );
  }
}

function parseEventFrame(frame) {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data
    ? parseRunEvent(parseJSON(data, "simulation event frame"))
    : undefined;
}

function hasExactNumberFields(scenario, expected) {
  return (
    Array.isArray(scenario?.inputFields) &&
    scenario.inputFields.length === expected.length &&
    expected.every(([key, defaultValue, min, max, step], index) => {
      const field = scenario.inputFields[index];
      return (
        field?.key === key &&
        field.type === "number" &&
        field.defaultValue === defaultValue &&
        field.min === min &&
        field.max === max &&
        field.step === step
      );
    })
  );
}

function hasScenarioDescriptorPresentation(scenario) {
  return (
    scenario?.id === scenarioID &&
    hasNonemptyText(scenario.name) &&
    hasNonemptyText(scenario.summary) &&
    Array.isArray(scenario.inputFields) &&
    scenario.inputFields.every((field) => hasNonemptyText(field?.label))
  );
}

function hasNonemptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function entityState(entity) {
  return {
    id: entity.entity_id,
    type: entity.entity_type,
    alias: entity.alias,
    subtype: entity.subtype,
    telemetry: entity.components.telemetry,
    heartbeat: entity.components.heartbeat,
    geometry: entity.components.geometry,
    mil_view: entity.components.mil_view,
    sensor_refs: entity.components.sensor_refs,
    status: entity.components.status,
    custom_simulation: entity.components.custom_simulation,
  };
}

function objectState(object) {
  return {
    id: object.object_id,
    type: object.type,
    usage_hints: object.usage_hints,
    path: object.path,
    size_bytes: object.size_bytes,
    content_type: object.content_type,
    bucket: object.bucket,
    referenced_by: object.referenced_by,
  };
}

function shortID(prefix) {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

function observationObjectIndex(runID, objectID) {
  const prefix = `${runID}-observation-object-`;
  if (!objectID.startsWith(prefix)) return undefined;
  const remainder = objectID.slice(prefix.length);
  const separator = remainder.indexOf("-");
  if (separator <= 0 || separator === remainder.length - 1) return undefined;
  const index = remainder.slice(0, separator);
  if (!/^[1-9]\d*$/u.test(index)) return undefined;
  const value = Number(index);
  return Number.isSafeInteger(value) ? value : undefined;
}

function trackEntityIndex(runID, entityID) {
  const prefix = `${runID}-track-`;
  if (!entityID.startsWith(prefix)) return undefined;
  const remainder = entityID.slice(prefix.length);
  const separator = remainder.indexOf("-");
  if (separator <= 0 || separator === remainder.length - 1) return undefined;
  const index = remainder.slice(0, separator);
  if (!/^[1-9]\d*$/u.test(index)) return undefined;
  const value = Number(index);
  return Number.isSafeInteger(value) ? value : undefined;
}

function observerEntityIndex(runID, entityID) {
  const prefix = `${runID}-observer-`;
  if (!entityID.startsWith(prefix)) return undefined;
  const remainder = entityID.slice(prefix.length);
  const separator = remainder.indexOf("-");
  if (separator <= 0 || separator === remainder.length - 1) return undefined;
  const index = remainder.slice(0, separator);
  if (!/^[1-9]\d*$/u.test(index)) return undefined;
  const value = Number(index);
  return Number.isSafeInteger(value) ? value : undefined;
}

function strictlyIncreasing(values) {
  return values.every(
    (value, index) => index === 0 || value > values[index - 1],
  );
}

function approximatelyEqual(actual, expected) {
  return typeof actual === "number" && Math.abs(actual - expected) < 1e-12;
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

function recordLocalLedgerState(
  simulationRunID,
  cleanupLedgerDirectory,
  artifacts,
  record,
  phase,
) {
  const ledgerPath = join(cleanupLedgerDirectory, `${simulationRunID}.json`);
  const present = existsSync(ledgerPath);
  const state = {
    run_id: simulationRunID,
    phase,
    ledger_path: ledgerPath,
    local_ledger_file_present: present,
  };
  appendJSON(join(artifacts, "local-ledger-checks.jsonl"), state);
  record({
    check: `local disposable run does not create a deployed cleanup ledger record ${phase}`,
    expected: {
      run_id: simulationRunID,
      phase,
      local_ledger_file_present: false,
    },
    actual: state,
    passed: !present,
  });
}
