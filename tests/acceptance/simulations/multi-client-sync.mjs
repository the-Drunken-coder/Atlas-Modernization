import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AtlasClient, isAtlasAPIError } from "@the-drunken-coder/atlas-sdk";
import { runAcceptance } from "../support/stack.mjs";
import { startReaders, stopReaders } from "./support/multi-client-readers.mjs";
import {
  createSimulationServerFixture,
  simulationFixtureVariant,
} from "./support/server-fixture.mjs";

const reproduction =
  "npm run build:sdk && node tests/acceptance/simulations/multi-client-sync.mjs";
const nightly = process.env.ATLAS_ACCEPTANCE_NIGHTLY === "1";
const normalInputs = nightly
  ? { clientCount: 4, writes: 8, settleMs: 2_500 }
  : { clientCount: 2, writes: 3, settleMs: 1_500 };
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

    try {
      verifyServerHealth(simulation.health, baseUrl, record);
      await verifyLocalTargetAndScenario(api, baseUrl, apiKey, record);
      if (nightly) await recordInvalidInputFault(api, record);

      const run = await startRun(api, normalInputs);
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
      const summary = await readRun(api, run.id);
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

      const cleanup = await api.json(
        "POST",
        `/api/runs/${encodeURIComponent(run.id)}/cleanup`,
      );
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
        cleanup.body.run,
        cleanupStream.events,
        record,
      );
      await recordAllMissing(core, summary.createdResources, signal, record);
      await recordUnrelatedResources(
        core,
        { unrelatedEntityID, unrelatedObjectID },
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
          AbortSignal.timeout(15_000),
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
  record({
    check:
      "multi-client acceptance exposes only the disposable loopback target",
    expected: {
      target_id: "local",
      default_target_id: "local",
      deployed: false,
      credentials_disclosed: false,
    },
    actual: {
      target_id: targets.body.targets[0]?.id,
      default_target_id: targets.body.defaultTargetId,
      targets: targets.body.targets,
      credentials_disclosed: JSON.stringify(targets.body).includes(apiKey),
    },
    passed:
      targets.body.defaultTargetId === "local" &&
      targets.body.targets.length === 1 &&
      targets.body.targets[0]?.id === "local" &&
      targets.body.targets[0]?.baseUrl === coreBaseUrl &&
      targets.body.targets[0]?.deployed === false &&
      !JSON.stringify(targets.body).includes(apiKey),
  });
  record({
    check: "actual server registers the multi-client-sync contract",
    expected: {
      accepts_json: false,
      client_count: [1, 8],
      writes: [1, 20],
      settle_ms: [1_500, 10_000],
      settle_ms_step: 50,
    },
    actual: scenario,
    passed:
      scenario?.acceptsJson === false &&
      fieldBounds(scenario, "clientCount", 1, 8) &&
      fieldBounds(scenario, "writes", 1, 20) &&
      fieldBounds(scenario, "settleMs", 1_500, 10_000) &&
      scenario.inputFields.find((field) => field.key === "settleMs")?.step ===
        50,
  });
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

async function startRun(api, inputs) {
  const response = await api.json("POST", "/api/runs", {
    scenarioId: "multi-client-sync",
    targetId: "local",
    inputs,
  });
  if (
    response.status !== 201 ||
    response.body.run?.scenarioId !== "multi-client-sync"
  ) {
    throw new Error(
      `Starting multi-client-sync expected HTTP 201, observed ${response.raw}`,
    );
  }
  return response.body.run;
}

async function readRun(api, runID) {
  return (await api.json("GET", `/api/runs/${encodeURIComponent(runID)}`)).body
    .run;
}

function recordCompletedStream(run, summary, events, inputs, record) {
  const resources = events.filter((event) => event.type === "resource");
  const assertions = events.filter((event) => event.type === "assertion");
  const terminal = events.find(
    (event) => event.type === "status" && event.status !== "running",
  );
  record({
    check: "actual server event stream completes multi-client-sync",
    expected: {
      status: "completed",
      resources: inputs.writes,
      successful_assertions: inputs.clientCount * 4,
    },
    actual: {
      terminal,
      resources: resources.map((event) => event.resource),
      assertions: assertions.map((event) => event.assertion),
    },
    passed:
      summary.status === "completed" &&
      terminal?.status === "completed" &&
      resources.length === inputs.writes &&
      assertions.length === inputs.clientCount * 4 &&
      assertions.every((event) => event.assertion?.passed === true) &&
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
      run_id: run.id,
      write_indexes: Array.from({ length: inputs.writes }, (_, index) =>
        index + 1,
      ),
    },
    actual: {
      entities: entities.map(entityState),
      entity_index_mapping: indexedEntities.map(({ entity, writeIndex }) => ({
        entity_id: entity.entity_id,
        write_index: writeIndex,
      })),
    },
    passed:
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
    },
    actual,
    passed:
      readers.length === inputs.clientCount &&
      readers.every((reader) => readerMatchesWriter(reader, writerByID)),
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
  record({
    check: "multi-client cleanup reports every run-owned Entity",
    expected: { cleaned: true, resources: expected },
    actual: { cleaned: cleaned.cleaned, resources: actual },
    passed:
      cleaned.cleaned === true &&
      isDeepStrictEqual(actual, expected) &&
      events.some(
        (event) =>
          event.type === "cleanup" &&
          event.resource === undefined &&
          event.message === "Cleanup complete",
      ),
  });
}

async function recordAllMissing(core, resources, signal, record) {
  const actual = await Promise.all(
    resources.map(async (resource) => {
      try {
        await core.entities.get(resource.id, { fresh: true, signal });
        return { id: resource.id, status: 200 };
      } catch (error) {
        if (!isAtlasAPIError(error)) throw error;
        return {
          id: resource.id,
          status: error.status,
          error_code: error.errorCode,
        };
      }
    }),
  );
  record({
    check: "multi-client cleanup removes every run-owned Entity",
    expected: resources.map((resource) => ({
      id: resource.id,
      status: 404,
      error_code: "ENTITY_NOT_FOUND",
    })),
    actual,
    passed:
      actual.length === resources.length &&
      actual.every(
        (result) =>
          result.status === 404 && result.error_code === "ENTITY_NOT_FOUND",
      ),
  });
}

async function recordUnrelatedResources(core, ids, signal, record) {
  const [entity, object] = await Promise.all([
    core.entities.get(ids.unrelatedEntityID, { fresh: true, signal }),
    core.objects.get(ids.unrelatedObjectID, { fresh: true, signal }),
  ]);
  record({
    check:
      "multi-client cleanup preserves unrelated Entity and Object canaries",
    expected: {
      entity: "unrelated multi-client acceptance Entity",
      object: "unrelated multi-client acceptance Object",
    },
    actual: {
      entity: entity.alias,
      object: object.extra?.owner,
    },
    passed:
      entity.alias === "unrelated multi-client acceptance Entity" &&
      object.extra?.owner === "unrelated multi-client acceptance Object",
  });
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
      throw new Error(`GET run events returned HTTP ${response.status}: ${raw}`);
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

function fieldBounds(scenario, key, min, max) {
  const field = scenario?.inputFields.find(
    (candidate) => candidate.key === key,
  );
  return field?.type === "number" && field.min === min && field.max === max;
}

function entityState(entity) {
  return {
    id: entity.entity_id,
    type: entity.entity_type,
    alias: entity.alias,
    subtype: entity.subtype,
    telemetry: entity.components.telemetry,
    geometry: entity.components.geometry,
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
  return data ? parseJSON(data, "simulation event frame") : undefined;
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
