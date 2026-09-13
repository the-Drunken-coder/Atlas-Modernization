import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  AtlasClient,
  isAtlasAPIError,
  isRFC3339Timestamp,
} from "@the-drunken-coder/atlas-sdk";
import { parseRunEvent } from "../../../simulations/src/client/run-state.ts";
import { runAcceptance } from "../support/stack.mjs";
import {
  observeReaderTransport,
  startReaders,
  stopReaders,
} from "./support/multi-client-readers.mjs";
import { assessMultiClientAssertions } from "./support/multi-client-assertion-contract.mjs";
import { parseBrowserRunSummary } from "./support/browser-run-contracts.mjs";
import {
  assessCleanupCompletionOrder,
  assessCleanupResourceEvents,
  resourceKey,
} from "./support/cleanup-event-contract.mjs";
import {
  createSimulationServerFixture,
  simulationFixtureVariant,
} from "./support/server-fixture.mjs";
import { eventStreamResponseError } from "./support/sse-response-contract.mjs";

const reproduction =
  "npm run build:sdk && node --import ./simulations/node_modules/tsx/dist/loader.mjs tests/acceptance/simulations/multi-client-sync.mjs";
const scenarioID = "multi-client-sync";
const nightly = process.env.ATLAS_ACCEPTANCE_NIGHTLY === "1";
const normalInputs = nightly
  ? { clientCount: 4, writes: 8, settleMs: 2_500 }
  : { clientCount: 2, writes: 3, settleMs: 1_500 };
const standardRequestTimeoutMs = 15_000;
const cleanupRequestTimeoutMs = 35_000;
const fixture = createSimulationServerFixture();

await runAcceptance({
  name: "simulations-multi-client-sync",
  reproduction,
  fixtureVariant: {
    ...simulationFixtureVariant,
    cardinality: nightly ? "nightly-bounded" : "required-bounded",
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
      requestTimeoutMs: 10_000,
    });
    const unrelatedEntityID = shortID("acpt-unrelated-sync-entity");
    const unrelatedObjectID = shortID("acpt-unrelated-sync-object");
    const unrelatedEntityToken = `unrelated-entity-${randomUUID()}`;
    const unrelatedObjectToken = `unrelated-object-${randomUUID()}`;
    const readers = await startReaders({
      count: normalInputs.clientCount,
      baseUrl,
      apiKey,
      signal,
    });
    let replacementWriterID;
    let replacementWriterToken;

    try {
      verifyServerHealth(simulation.health, baseUrl, record);
      const { target, scenarioName } = await verifyLocalTargetAndScenario(
        api,
        baseUrl,
        apiKey,
        record,
      );
      if (nightly) await recordInvalidInputFault(api, record);

      observeReaderTransport(readers);
      const run = await startRun(api, normalInputs, target, scenarioName);
      const stream = await collectRunEvents({
        api,
        runID: run.id,
        artifactBase: join(artifacts, "multi-client-sync-completed"),
        signal,
        until: (events) =>
          events.some(
            (event) => event.type === "status" && event.status !== "running",
          ),
      });
      const summary = await readRun(
        api,
        run.id,
        normalInputs,
        target,
        scenarioName,
        { startedAt: run.startedAt },
      );
      recordCompletedStream(run, summary, stream.events, normalInputs, record);

      const writerEntities = await readWriterEntities(core, summary, signal);
      recordPersistedWriterEntities(
        summary,
        writerEntities,
        normalInputs,
        record,
      );
      await recordSDKConvergence(
        readers,
        writerEntities,
        normalInputs,
        signal,
        record,
      );
      await core.entities.create(
        {
          entity_id: unrelatedEntityID,
          entity_type: "asset",
          alias: "unrelated multi-client acceptance Entity",
        },
        { instanceToken: unrelatedEntityToken, signal },
      );
      await core.objects.create(
        {
          object_id: unrelatedObjectID,
          type: "sync-probe",
          extra: { owner: "unrelated multi-client acceptance Object" },
        },
        { instanceToken: unrelatedObjectToken, signal },
      );
      replacementWriterID = writerEntities[0]?.entity_id;
      if (!replacementWriterID) {
        throw new Error(
          "multi-client-sync did not create a writer Entity to replace before cleanup",
        );
      }
      replacementWriterToken = `replacement-writer-${randomUUID()}`;
      await core.entities.delete(replacementWriterID);
      await core.entities.create(
        {
          entity_id: replacementWriterID,
          entity_type: "asset",
          alias: "replacement multi-client writer Entity",
        },
        { instanceToken: replacementWriterToken, signal },
      );

      recordLocalLedgerState(
        run.id,
        simulation.cleanupLedgerDirectory,
        artifacts,
        record,
        "before cleanup",
      );

      const cleanup = await api.json(
        "POST",
        `/api/runs/${encodeURIComponent(run.id)}/cleanup`,
      );
      const cleanedSummary = parseBrowserRunSummary(cleanup.body.run, {
        context: "cleanup response",
        runID: run.id,
        scenarioID,
        scenarioName,
        target,
        inputs: normalInputs,
        jsonInput: undefined,
        lifecycle: {
          startedAt: run.startedAt,
          finishedAt: summary.finishedAt,
        },
      });
      const cleanupStream = await collectRunEvents({
        api,
        runID: run.id,
        artifactBase: join(artifacts, "multi-client-sync-cleanup"),
        signal,
        until: (events) =>
          events.some(
            (event) => event.type === "cleanup" && event.resource === undefined,
          ),
      });
      recordCleanupEvents(
        summary,
        cleanedSummary,
        cleanupStream.events,
        new Set([`entity:${replacementWriterID}`]),
        record,
      );
      await recordAllMissing(
        core,
        summary.createdResources.filter(
          (resource) => resource.id !== replacementWriterID,
        ),
        signal,
        record,
      );
      recordLocalLedgerState(
        run.id,
        simulation.cleanupLedgerDirectory,
        artifacts,
        record,
        "after cleanup",
      );
      await recordProtectedResources(
        core,
        { replacementWriterID, unrelatedEntityID, unrelatedObjectID },
        signal,
        record,
      );
      record({
        check: "multi-client acceptance IDs stay within the Core limit",
        expected: { unique: true, maximum_length: 50 },
        actual: {
          ids: [
            ...summary.createdResources.map((resource) => resource.id),
            unrelatedEntityID,
            unrelatedObjectID,
          ],
          lengths: [
            ...summary.createdResources.map((resource) => resource.id.length),
            unrelatedEntityID.length,
            unrelatedObjectID.length,
          ],
        },
        passed:
          new Set([
            ...summary.createdResources.map((resource) => resource.id),
            unrelatedEntityID,
            unrelatedObjectID,
          ]).size ===
            summary.createdResources.length + 2 &&
          [
            ...summary.createdResources.map((resource) => resource.id),
            unrelatedEntityID,
            unrelatedObjectID,
          ].every((id) => id.length <= 50),
      });
    } finally {
      stopReaders(readers);
      await Promise.allSettled([
        replacementWriterID && replacementWriterToken
          ? core.entities.delete(replacementWriterID, {
              instanceToken: replacementWriterToken,
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
    (candidate) => candidate.id === "multi-client-sync",
  );
  const target = targets.body.targets[0];
  record({
    check:
      "multi-client acceptance exposes only the disposable loopback target",
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
    check: "actual server registers the multi-client-sync contract",
    expected: {
      scenario_id: scenarioID,
      user_visible_descriptor_text: "nonempty name, summary, and input labels",
      accepts_json: false,
      input_fields: [
        { key: "clientCount", default_value: 2, min: 1, max: 8, step: 1 },
        { key: "writes", default_value: 3, min: 1, max: 20, step: 1 },
        {
          key: "settleMs",
          default_value: 1_500,
          min: 1_500,
          max: 10_000,
          step: 50,
        },
      ],
    },
    actual: scenario,
    passed:
      hasScenarioDescriptorPresentation(scenario) &&
      scenario.acceptsJson === false &&
      hasExactNumberFields(scenario, [
        ["clientCount", 2, 1, 8, 1],
        ["writes", 3, 1, 20, 1],
        ["settleMs", 1_500, 1_500, 10_000, 50],
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
    scenarioId: "multi-client-sync",
    targetId: "local",
    inputs: { clientCount: 0 },
  });
  record({
    check:
      "nightly multi-client input fault rejects an invalid client cardinality",
    expected: { status: 400, message: "Client count must be at least 1" },
    actual: response,
    passed:
      response.status === 400 &&
      response.body.message === "Client count must be at least 1",
  });
}

async function startRun(api, inputs, target, scenarioName) {
  const response = await api.json("POST", "/api/runs", {
    scenarioId: "multi-client-sync",
    targetId: "local",
    inputs,
  });
  const run = parseBrowserRunSummary(response.body.run, {
    context: "start response",
    scenarioID,
    scenarioName,
    target,
    inputs,
    jsonInput: undefined,
  });
  if (response.status !== 201 || run.scenarioId !== scenarioID) {
    throw new Error(
      `Starting multi-client-sync expected HTTP 201, observed ${response.raw}`,
    );
  }
  return run;
}

async function readRun(api, runID, inputs, target, scenarioName, lifecycle) {
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
    jsonInput: undefined,
    lifecycle,
  });
}

function recordCompletedStream(run, summary, events, inputs, record) {
  const initial = events.at(0);
  const resources = events.filter((event) => event.type === "resource");
  const logs = events.filter((event) => event.type === "log");
  const assertions = events.filter((event) => event.type === "assertion");
  const expectedAssertionNames = clientAssertionNames(inputs.clientCount);
  const assertionContract = assessMultiClientAssertions(
    assertions.map((event) => event.assertion),
    summary.assertions,
    expectedAssertionNames,
  );
  const terminal = events.find(
    (event) => event.type === "status" && event.status !== "running",
  );
  const expectedResources = summary.createdResources
    .map((resource) => `${resource.type}:${resource.id}`)
    .sort();
  const actualResources = resources
    .map((event) => `${event.resource?.type}:${event.resource?.id}`)
    .sort();
  const writerIDs = summary.createdResources
    .filter((resource) => resource.type === "entity")
    .map((resource) => ({
      id: resource.id,
      index: writerEntityIndex(summary.id, resource.id),
    }))
    .sort((left, right) => left.index - right.index)
    .map((writer) => writer.id);
  const expectedProgressLogs = [
    ...Array.from(
      { length: inputs.clientCount },
      (_, index) => `Sync client ${index + 1} started`,
    ),
    ...writerIDs.map((id) => `Writer created ${id}`),
  ];
  const actualProgressLogs = logs.map((event) => event.message);
  record({
    check: "actual server event stream completes multi-client-sync",
    expected: {
      start_status: "running",
      start_cleaned: false,
      start_created_resources: [],
      start_assertions: [],
      initial_event: { type: "status", status: "running" },
      status: "completed",
      completed_cleaned: false,
      resources: expectedResources,
      progress_logs: expectedProgressLogs,
      assertion_id_set: assertionContract.expectedIDs,
      assertion_name_pass_set: assertionContract.expectedNamePassSet,
    },
    actual: {
      started_run: {
        id: run.id,
        status: run.status,
        cleaned: run.cleaned,
        created_resources: run.createdResources,
        assertions: run.assertions,
      },
      completed_run: { status: summary.status, cleaned: summary.cleaned },
      initial,
      terminal,
      resources: actualResources,
      progress_logs: actualProgressLogs,
      stream_assertion_results: assertionContract.streamResults,
      summary_assertion_results: assertionContract.summaryResults,
    },
    passed:
      run.status === "running" &&
      run.cleaned === false &&
      run.createdResources.length === 0 &&
      run.assertions.length === 0 &&
      initial?.type === "status" &&
      initial.status === "running" &&
      summary.status === "completed" &&
      summary.cleaned === false &&
      terminal?.status === "completed" &&
      isDeepStrictEqual(actualResources, expectedResources) &&
      isDeepStrictEqual(actualProgressLogs, expectedProgressLogs) &&
      assertionContract.passed &&
      strictlyIncreasing(events.map((event) => event.sequence)) &&
      events.every((event) => event.runId === run.id),
  });
}

async function readWriterEntities(core, run, signal) {
  const resources = run.createdResources.filter(
    (resource) => resource.type === "entity",
  );
  return Promise.all(
    resources.map((resource) =>
      core.entities.get(resource.id, { fresh: true, signal }),
    ),
  );
}

function recordPersistedWriterEntities(run, entities, inputs, record) {
  const expectedEntityResources =
    run.createdResources.length === inputs.writes &&
    run.createdResources.every((resource) => resource.type === "entity");
  const indexedEntities = entities.map((entity) => ({
    entity,
    writeIndex: writerEntityIndex(run.id, entity.entity_id),
  }));
  const entitiesByWriteIndex = new Map();
  const writerMappingComplete =
    indexedEntities.length === inputs.writes &&
    indexedEntities.every(({ entity, writeIndex }) => {
      if (
        writeIndex === undefined ||
        writeIndex < 1 ||
        writeIndex > inputs.writes ||
        entitiesByWriteIndex.has(writeIndex)
      ) {
        return false;
      }
      entitiesByWriteIndex.set(writeIndex, entity);
      return true;
    }) &&
    entitiesByWriteIndex.size === inputs.writes;
  const expectedEntities = Array.from({ length: inputs.writes }, (_, index) => {
    const writeIndex = index + 1;
    return { entity: entitiesByWriteIndex.get(writeIndex), writeIndex };
  });
  record({
    check:
      "independent SDK reads verify every persisted multi-client writer Entity",
    expected: {
      entities: inputs.writes,
      entity_type: "asset",
      subtype: "sync-probe",
      status: "sync-probe",
      heartbeat: "valid RFC3339 last_seen timestamp",
      run_id: run.id,
      resource_types: Array.from({ length: inputs.writes }, () => "entity"),
      write_indexes: Array.from(
        { length: inputs.writes },
        (_, index) => index + 1,
      ),
    },
    actual: {
      created_resources: run.createdResources,
      entities: entities.map(entityState),
      entity_index_mapping: indexedEntities.map(({ entity, writeIndex }) => ({
        entity_id: entity.entity_id,
        write_index: writeIndex,
      })),
    },
    passed:
      expectedEntityResources &&
      writerMappingComplete &&
      expectedEntities.every(({ entity, writeIndex }) =>
        isExpectedWriterEntity(entity, run.id, writeIndex),
      ),
  });
}

async function recordSDKConvergence(
  readers,
  writerEntities,
  inputs,
  signal,
  record,
) {
  const writerByID = new Map(
    writerEntities.map((entity) => [entity.entity_id, entity]),
  );
  const deadline = Date.now() + inputs.settleMs + 4_000;
  await Promise.all(
    readers.map(async (reader) => {
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (readerMatchesWriter(reader, writerByID)) return;
        await delay(50, signal);
      }
    }),
  );
  const actual = readers.map((reader) => {
    const snapshot = reader.client.sync.snapshot();
    return {
      client: reader.index,
      status: reader.client.sync.status(),
      seen_versions: Object.fromEntries(reader.seenVersions),
      entities: Object.fromEntries(
        writerEntities.map((entity) => [
          entity.entity_id,
          snapshot.entities[entity.entity_id],
        ]),
      ),
      transport_requests: reader.transport.requests,
    };
  });
  record({
    check:
      "independently created SDK clients converge on all persisted writer entities",
    expected: {
      clients: readers.length,
      entity_ids: writerEntities.map((entity) => entity.entity_id),
      versions: Object.fromEntries(
        writerEntities.map((entity) => [
          entity.entity_id,
          entity.metadata.version,
        ]),
      ),
      running: true,
      healthy: true,
      transport_requests: [],
    },
    actual,
    passed:
      readers.length === inputs.clientCount &&
      readers.every(
        (reader) =>
          readerMatchesWriter(reader, writerByID) &&
          reader.transport.requests.length === 0,
      ),
  });
}

function readerMatchesWriter(reader, writerByID) {
  const snapshot = reader.client.sync.snapshot();
  const status = reader.client.sync.status();
  return (
    status.running === true &&
    status.healthy === true &&
    [...writerByID].every(
      ([id, writer]) =>
        reader.seenVersions.get(id) === writer.metadata.version &&
        structurallyEqual(snapshot.entities[id], writer),
    )
  );
}

function recordCleanupEvents(run, cleaned, events, preserved, record) {
  const cleanupResources = assessCleanupResourceEvents(
    events,
    run.createdResources,
    preserved,
  );
  const cleanupCompletion = assessCleanupCompletionOrder(events);
  const expected = run.createdResources.map(resourceKey).sort();
  const sequences = events.map((event) => event.sequence);
  const runIDs = [...new Set(events.map((event) => event.runId))];
  record({
    check: "multi-client cleanup reports every run-owned Entity",
    expected: {
      status: run.status,
      cleaned: true,
      resources: expected,
      cleanup_events: cleanupResources.expected,
      cleanup_completion: cleanupCompletion.expected,
      created_resources: run.createdResources,
      assertions: run.assertions,
      run_id: run.id,
      strictly_increasing_sequences: true,
    },
    actual: {
      status: cleaned.status,
      cleaned: cleaned.cleaned,
      resources: cleanupResources.actual.map(resourceKey),
      cleanup_events: cleanupResources.actual,
      cleanup_completion: cleanupCompletion.actual,
      created_resources: cleaned.createdResources,
      assertions: cleaned.assertions,
      run_ids: runIDs,
      sequences,
    },
    passed:
      cleaned.status === run.status &&
      cleaned.cleaned === true &&
      isDeepStrictEqual(cleanupResources.actual.map(resourceKey), expected) &&
      cleanupResources.passed &&
      cleanupCompletion.passed &&
      isDeepStrictEqual(cleaned.createdResources, run.createdResources) &&
      isDeepStrictEqual(cleaned.assertions, run.assertions) &&
      strictlyIncreasing(sequences) &&
      events.every((event) => event.runId === run.id),
  });
}

async function recordAllMissing(core, resources, signal, record) {
  const actual = await Promise.all(
    resources.map((resource) => captureMissing(core, resource, signal)),
  );
  record({
    check: "multi-client cleanup removes every run-owned resource",
    expected: resources.map((resource) => ({
      type: resource.type,
      id: resource.id,
      status: 404,
      error_code:
        resource.type === "entity" ? "ENTITY_NOT_FOUND" : "OBJECT_NOT_FOUND",
    })),
    actual,
    passed:
      actual.length === resources.length &&
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

async function captureMissing(core, resource, signal) {
  try {
    if (resource.type === "entity") {
      await core.entities.get(resource.id, { fresh: true, signal });
    } else if (resource.type === "object") {
      await core.objects.get(resource.id, { fresh: true, signal });
    } else {
      throw new Error(`Unknown run resource type: ${resource.type}`);
    }
    return { type: resource.type, id: resource.id, status: 200 };
  } catch (error) {
    if (!isAtlasAPIError(error)) throw error;
    return {
      type: resource.type,
      id: resource.id,
      status: error.status,
      error_code: error.errorCode,
    };
  }
}

async function recordProtectedResources(core, ids, signal, record) {
  const [replacement, entity, object] = await Promise.all([
    core.entities.get(ids.replacementWriterID, { fresh: true, signal }),
    core.entities.get(ids.unrelatedEntityID, { fresh: true, signal }),
    core.objects.get(ids.unrelatedObjectID, { fresh: true, signal }),
  ]);
  record({
    check:
      "multi-client cleanup preserves the replaced writer and unrelated Entity and Object canaries",
    expected: {
      replacement_writer: {
        id: ids.replacementWriterID,
        alias: "replacement multi-client writer Entity",
      },
      entity: "unrelated multi-client acceptance Entity",
      object: "unrelated multi-client acceptance Object",
    },
    actual: {
      replacement_writer: {
        id: replacement.entity_id,
        alias: replacement.alias,
      },
      entity: entity.alias,
      object: object.extra?.owner,
    },
    passed:
      replacement.entity_id === ids.replacementWriterID &&
      replacement.alias === "replacement multi-client writer Entity" &&
      entity.alias === "unrelated multi-client acceptance Entity" &&
      object.extra?.owner === "unrelated multi-client acceptance Object",
  });
}

function clientAssertionNames(clientCount) {
  return Array.from({ length: clientCount }, (_, index) => {
    const client = index + 1;
    return [
      `Client ${client} saw writer resources`,
      `Client ${client} matched writer versions`,
      `Client ${client} sync running`,
      `Client ${client} sync healthy`,
    ];
  }).flat();
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

function isExpectedWriterEntity(entity, runID, writeIndex) {
  const latitude = 38.87 + (writeIndex - 1) * 0.001;
  const longitude = -77.03 - (writeIndex - 1) * 0.001;
  return (
    entity.entity_type === "asset" &&
    entity.alias === `Sync ${runID} asset ${writeIndex}` &&
    entity.subtype === "sync-probe" &&
    approximatelyEqual(entity.components.telemetry?.latitude, latitude) &&
    approximatelyEqual(entity.components.telemetry?.longitude, longitude) &&
    approximatelyEqual(
      entity.components.geometry?.coordinates?.[0],
      longitude,
    ) &&
    approximatelyEqual(
      entity.components.geometry?.coordinates?.[1],
      latitude,
    ) &&
    entity.components.status?.value === "sync-probe" &&
    isRFC3339Timestamp(entity.components.heartbeat?.last_seen) &&
    entity.components.custom_simulation?.run_id === runID &&
    entity.components.custom_simulation?.write_index === writeIndex
  );
}

function writerEntityIndex(runID, entityID) {
  const prefix = `${runID}-sync-asset-`;
  if (!entityID.startsWith(prefix)) return undefined;
  const remainder = entityID.slice(prefix.length);
  const separator = remainder.indexOf("-");
  if (separator <= 0 || separator === remainder.length - 1) return undefined;
  const index = remainder.slice(0, separator);
  if (!/^[1-9]\d*$/u.test(index)) return undefined;
  const value = Number(index);
  return Number.isSafeInteger(value) ? value : undefined;
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
    status: entity.components.status,
    custom_simulation: entity.components.custom_simulation,
    version: entity.metadata.version,
  };
}

function shortID(prefix) {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

function structurallyEqual(actual, expected) {
  return isDeepStrictEqual(actual, expected, { skipPrototype: true });
}

function approximatelyEqual(actual, expected) {
  return typeof actual === "number" && Math.abs(actual - expected) < 1e-12;
}

function strictlyIncreasing(values) {
  return values.every(
    (value, index) => index === 0 || value > values[index - 1],
  );
}

function delay(milliseconds, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(signal.reason);
    };
    function finish() {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
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
