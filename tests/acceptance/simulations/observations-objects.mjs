import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AtlasClient, isAtlasAPIError } from "@the-drunken-coder/atlas-sdk";
import { parseRunEvent } from "../../../simulations/src/client/run-state.ts";
import { runAcceptance } from "../support/stack.mjs";
import { parseBrowserRunSummary } from "./support/browser-run-contracts.mjs";
import {
  createSimulationServerFixture,
  simulationFixtureVariant,
} from "./support/server-fixture.mjs";

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
      const target = await verifyLocalTargetAndScenario(api, baseUrl, apiKey, record);
      if (nightly) await recordInvalidInputFault(api, record);

      const normal = await startRun(api, normalInputs, observationJSON, target);
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
          target,
          inputs: normalInputs,
          jsonInput: observationJSON,
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
      const cancelledRun = await api.json(
        "POST",
        `/api/runs/${encodeURIComponent(cancelled.id)}/stop`,
      );
      const cancelledRunSummary = parseBrowserRunSummary(cancelledRun.body.run, {
        context: "stop response",
        runID: cancelled.id,
        scenarioID,
        target,
        inputs: cancellationInputs,
        jsonInput: observationJSON,
      });
      record({
        check:
          "observations-objects accepts cancellation through its public route",
        expected: { status: 200, run_status: "cancelled", cleaned: false },
        actual: {
          status: cancelledRun.status,
          run_status: cancelledRunSummary.status,
          cleaned: cancelledRunSummary.cleaned,
          progress_events: cancellationProgress.events.length,
        },
        passed:
          cancelledRun.status === 200 &&
          cancelledRunSummary.status === "cancelled" &&
          cancelledRunSummary.cleaned === false &&
          cancellationProgress.events.length > 0,
      });
      const cancelledSummary = await readRun(
        api,
        cancelled.id,
        cancellationInputs,
        observationJSON,
        target,
      );
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
          target,
          inputs: cancellationInputs,
          jsonInput: observationJSON,
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
      scenario?.acceptsJson === true &&
      hasExactNumberFields(scenario, [
        ["assetCount", 2, 1, 10, 1],
        ["observations", 4, 1, 50, 1],
        ["tickMs", 200, 0, 10_000, 50],
        ["startLatitude", 38.88, -90, 89.9557, 0.0001],
        ["startLongitude", -77.04, -180, 179.9459, 0.0001],
      ]),
  });
  return target;
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

async function startRun(api, inputs, jsonInput, target) {
  const response = await api.json("POST", "/api/runs", {
    scenarioId: "observations-objects",
    targetId: "local",
    inputs,
    jsonInput: JSON.stringify(jsonInput),
  });
  const run = parseBrowserRunSummary(response.body.run, {
    context: "start response",
    scenarioID,
    target,
    inputs,
    jsonInput,
  });
  if (
    response.status !== 201 ||
    run.scenarioId !== scenarioID
  ) {
    throw new Error(
      `Starting observations-objects expected HTTP 201, observed ${response.raw}`,
    );
  }
  return run;
}

async function readRun(api, runID, inputs, jsonInput, target) {
  const response = await api.json("GET", `/api/runs/${encodeURIComponent(runID)}`);
  return parseBrowserRunSummary(response.body.run, {
    context: "run read response",
    runID,
    scenarioID,
    target,
    inputs,
    jsonInput,
  });
}

function recordCompletedStream(started, completed, events, inputs, record) {
  const initial = events.at(0);
  const resources = events.filter((event) => event.type === "resource");
  const logs = events.filter((event) => event.type === "log");
  const assertions = events.filter((event) => event.type === "assertion");
  const expectedAssertionResults = [
    { id: "assert-1", name: "Observer assets persisted", passed: true },
    { id: "assert-2", name: "Tracks persisted", passed: true },
    { id: "assert-3", name: "Object references persisted", passed: true },
  ];
  const expectedAssertionIDs = expectedAssertionResults.map(
    (assertion) => assertion.id,
  );
  const streamAssertionResults = assertions.map((event) =>
    assertionResultState(event.assertion),
  );
  const summaryAssertionResults = completed.assertions.map(
    assertionResultState,
  );
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
      initial_event: { type: "status", status: "running" },
      status: "completed",
      completed_cleaned: false,
      resources: expectedResources,
      logs: expectedLogs,
      assertion_ids: expectedAssertionIDs,
      assertion_ids_unique: true,
      assertion_results: expectedAssertionResults,
    },
    actual: {
      started_run: {
        id: started.id,
        status: started.status,
        cleaned: started.cleaned,
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
    },
    passed:
      started.status === "running" &&
      started.cleaned === false &&
      initial?.type === "status" &&
      initial.status === "running" &&
      completed.status === "completed" &&
      completed.cleaned === false &&
      terminal?.status === "completed" &&
      isDeepStrictEqual(actualResources, expectedResources) &&
      isDeepStrictEqual(actualLogs, expectedLogs) &&
      isDeepStrictEqual(actualAssertionIDs, expectedAssertionIDs) &&
      new Set(actualAssertionIDs).size === actualAssertionIDs.length &&
      isDeepStrictEqual(streamAssertionResults, expectedAssertionResults) &&
      isDeepStrictEqual(summaryAssertionResults, expectedAssertionResults) &&
      isDeepStrictEqual(summaryAssertionResults, streamAssertionResults) &&
      strictlyIncreasing(events.map((event) => event.sequence)) &&
      events.every((event) => event.runId === started.id),
  });
}

function assertionResultState(assertion) {
  return {
    id: assertion?.id,
    name: assertion?.name,
    passed: assertion?.passed,
  };
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
          isDeepStrictEqual(expected.track.components.geometry?.coordinates, [
            expected.longitude,
            expected.latitude,
          ]) &&
          expected.track.components.mil_view?.classification ===
            expected.classification &&
          expected.track.components.status?.value === "observed" &&
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

function recordCleanupEvents(run, cleaned, events, record) {
  const resources = events
    .filter((event) => event.type === "cleanup" && event.resource)
    .map((event) => event.resource);
  const expected = run.createdResources
    .map((resource) => `${resource.type}:${resource.id}`)
    .sort();
  const actual = resources
    .map((resource) => `${resource.type}:${resource.id}`)
    .sort();
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
      resources: actual,
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
      isDeepStrictEqual(actual, expected) &&
      strictlyIncreasing(sequences) &&
      events.every((event) => event.runId === run.id) &&
      (!requiresCancellationLifecycle ||
        (stopEventIndex !== -1 &&
          cancelledStatusIndex !== -1 &&
          stopEventIndex < cancelledStatusIndex)) &&
      events.some(
        (event) =>
          event.type === "cleanup" &&
          event.resource === undefined &&
          event.message === "Cleanup complete",
      ),
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
    if (!response.ok || !response.body) {
      raw = await response.text();
      throw new Error(
        `GET run events returned HTTP ${response.status}: ${raw}`,
      );
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
    scenario?.inputFields.length === expected.length &&
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

function entityState(entity) {
  return {
    id: entity.entity_id,
    type: entity.entity_type,
    alias: entity.alias,
    subtype: entity.subtype,
    telemetry: entity.components.telemetry,
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
