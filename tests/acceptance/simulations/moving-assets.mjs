import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AtlasClient, isAtlasAPIError } from "@the-drunken-coder/atlas-sdk";
import { runAcceptance } from "../support/stack.mjs";
import { createSimulationServerFixture, simulationFixtureVariant } from "./support/server-fixture.mjs";
import {
  prepareTaskFixture,
  taskFixtureCatalog,
  taskFixtureManifest,
  taskFixtureQueuedCommand,
  taskFixtureVariant
} from "./support/task-fixture.mjs";

const reproduction = "npm run build:sdk && node tests/acceptance/simulations/moving-assets.mjs";
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const normalInputs = {
  assetCount: 2,
  ticks: 3,
  tickMs: 50,
  startLatitude: 38.5,
  startLongitude: -77.25
};
const cancelledInputs = {
  assetCount: 2,
  ticks: 100,
  tickMs: 500,
  startLatitude: 37.75,
  startLongitude: -76.75
};
const retainedTaskInput = { value: "retain through moving-assets cleanup" };
const retainedTaskOutput = { result: "completed before moving-assets cleanup" };
const fixture = createSimulationServerFixture();
const taskFixtureComposePath = fileURLToPath(new URL("./task-fixture.compose.yml", import.meta.url));

await runAcceptance({
  name: "simulations-moving-assets",
  reproduction,
  additionalComposeFiles: [taskFixtureComposePath],
  fixtureVariant: { simulation: simulationFixtureVariant, task: taskFixtureVariant },
  prepare: prepareSimulationTaskFixture,
  run: async ({ runID, baseUrl, apiKey, artifacts, record, signal }) => {
    const simulation = await fixture.start({ coreBaseUrl: baseUrl, apiKey, signal });
    const api = createSimulationAPI(simulation.url, join(artifacts, "simulation-http.jsonl"), signal);
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
    const unrelatedEntityID = shortID("acpt-unrelated-entity");
    const unrelatedObjectID = shortID("acpt-unrelated-object");
    let replacementID;
    let retainedTask;

    try {
      verifyServerHealth(simulation.health, baseUrl, record);
      await verifyLocalTargetAndScenario(api, baseUrl, apiKey, record);

      const normal = await startRun(api, normalInputs, { acceptance_run_id: runID, journey: "complete" });
      const normalStream = await collectRunEvents({
        api,
        runID: normal.id,
        artifactBase: join(artifacts, "moving-assets-completed"),
        signal,
        until: (events) => events.some((event) => event.type === "status" && event.status !== "running")
      });
      const normalSummary = (await api.json("GET", `/api/runs/${encodeURIComponent(normal.id)}`)).body.run;
      recordCompletedStream(normal, normalSummary, normalStream.events, record);

      const normalEntities = await readRunEntities(core, normalSummary.createdResources, signal);
      recordPersistedMovement(normalSummary, normalEntities, normalInputs, runID, record);

      const normalEntityIDs = normalSummary.createdResources
        .filter((resource) => resource.type === "entity")
        .map((resource) => resource.id);
      const taskSetup = await createTaskBeforeCleanup({
        core,
        entityIDs: normalEntityIDs,
        record,
        signal
      });
      replacementID = taskSetup.replacementID;
      retainedTask = taskSetup.task;

      await core.entities.create(
        {
          entity_id: unrelatedEntityID,
          entity_type: "asset",
          alias: "unrelated acceptance Entity"
        },
        { instanceToken: unrelatedEntityToken, signal }
      );
      await core.objects.create(
        {
          object_id: unrelatedObjectID,
          type: "image",
          extra: { owner: "unrelated acceptance fixture" }
        },
        { instanceToken: unrelatedObjectToken, signal }
      );
      await core.entities.delete(replacementID);
      await core.entities.create(
        {
          entity_id: replacementID,
          entity_type: "asset",
          alias: "replacement acceptance Entity",
          components: { custom_simulation: { owner: "replacement" } }
        },
        { instanceToken: replacementToken, signal }
      );

      const normalCleanup = await api.json("POST", `/api/runs/${encodeURIComponent(normal.id)}/cleanup`);
      const normalCleanupStream = await collectRunEvents({
        api,
        runID: normal.id,
        artifactBase: join(artifacts, "moving-assets-completed-cleanup"),
        signal,
        until: (events) => events.some((event) => event.type === "cleanup" && event.resource === undefined)
      });
      recordCleanupEvents(normalSummary, normalCleanup.body.run, normalCleanupStream.events, replacementID, record);
      await recordCleanupState({
        core,
        run: normalSummary,
        replacementID,
        unrelatedEntityID,
        unrelatedObjectID,
        signal,
        record
      });
      await recordRetainedTask(core, retainedTask, signal, record);
      recordLocalLedgerState(normal.id, artifacts, record);

      const cancelled = await startRun(api, cancelledInputs, { acceptance_run_id: runID, journey: "cancel" });
      const progressStream = await collectRunEvents({
        api,
        runID: cancelled.id,
        artifactBase: join(artifacts, "moving-assets-cancel-progress"),
        signal,
        until: (events) =>
          events.filter((event) => event.type === "resource" && event.resource?.type === "entity").length ===
            cancelledInputs.assetCount &&
          events.some((event) => event.type === "log" && event.message === `Telemetry tick 1/${cancelledInputs.ticks}`)
      });
      const progressedIDs = progressStream.events
        .filter((event) => event.type === "resource" && event.resource?.type === "entity")
        .map((event) => event.resource.id);
      const stop = await api.json("POST", `/api/runs/${encodeURIComponent(cancelled.id)}/stop`);
      record({
        check: "actual simulation server accepts cancellation through its public route",
        expected: { status: 200, run_status: "cancelled" },
        actual: { status: stop.status, run_status: stop.body.run.status },
        passed: stop.status === 200 && stop.body.run.status === "cancelled"
      });
      const progressedEntities = await readRunEntities(
        core,
        progressedIDs.map((id) => ({ type: "entity", id })),
        signal
      );
      record({
        check: "moving-assets performs real persisted movement before cancellation",
        expected: {
          entities: cancelledInputs.assetCount,
          committed_tick_range: [1, cancelledInputs.ticks],
          coordinates_match_each_committed_tick: true,
          run_id: cancelled.id
        },
        actual: progressedEntities.map(entityState),
        passed:
          progressedEntities.length === cancelledInputs.assetCount &&
          progressedEntities.every((entity) =>
            persistedMovementBeforeCancellation(entity, cancelled, cancelledInputs, runID)
          )
      });
      const cancelledCleanup = await api.json("POST", `/api/runs/${encodeURIComponent(cancelled.id)}/cleanup`);
      const cancelledStream = await collectRunEvents({
        api,
        runID: cancelled.id,
        artifactBase: join(artifacts, "moving-assets-cancelled-cleanup"),
        signal,
        until: (events) => events.some((event) => event.type === "cleanup" && event.resource === undefined)
      });
      recordCancelledCleanup(cancelledCleanup.body.run, cancelledStream.events, progressedIDs, record);
      await recordAllMissing(
        core,
        progressedIDs,
        signal,
        record,
        "cancelled run-owned Entities are absent after cleanup"
      );
      await recordProtectedResources(core, replacementID, unrelatedEntityID, unrelatedObjectID, signal, record);
      recordLocalLedgerState(cancelled.id, artifacts, record);

      const allIDs = [
        ...normalSummary.createdResources.map(({ id }) => id),
        ...progressedIDs,
        retainedTask.task_id,
        unrelatedEntityID,
        unrelatedObjectID
      ];
      record({
        check: "acceptance and simulation resource IDs stay within the Core limit",
        expected: { unique: true, maximum_length: 50 },
        actual: { ids: allIDs, lengths: allIDs.map((id) => id.length) },
        passed: new Set(allIDs).size === allIDs.length && allIDs.every((id) => id.length <= 50)
      });
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

async function prepareSimulationTaskFixture(context) {
  const taskFixture = prepareTaskFixture(context);
  try {
    const simulationFixture = await fixture.prepare(context);
    return {
      environment: taskFixture.environment,
      metadata: {
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

async function createTaskBeforeCleanup({ core, entityIDs, record, signal }) {
  if (entityIDs.length < 2) {
    throw new Error(
      `Completed moving-assets run expected two Entity cleanup candidates, observed ${JSON.stringify(entityIDs)}`
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

  const runtimeID = shortID("acpt-simulation-runtime");
  await core.runtime.begin(taskAssetID, { runtime_id: runtimeID }, { signal });
  await core.runtime.ready(
    taskAssetID,
    { runtime_id: runtimeID, manifest: taskFixtureManifest },
    { signal }
  );
  const created = await core.tasks.create(
    {
      asset_id: taskAssetID,
      command: taskFixtureQueuedCommand,
      input: retainedTaskInput
    },
    { idempotencyKey: shortID("acpt-simulation-task"), signal }
  );
  const beforeCleanup = await core.tasks.get(created.task_id, { fresh: true, signal });
  record({
    check: "public runtime and Task APIs persist a nonempty pending Task before simulation cleanup",
    expected: {
      asset_id: taskAssetID,
      command: taskFixtureQueuedCommand,
      input: retainedTaskInput,
      status: "pending"
    },
    actual: taskState(beforeCleanup),
    passed: matchesRetainedTask(beforeCleanup, {
      taskID: created.task_id,
      assetID: taskAssetID,
      status: "pending"
    })
  });

  const delivery = await core.runtime.tasks(taskAssetID, { runtimeId: runtimeID, signal });
  record({
    check: "registered runtime receives the nonempty Task before simulation cleanup",
    expected: {
      task_ids: [created.task_id],
      input: retainedTaskInput,
      statuses: ["pending"]
    },
    actual: delivery.tasks.map(taskState),
    passed:
      delivery.tasks.length === 1 &&
      matchesRetainedTask(delivery.tasks[0], {
        taskID: created.task_id,
        assetID: taskAssetID,
        status: "pending"
      })
  });

  await core.tasks.acknowledge(created.task_id, { runtimeId: runtimeID, signal });
  await core.tasks.start(created.task_id, { runtimeId: runtimeID, signal });
  await core.tasks.complete(created.task_id, {
    runtimeId: runtimeID,
    output: retainedTaskOutput,
    signal
  });
  const completedBeforeCleanup = await core.tasks.get(created.task_id, { fresh: true, signal });
  record({
    check: "runtime completes the nonempty Task before deleting its Asset",
    expected: {
      task_id: created.task_id,
      asset_id: taskAssetID,
      input: retainedTaskInput,
      output: retainedTaskOutput,
      status: "completed"
    },
    actual: taskState(completedBeforeCleanup),
    passed: matchesRetainedTask(completedBeforeCleanup, {
      taskID: created.task_id,
      assetID: taskAssetID,
      status: "completed"
    })
  });

  return {
    replacementID,
    task: { task_id: created.task_id, asset_id: taskAssetID }
  };
}

async function recordRetainedTask(core, retainedTask, signal, record) {
  const afterCleanup = await core.tasks.get(retainedTask.task_id, { fresh: true, signal });
  record({
    check: "Task remains independently readable after cleanup deletes its run-owned Asset",
    expected: {
      task_id: retainedTask.task_id,
      asset_id: retainedTask.asset_id,
      command: taskFixtureQueuedCommand,
      input: retainedTaskInput,
      output: retainedTaskOutput,
      status: "completed"
    },
    actual: taskState(afterCleanup),
    passed: matchesRetainedTask(afterCleanup, {
      taskID: retainedTask.task_id,
      assetID: retainedTask.asset_id,
      status: "completed"
    })
  });
}

function matchesRetainedTask(task, { taskID, assetID, status }) {
  return (
    task.task_id === taskID &&
    task.asset_id === assetID &&
    task.command === taskFixtureQueuedCommand &&
    task.status === status &&
    isDeepStrictEqual(task.input, retainedTaskInput) &&
    (status !== "completed" || isDeepStrictEqual(task.output, retainedTaskOutput))
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

function createSimulationAPI(baseUrl, logPath, acceptanceSignal) {
  return {
    async json(method, path, body) {
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
          signal: AbortSignal.any([acceptanceSignal, AbortSignal.timeout(15_000)])
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
          response: parsed
        });
        if (!response.ok) {
          throw new Error(`${method} ${path} returned HTTP ${response.status}: ${raw}`);
        }
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
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    },
    baseUrl
  };
}

async function verifyLocalTargetAndScenario(api, coreBaseUrl, apiKey, record) {
  const targets = await api.json("GET", "/api/targets");
  const scenarios = await api.json("GET", "/api/scenarios");
  const serializedTargets = JSON.stringify(targets.body);
  record({
    check: "simulation acceptance exposes only the disposable loopback target",
    expected: {
      default_target_id: "local",
      targets: [{ id: "local", baseUrl: coreBaseUrl, deployed: false, apiKeyConfigured: true }],
      credentials_disclosed: false
    },
    actual: {
      default_target_id: targets.body.defaultTargetId,
      targets: targets.body.targets,
      credentials_disclosed: serializedTargets.includes(apiKey)
    },
    passed:
      targets.body.defaultTargetId === "local" &&
      targets.body.targets.length === 1 &&
      targets.body.targets[0]?.id === "local" &&
      targets.body.targets[0]?.baseUrl === coreBaseUrl &&
      targets.body.targets[0]?.deployed === false &&
      targets.body.targets[0]?.apiKeyConfigured === true &&
      !serializedTargets.includes(apiKey)
  });
  const movingAssets = scenarios.body.scenarios.find((scenario) => scenario.id === "moving-assets");
  record({
    check: "actual server registers the bounded moving-assets scenario",
    expected: {
      id: "moving-assets",
      asset_count: { min: 1, max: 25 },
      ticks: { min: 1, max: 100 },
      tick_ms: { min: 0, max: 10_000 }
    },
    actual: movingAssets,
    passed:
      movingAssets !== undefined &&
      fieldBounds(movingAssets, "assetCount", 1, 25) &&
      fieldBounds(movingAssets, "ticks", 1, 100) &&
      fieldBounds(movingAssets, "tickMs", 0, 10_000)
  });
}

function verifyServerHealth(health, coreBaseUrl, record) {
  record({
    check: "actual simulation server reports the disposable Core healthy",
    expected: { ok: true, status: 200, target: { id: "local", baseUrl: coreBaseUrl, deployed: false } },
    actual: health,
    passed:
      health.ok === true &&
      health.status === 200 &&
      health.target?.id === "local" &&
      health.target?.baseUrl === coreBaseUrl &&
      health.target?.deployed === false
  });
}

async function startRun(api, inputs, jsonInput) {
  const response = await api.json("POST", "/api/runs", {
    scenarioId: "moving-assets",
    targetId: "local",
    inputs,
    jsonInput: JSON.stringify(jsonInput)
  });
  if (response.status !== 201 || response.body.run?.scenarioId !== "moving-assets") {
    throw new Error(`Starting moving-assets expected HTTP 201 and its run summary, observed ${response.raw}`);
  }
  return response.body.run;
}

function recordCompletedStream(started, completed, events, record) {
  const resourceEvents = events.filter((event) => event.type === "resource");
  const tickEvents = events.filter((event) => event.type === "log" && event.message.startsWith("Telemetry tick "));
  const terminal = events.find((event) => event.type === "status" && event.status !== "running");
  const assertions = events.filter((event) => event.type === "assertion");
  record({
    check: "actual server event stream reports the complete moving-assets execution",
    expected: {
      first_status: "running",
      terminal_status: "completed",
      entity_resources: normalInputs.assetCount,
      telemetry_ticks: normalInputs.ticks,
      passing_assertions: ["Assets persisted", "Telemetry persisted"],
      increasing_sequences: true
    },
    actual: {
      first_event: events[0],
      terminal,
      resources: resourceEvents.map((event) => event.resource),
      ticks: tickEvents.map((event) => event.message),
      assertions: assertions.map((event) => event.assertion),
      sequences: events.map((event) => event.sequence)
    },
    passed:
      started.status === "running" &&
      completed.status === "completed" &&
      events[0]?.type === "status" &&
      events[0]?.status === "running" &&
      terminal?.status === "completed" &&
      resourceEvents.length === normalInputs.assetCount &&
      resourceEvents.every((event) => event.resource?.type === "entity") &&
      tickEvents.length === normalInputs.ticks &&
      isDeepStrictEqual(
        assertions.map((event) => event.assertion?.name),
        ["Assets persisted", "Telemetry persisted"]
      ) &&
      assertions.every((event) => event.assertion?.passed === true) &&
      strictlyIncreasing(events.map((event) => event.sequence)) &&
      events.every((event) => event.runId === completed.id)
  });
}

function recordPersistedMovement(run, entities, inputs, acceptanceRunID, record) {
  const expected = expectedMovingAssets(run.id, inputs, inputs.ticks, acceptanceRunID);
  const actual = entities.map(entityState);
  const passed = matchesExpectedAssets(entities, expected);
  record({
    check: "independent built SDK reads verify persisted final moving-assets telemetry",
    expected: {
      count: inputs.assetCount,
      final_speed_m_s: 12 + inputs.ticks,
      coordinate_delta_per_tick: { latitude: 0.0005, longitude: 0.0008 },
      simulation_run_id: run.id,
      acceptance_run_id: acceptanceRunID,
      assets: expected
    },
    actual,
    passed
  });
}

function persistedMovementBeforeCancellation(entity, run, inputs, acceptanceRunID) {
  return Array.from({ length: inputs.ticks }, (_, index) => index + 1)
    .flatMap((tick) => expectedMovingAssets(run.id, inputs, tick, acceptanceRunID))
    .some((expected) => matchesExpectedAsset(entity, expected));
}

function expectedMovingAssets(runID, inputs, tick, acceptanceRunID) {
  return Array.from({ length: inputs.assetCount }, (_, index) => {
    const assetNumber = index + 1;
    const latitude = Number((inputs.startLatitude + index * 0.001 + tick * 0.0005).toFixed(6));
    const longitude = Number((inputs.startLongitude + index * 0.002 + tick * 0.0008).toFixed(6));
    return {
      alias: `Sim ${runID} asset ${assetNumber}`,
      telemetry: { latitude, longitude, speed_m_s: 12 + tick },
      geometry: { coordinates: [longitude, latitude] },
      custom_simulation: { run_id: runID, acceptance_run_id: acceptanceRunID }
    };
  });
}

function matchesExpectedAssets(entities, expected) {
  return (
    entities.length === expected.length &&
    expected.every((asset) => entities.some((entity) => matchesExpectedAsset(entity, asset)))
  );
}

function matchesExpectedAsset(entity, expected) {
  return (
    entity.alias === expected.alias &&
    entity.components.telemetry?.latitude === expected.telemetry.latitude &&
    entity.components.telemetry?.longitude === expected.telemetry.longitude &&
    entity.components.telemetry?.speed_m_s === expected.telemetry.speed_m_s &&
    isDeepStrictEqual(entity.components.geometry?.coordinates, expected.geometry.coordinates) &&
    entity.components.custom_simulation?.run_id === expected.custom_simulation.run_id &&
    entity.components.custom_simulation?.acceptance_run_id === expected.custom_simulation.acceptance_run_id
  );
}

function recordCleanupEvents(run, cleaned, events, replacementID, record) {
  const cleanupEvents = events.filter((event) => event.type === "cleanup" && event.resource);
  const replacementEvent = cleanupEvents.find((event) => event.resource?.id === replacementID);
  record({
    check: "simulation cleanup reports every run-owned Entity and completes",
    expected: {
      cleaned: true,
      resources: run.createdResources,
      resource_types: ["entity"],
      replacement: `${replacementID} owned instance is no longer present`,
      final_event: "Cleanup complete"
    },
    actual: {
      cleaned: cleaned.cleaned,
      resource_types: [...new Set(cleanupEvents.map((event) => event.resource.type))],
      resources: cleanupEvents.map((event) => ({ resource: event.resource, message: event.message })),
      final_event: events.find((event) => event.type === "cleanup" && event.resource === undefined)?.message
    },
    passed:
      cleaned.cleaned === true &&
      run.createdResources.every((resource) => resource.type === "entity") &&
      cleanupEvents.every((event) => event.resource.type === "entity") &&
      cleanupEvents.length === run.createdResources.filter((resource) => resource.type !== "task").length &&
      replacementEvent?.message === `entity ${replacementID} owned instance is no longer present` &&
      events.some(
        (event) => event.type === "cleanup" && event.resource === undefined && event.message === "Cleanup complete"
      )
  });
}

async function recordCleanupState({ core, run, replacementID, unrelatedEntityID, unrelatedObjectID, signal, record }) {
  const deletedIDs = run.createdResources.filter(({ id }) => id !== replacementID).map(({ id }) => id);
  await recordAllMissing(core, deletedIDs, signal, record, "cleanup removes the remaining run-owned Entity instances");
  await recordProtectedResources(core, replacementID, unrelatedEntityID, unrelatedObjectID, signal, record);
}

async function recordProtectedResources(core, replacementID, unrelatedEntityID, unrelatedObjectID, signal, record) {
  const [replacement, unrelatedEntity, unrelatedObject] = await Promise.all([
    core.entities.get(replacementID, { fresh: true, signal }),
    core.entities.get(unrelatedEntityID, { fresh: true, signal }),
    core.objects.get(unrelatedObjectID, { fresh: true, signal })
  ]);
  record({
    check: "cleanup preserves replacement and unrelated resource instances",
    expected: {
      replacement: { id: replacementID, alias: "replacement acceptance Entity" },
      unrelated_entity: { id: unrelatedEntityID, alias: "unrelated acceptance Entity" },
      unrelated_object: { id: unrelatedObjectID, owner: "unrelated acceptance fixture" }
    },
    actual: {
      replacement: { id: replacement.entity_id, alias: replacement.alias },
      unrelated_entity: { id: unrelatedEntity.entity_id, alias: unrelatedEntity.alias },
      unrelated_object: { id: unrelatedObject.object_id, owner: unrelatedObject.extra?.owner }
    },
    passed:
      replacement.entity_id === replacementID &&
      replacement.alias === "replacement acceptance Entity" &&
      unrelatedEntity.entity_id === unrelatedEntityID &&
      unrelatedEntity.alias === "unrelated acceptance Entity" &&
      unrelatedObject.object_id === unrelatedObjectID &&
      unrelatedObject.extra?.owner === "unrelated acceptance fixture"
  });
}

function recordCancelledCleanup(cleaned, events, progressedIDs, record) {
  const cleanupIDs = events
    .filter((event) => event.type === "cleanup" && event.resource?.type === "entity")
    .map((event) => event.resource.id)
    .sort();
  record({
    check: "cancelled moving-assets run settles and cleans only its recorded Entities",
    expected: {
      status: "cancelled",
      cleaned: true,
      cleanup_ids: [...progressedIDs].sort(),
      stop_event: true,
      terminal_event: true
    },
    actual: {
      status: cleaned.status,
      cleaned: cleaned.cleaned,
      cleanup_ids: cleanupIDs,
      stop_event: events.some((event) => event.type === "log" && event.message === "Stop requested"),
      terminal_event: events.some(
        (event) => event.type === "status" && event.status === "cancelled" && event.message === "Stop requested"
      )
    },
    passed:
      cleaned.status === "cancelled" &&
      cleaned.cleaned === true &&
      isDeepStrictEqual(cleanupIDs, [...progressedIDs].sort()) &&
      events.some((event) => event.type === "log" && event.message === "Stop requested") &&
      events.some((event) => event.type === "status" && event.status === "cancelled") &&
      events.some((event) => event.type === "cleanup" && event.resource === undefined)
  });
}

async function recordAllMissing(core, ids, signal, record, check) {
  const actual = await Promise.all(
    ids.map((id) => captureMissing(() => core.entities.get(id, { fresh: true, signal }), id))
  );
  record({
    check,
    expected: ids.map((id) => ({ id, status: 404, error_code: "ENTITY_NOT_FOUND" })),
    actual,
    passed:
      actual.length === ids.length &&
      actual.every(
        (result) =>
          result.status === 404 &&
          result.error_code === "ENTITY_NOT_FOUND" &&
          typeof result.response === "object" &&
          result.response !== null
      )
  });
}

async function captureMissing(operation, id) {
  try {
    await operation();
    return { id, status: 200 };
  } catch (error) {
    if (isAtlasAPIError(error)) {
      return {
        id,
        status: error.status,
        error_code: error.errorCode,
        message: error.message,
        response: error.response
      };
    }
    return { id, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readRunEntities(core, resources, signal) {
  return Promise.all(
    resources
      .filter((resource) => resource.type === "entity")
      .map((resource) => core.entities.get(resource.id, { fresh: true, signal }))
  );
}

async function collectRunEvents({ api, runID, artifactBase, signal, until }) {
  const response = await fetch(`${api.baseUrl}/api/runs/${encodeURIComponent(runID)}/events`, {
    headers: { Accept: "text/event-stream" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  });
  if (!response.ok || !response.body) {
    const raw = await response.text();
    throw new Error(`GET run events returned HTTP ${response.status}: ${raw}`);
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
        const frame = pending.slice(0, separator);
        pending = pending.slice(separator + 2);
        const event = parseEventFrame(frame);
        if (event) events.push(event);
        separator = pending.indexOf("\n\n");
      }
      if (until(events)) {
        await reader.cancel();
        return { events, raw };
      }
    }
    throw new Error(`Simulation event stream ended before its acceptance condition: ${raw}`);
  } finally {
    writeFileSync(`${artifactBase}.sse`, raw);
    writeFileSync(`${artifactBase}.events.json`, `${JSON.stringify(events, null, 2)}\n`);
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

function recordLocalLedgerState(simulationRunID, artifacts, record) {
  const ledgerPath = join(repositoryRoot, "simulations", ".atlas-simulations", "runs", `${simulationRunID}.json`);
  const present = existsSync(ledgerPath);
  const state = { run_id: simulationRunID, local_ledger_file_present: present };
  appendJSON(join(artifacts, "local-ledger-checks.jsonl"), state);
  record({
    check: "local disposable run does not create a deployed cleanup ledger record",
    expected: { run_id: simulationRunID, local_ledger_file_present: false },
    actual: state,
    passed: !present
  });
}

function fieldBounds(scenario, key, min, max) {
  const field = scenario.inputFields.find((candidate) => candidate.key === key);
  return field?.type === "number" && field.min === min && field.max === max;
}

function entityState(entity) {
  return {
    id: entity.entity_id,
    alias: entity.alias,
    version: entity.metadata.version,
    telemetry: entity.components.telemetry,
    geometry: entity.components.geometry,
    custom_simulation: entity.components.custom_simulation
  };
}

function shortID(prefix) {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

function strictlyIncreasing(values) {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
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
