import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AtlasClient, isAtlasAPIError } from "@the-drunken-coder/atlas-sdk";
import { runAcceptance } from "../support/stack.mjs";
import {
  createSimulationServerFixture,
  simulationFixtureVariant,
} from "./support/server-fixture.mjs";

const reproduction =
  "npm run build:sdk && node tests/acceptance/simulations/observations-objects.mjs";
const nightly = process.env.ATLAS_ACCEPTANCE_NIGHTLY === "1";
const normalInputs = {
  assetCount: nightly ? 3 : 2,
  observations: nightly ? 8 : 3,
  tickMs: 50,
  startLatitude: 38.88,
  startLongitude: -77.04,
};
const cancellationInputs = {
  assetCount: 2,
  observations: nightly ? 8 : 5,
  tickMs: 200,
  startLatitude: 37.88,
  startLongitude: -76.04,
};
const observationJSON = { collection: "acceptance-observations" };
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
      await verifyLocalTargetAndScenario(api, baseUrl, apiKey, record);
      if (nightly) await recordInvalidInputFault(api, record);

      const normal = await startRun(api, normalInputs, observationJSON);
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
      const normalSummary = await readRun(api, normal.id);
      recordCompletedStream(
        normalSummary,
        normalStream.events,
        normalInputs,
        record,
      );
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

      const cleanedNormal = await api.json(
        "POST",
        `/api/runs/${encodeURIComponent(normal.id)}/cleanup`,
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
        cleanedNormal.body.run,
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

      const cancelled = await startRun(
        api,
        cancellationInputs,
        observationJSON,
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
      record({
        check:
          "observations-objects accepts cancellation through its public route",
        expected: { status: 200, run_status: "cancelled" },
        actual: {
          status: cancelledRun.status,
          run_status: cancelledRun.body.run.status,
          progress_events: cancellationProgress.events.length,
        },
        passed:
          cancelledRun.status === 200 &&
          cancelledRun.body.run.status === "cancelled" &&
          cancellationProgress.events.length > 0,
      });
      const cancelledSummary = await readRun(api, cancelled.id);
      const cleanedCancelled = await api.json(
        "POST",
        `/api/runs/${encodeURIComponent(cancelled.id)}/cleanup`,
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
        cleanedCancelled.body.run,
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
    (candidate) => candidate.id === "observations-objects",
  );
  record({
    check:
      "observations acceptance exposes only the disposable loopback target",
    expected: {
      default_target_id: "local",
      deployed: false,
      credentials_disclosed: false,
    },
    actual: {
      default_target_id: targets.body.defaultTargetId,
      targets: targets.body.targets,
      credentials_disclosed: JSON.stringify(targets.body).includes(apiKey),
    },
    passed:
      targets.body.defaultTargetId === "local" &&
      targets.body.targets.length === 1 &&
      targets.body.targets[0]?.baseUrl === coreBaseUrl &&
      targets.body.targets[0]?.deployed === false &&
      !JSON.stringify(targets.body).includes(apiKey),
  });
  record({
    check: "actual server registers the observations-objects contract",
    expected: {
      accepts_json: true,
      asset_count: [1, 10],
      observations: [1, 50],
      tick_ms_step: 50,
    },
    actual: scenario,
    passed:
      scenario?.acceptsJson === true &&
      fieldBounds(scenario, "assetCount", 1, 10) &&
      fieldBounds(scenario, "observations", 1, 50) &&
      scenario.inputFields.find((field) => field.key === "tickMs")?.step === 50,
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

async function startRun(api, inputs, jsonInput) {
  const response = await api.json("POST", "/api/runs", {
    scenarioId: "observations-objects",
    targetId: "local",
    inputs,
    jsonInput: JSON.stringify(jsonInput),
  });
  if (
    response.status !== 201 ||
    response.body.run?.scenarioId !== "observations-objects"
  ) {
    throw new Error(
      `Starting observations-objects expected HTTP 201, observed ${response.raw}`,
    );
  }
  return response.body.run;
}

async function readRun(api, runID) {
  return (await api.json("GET", `/api/runs/${encodeURIComponent(runID)}`)).body
    .run;
}

function recordCompletedStream(run, events, inputs, record) {
  const resources = events.filter((event) => event.type === "resource");
  const observations = events.filter(
    (event) => event.type === "log" && event.message.startsWith("Observation "),
  );
  const assertions = events.filter((event) => event.type === "assertion");
  const terminal = events.find(
    (event) => event.type === "status" && event.status !== "running",
  );
  record({
    check: "actual server event stream completes observations-objects",
    expected: {
      status: "completed",
      resources: inputs.assetCount + inputs.observations * 2,
      observation_logs: inputs.observations,
      assertions: [
        "Observer assets persisted",
        "Tracks persisted",
        "Object references persisted",
      ],
    },
    actual: {
      terminal,
      resources: resources.map((event) => event.resource),
      logs: observations.map((event) => event.message),
      assertions: assertions.map((event) => event.assertion),
    },
    passed:
      run.status === "completed" &&
      terminal?.status === "completed" &&
      resources.length === inputs.assetCount + inputs.observations * 2 &&
      observations.length === inputs.observations &&
      isDeepStrictEqual(
        assertions.map((event) => event.assertion?.name),
        [
          "Observer assets persisted",
          "Tracks persisted",
          "Object references persisted",
        ],
      ) &&
      assertions.every((event) => event.assertion?.passed === true) &&
      strictlyIncreasing(events.map((event) => event.sequence)) &&
      events.every((event) => event.runId === run.id),
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
  const observerByIndex = new Map(
    Array.from({ length: inputs.assetCount }, (_, index) => [
      index + 1,
      observers.find(
        (entity) => entity.alias === `Observer ${run.id} ${index + 1}`,
      ),
    ]),
  );
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
        latitude,
        longitude,
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
      const track = tracks.find(
        (candidate) => candidate.alias === expectedTracks[index].alias,
      );
      return {
        object: objectByObservation.get(observation),
        observation,
        trackID: track?.entity_id,
      };
    },
  );
  record({
    check:
      "independent SDK reads verify persisted observer, track, Object bytes, and relations",
    expected: {
      observers: inputs.assetCount,
      tracks: expectedTracks.map(
        ({ observation, alias, latitude, longitude }) => ({
          observation,
          alias,
          latitude,
          longitude,
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
      observers: observers.map((entity) => entityState(entity)),
      tracks: tracks.map((entity) => entityState(entity)),
      objects: objects.map((object) => objectState(object)),
      object_index_mapping: indexedObjects.map(({ object, observation }) => ({
        object_id: object.object_id,
        observation,
      })),
    },
    passed:
      observers.length === inputs.assetCount &&
      Array.from({ length: inputs.assetCount }, (_, index) => {
        const observer = observerByIndex.get(index + 1);
        const latitude = inputs.startLatitude + index * 0.001;
        const longitude = inputs.startLongitude + index * 0.001;
        return (
          observer?.entity_type === "asset" &&
          observer.alias === `Observer ${run.id} ${index + 1}` &&
          approximatelyEqual(
            observer.components.telemetry?.latitude,
            latitude,
          ) &&
          approximatelyEqual(
            observer.components.telemetry?.longitude,
            longitude,
          ) &&
          approximatelyEqual(
            observer.components.geometry?.coordinates?.[0],
            longitude,
          ) &&
          approximatelyEqual(
            observer.components.geometry?.coordinates?.[1],
            latitude,
          )
        );
      }).every(Boolean) &&
      tracks.length === inputs.observations &&
      expectedTracks.every((expected) =>
        tracks.some((track) => {
          const simulation = track.components.custom_simulation;
          return (
            track.alias === expected.alias &&
            track.components.telemetry?.latitude === expected.latitude &&
            track.components.telemetry?.longitude === expected.longitude &&
            isDeepStrictEqual(track.components.geometry?.coordinates, [
              expected.longitude,
              expected.latitude,
            ]) &&
            simulation?.run_id === run.id &&
            simulation?.observer_id === expected.observer?.entity_id &&
            simulation?.observation_index === expected.observation &&
            simulation?.collection === jsonInput.collection
          );
        }),
      ) &&
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
  record({
    check:
      "observations cleanup reports every recorded Entity and Object resource",
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
    } else {
      await core.objects.get(resource.id, { fresh: true, signal });
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
  const response = await fetch(
    `${api.baseUrl}/api/runs/${encodeURIComponent(runID)}/events`,
    {
      headers: { Accept: "text/event-stream" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(
      `GET run events returned HTTP ${response.status}: ${await response.text()}`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let pending = "";
  let raw = "";
  try {
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
  return data ? parseJSON(data, "simulation event frame") : undefined;
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
