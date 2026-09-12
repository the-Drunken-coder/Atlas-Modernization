import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AtlasClient, isAtlasAPIError } from "@the-drunken-coder/atlas-sdk";
import { runAcceptance } from "./support/stack.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureCatalogPath = join(
  repositoryRoot,
  "packages/protocol/conformance/tasking/fixtures/catalog.json",
);
const fixtureManifestPath = join(
  repositoryRoot,
  "packages/protocol/conformance/tasking/fixtures/manifest.json",
);
const fixtureComposePath = fileURLToPath(
  new URL("./task-fixture.compose.yml", import.meta.url),
);
const fixtureCatalogText = readFileSync(fixtureCatalogPath, "utf8");
const fixtureCatalog = JSON.parse(fixtureCatalogText);
const fixtureManifest = JSON.parse(readFileSync(fixtureManifestPath, "utf8"));
const queuedCommand = "fixture.queued";
const completedOutput = { result: "done" };
const reproduction = "npm run build:sdk && node tests/acceptance/sdk-tasks.mjs";

await runAcceptance({
  name: "sdk-tasks",
  reproduction,
  additionalComposeFiles: [fixtureComposePath],
  fixtureVariant: {
    name: "tasking-conformance-catalog-overlay",
    catalog: "packages/protocol/conformance/tasking/fixtures/catalog.json",
    manifest: "packages/protocol/conformance/tasking/fixtures/manifest.json",
    scope: "test-only compile-time Core catalog overlay",
  },
  prepare: prepareTaskFixture,
  run: async ({ baseUrl, apiKey, record, signal }) => {
    const client = new AtlasClient({
      baseUrl,
      apiKey,
      sync: false,
      pollIntervalMs: 0,
      requestTimeoutMs: 10_000,
    });
    const assetID = `acpt-task-${randomUUID()}`;
    const runtimeA = `acpt-rta-${randomUUID()}`;
    const runtimeB = `acpt-rtb-${randomUUID()}`;

    signal.throwIfAborted();
    const catalog = await client.commandCatalog();
    record({
      check:
        "fixture-overlay Core exposes the canonical Task conformance catalog",
      expected: fixtureCatalog,
      actual: catalog,
      passed: isDeepStrictEqual(catalog, fixtureCatalog),
    });

    await client.entities.create(
      { entity_id: assetID, entity_type: "asset" },
      { signal },
    );
    await client.runtime.begin(assetID, { runtime_id: runtimeA }, { signal });
    await client.runtime.ready(
      assetID,
      { runtime_id: runtimeA, manifest: fixtureManifest },
      { signal },
    );

    const firstTask = await createQueuedTask(client, assetID, "first", signal);
    const initialRead = await freshTask(client, firstTask.task_id, signal);
    record({
      check: "Task creation persists a pending queued Task through real Core",
      expected: {
        asset_id: assetID,
        command: queuedCommand,
        input: { value: "first" },
        status: "pending",
      },
      actual: taskState(initialRead),
      passed: matchesPendingTask(initialRead, assetID, "first"),
    });

    const initialDelivery = await client.runtime.tasks(assetID, {
      runtimeId: runtimeA,
      signal,
    });
    record({
      check: "Asset runtime receives the first pending queued Task",
      expected: { task_ids: [firstTask.task_id], statuses: ["pending"] },
      actual: deliveryState(initialDelivery),
      passed: deliveryMatches(initialDelivery, firstTask.task_id),
    });

    const secondTask = await createQueuedTask(
      client,
      assetID,
      "second",
      signal,
    );
    const acknowledged = await client.tasks.acknowledge(firstTask.task_id, {
      runtimeId: runtimeA,
      signal,
    });
    const acknowledgedRead = await freshTask(client, firstTask.task_id, signal);
    record({
      check:
        "Asset acknowledgement is retained by an independent public Task read",
      expected: {
        status: "acknowledged",
        acknowledged_at: "RFC3339 timestamp",
        started_at: "absent",
      },
      actual: taskState(acknowledgedRead),
      passed:
        acknowledged.status === "acknowledged" &&
        acknowledgedRead.status === "acknowledged" &&
        acknowledgedRead.acknowledged_at === acknowledged.acknowledged_at &&
        hasTimestamp(acknowledgedRead, "acknowledged_at") &&
        !hasOwn(acknowledgedRead, "started_at") &&
        !hasOwn(acknowledgedRead, "finished_at"),
    });

    const deliveryAfterAcknowledgement = await client.runtime.tasks(assetID, {
      runtimeId: runtimeA,
      signal,
    });
    record({
      check:
        "Acknowledging a queued Task releases the next pending Task to the Asset application",
      expected: { task_ids: [secondTask.task_id], statuses: ["pending"] },
      actual: deliveryState(deliveryAfterAcknowledgement),
      passed: deliveryMatches(deliveryAfterAcknowledgement, secondTask.task_id),
    });

    const started = await client.tasks.start(firstTask.task_id, {
      runtimeId: runtimeA,
      signal,
    });
    const startedRead = await freshTask(client, firstTask.task_id, signal);
    record({
      check:
        "Started queued Task has durable acknowledgement and start timestamps",
      expected: {
        status: "in_progress",
        acknowledged_at: "RFC3339 timestamp",
        started_at: "RFC3339 timestamp",
      },
      actual: taskState(startedRead),
      passed:
        started.status === "in_progress" &&
        startedRead.status === "in_progress" &&
        startedRead.acknowledged_at === acknowledgedRead.acknowledged_at &&
        startedRead.started_at === started.started_at &&
        hasTimestamp(startedRead, "acknowledged_at") &&
        hasTimestamp(startedRead, "started_at") &&
        !hasOwn(startedRead, "finished_at"),
    });

    const completed = await client.tasks.complete(firstTask.task_id, {
      runtimeId: runtimeA,
      output: completedOutput,
      signal,
    });
    const completedRead = await freshTask(client, firstTask.task_id, signal);
    record({
      check:
        "Completed queued Task stores its protocol output and terminal timestamp",
      expected: {
        status: "completed",
        output: completedOutput,
        finished_at: "RFC3339 timestamp",
      },
      actual: taskState(completedRead),
      passed:
        completed.status === "completed" &&
        completedRead.status === "completed" &&
        isDeepStrictEqual(completedRead.output, completedOutput) &&
        completedRead.finished_at === completed.finished_at &&
        hasTimestamp(completedRead, "finished_at"),
    });

    const cancelledTask = await createQueuedTask(
      client,
      assetID,
      "cancel",
      signal,
    );
    const cancellation = { code: "requested", message: "operator cancelled" };
    const cancelled = await client.tasks.cancel(cancelledTask.task_id, {
      cancellation,
      signal,
    });
    const cancelledRead = await freshTask(
      client,
      cancelledTask.task_id,
      signal,
    );
    record({
      check:
        "Tasking client cancellation is durable and carries its Protocol reason",
      expected: {
        status: "cancelled",
        cancellation,
        finished_at: "RFC3339 timestamp",
      },
      actual: taskState(cancelledRead),
      passed:
        cancelled.status === "cancelled" &&
        cancelledRead.status === "cancelled" &&
        isDeepStrictEqual(cancelledRead.cancellation, cancellation) &&
        cancelledRead.finished_at === cancelled.finished_at &&
        hasTimestamp(cancelledRead, "finished_at"),
    });

    const beforeInvalidStart = await freshTask(
      client,
      secondTask.task_id,
      signal,
    );
    const invalidStart = await captureAPIError(() =>
      client.tasks.start(secondTask.task_id, { runtimeId: runtimeA, signal }),
    );
    record({
      check: "Queued Task rejects start before acknowledgement",
      expected: {
        status: 400,
        error_code: "VALIDATION_ERROR",
        response_message: "cannot start Task in pending state",
      },
      actual: invalidStart,
      passed:
        invalidStart.status === 400 &&
        invalidStart.error_code === "VALIDATION_ERROR" &&
        invalidStart.response?.message === "cannot start Task in pending state",
    });
    const afterInvalidStart = await freshTask(
      client,
      secondTask.task_id,
      signal,
    );
    record({
      check: "Rejected queued Task start leaves authoritative state unchanged",
      expected: taskState(beforeInvalidStart),
      actual: taskState(afterInvalidStart),
      passed: isDeepStrictEqual(
        taskState(afterInvalidStart),
        taskState(beforeInvalidStart),
      ),
    });

    await client.runtime.begin(assetID, { runtime_id: runtimeB }, { signal });
    const drainedRead = await freshTask(client, secondTask.task_id, signal);
    record({
      check: "Runtime replacement retains and fails the old pending Task",
      expected: {
        status: "failed",
        failure_code: "asset_restarted",
        finished_at: "RFC3339 timestamp",
      },
      actual: taskState(drainedRead),
      passed:
        drainedRead.status === "failed" &&
        drainedRead.failure?.code === "asset_restarted" &&
        typeof drainedRead.failure?.message === "string" &&
        drainedRead.failure.message.length > 0 &&
        hasTimestamp(drainedRead, "finished_at"),
    });
    await client.runtime.ready(
      assetID,
      { runtime_id: runtimeB, manifest: fixtureManifest },
      { signal },
    );

    const staleRuntimeTask = await createQueuedTask(
      client,
      assetID,
      "stale-runtime",
      signal,
    );
    const beforeStaleRuntime = await freshTask(
      client,
      staleRuntimeTask.task_id,
      signal,
    );
    const staleRuntime = await captureAPIError(() =>
      client.tasks.acknowledge(staleRuntimeTask.task_id, {
        runtimeId: runtimeA,
        signal,
      }),
    );
    record({
      check:
        "Former runtime cannot acknowledge a Task owned by the current runtime",
      expected: {
        status: 400,
        error_code: "VALIDATION_ERROR",
        response_message:
          "Atlas-Runtime-ID does not identify the current runtime",
      },
      actual: staleRuntime,
      passed:
        staleRuntime.status === 400 &&
        staleRuntime.error_code === "VALIDATION_ERROR" &&
        staleRuntime.response?.message ===
          "Atlas-Runtime-ID does not identify the current runtime",
    });
    const afterStaleRuntime = await freshTask(
      client,
      staleRuntimeTask.task_id,
      signal,
    );
    record({
      check:
        "Rejected stale runtime acknowledgement leaves authoritative Task state unchanged",
      expected: taskState(beforeStaleRuntime),
      actual: taskState(afterStaleRuntime),
      passed: isDeepStrictEqual(
        taskState(afterStaleRuntime),
        taskState(beforeStaleRuntime),
      ),
    });

    const currentAcknowledged = await client.tasks.acknowledge(
      staleRuntimeTask.task_id,
      { runtimeId: runtimeB, signal },
    );
    const currentAcknowledgedRead = await freshTask(
      client,
      staleRuntimeTask.task_id,
      signal,
    );
    record({
      check:
        "Current runtime can acknowledge the Task that rejected the stale runtime",
      expected: { status: "acknowledged", task_id: staleRuntimeTask.task_id },
      actual: taskState(currentAcknowledgedRead),
      passed:
        currentAcknowledged.status === "acknowledged" &&
        currentAcknowledgedRead.status === "acknowledged" &&
        currentAcknowledgedRead.task_id === staleRuntimeTask.task_id &&
        hasTimestamp(currentAcknowledgedRead, "acknowledged_at"),
    });
  },
});

async function prepareTaskFixture({ artifacts }) {
  const fixtureDirectory = mkdtempSync(
    join(tmpdir(), "atlas-acceptance-task-fixture-"),
  );
  try {
    chmodSync(fixtureDirectory, 0o755);
    const replacementPath = join(fixtureDirectory, "command_catalog.go");
    const overlayPath = join(fixtureDirectory, "overlay.json");
    const replacementTarget =
      "/packages/protocol/generated/go/atlasprotocol/command_catalog.go";
    const replacementSource = "/acceptance-task-fixture/command_catalog.go";
    writeFileSync(
      replacementPath,
      "// Code generated for the Atlas Task acceptance fixture. DO NOT EDIT.\n\n" +
        "package atlasprotocol\n\n" +
        "// CommandCatalogJSON is the tasking conformance catalog embedded only in this acceptance Core variant.\n" +
        `const CommandCatalogJSON = ${JSON.stringify(fixtureCatalogText)}\n`,
      { mode: 0o644 },
    );
    writeFileSync(
      overlayPath,
      `${JSON.stringify({ Replace: { [replacementTarget]: replacementSource } }, null, 2)}\n`,
      {
        mode: 0o644,
      },
    );
    chmodSync(replacementPath, 0o644);
    chmodSync(overlayPath, 0o644);

    const fixtureEvidence = {
      variant: "tasking-conformance-catalog-overlay",
      catalog: {
        source: "packages/protocol/conformance/tasking/fixtures/catalog.json",
        sha256: sha256(fixtureCatalogText),
        commands: fixtureCatalog.map(({ command }) => command),
      },
      manifest: {
        source: "packages/protocol/conformance/tasking/fixtures/manifest.json",
        sha256: sha256(readFileSync(fixtureManifestPath)),
        commands: fixtureManifest.map(({ command }) => command),
      },
      overlay: { target: replacementTarget, source: replacementSource },
      cleanup: "temporary fixture directory removed after the acceptance run",
    };
    writeFileSync(
      join(artifacts, "task-fixture.json"),
      `${JSON.stringify(fixtureEvidence, null, 2)}\n`,
    );
    return {
      environment: { ATLAS_ACCEPTANCE_TASK_FIXTURE_DIR: fixtureDirectory },
      metadata: fixtureEvidence,
      cleanup: () => rmSync(fixtureDirectory, { force: true, recursive: true }),
    };
  } catch (error) {
    rmSync(fixtureDirectory, { force: true, recursive: true });
    throw error;
  }
}

async function createQueuedTask(client, assetID, value, signal) {
  return client.tasks.create(
    { asset_id: assetID, command: queuedCommand, input: { value } },
    { idempotencyKey: `acpt-attempt-${randomUUID()}`, signal },
  );
}

function freshTask(client, taskID, signal) {
  return client.tasks.get(taskID, { fresh: true, signal });
}

async function captureAPIError(operation) {
  try {
    await operation();
    return { status: 200 };
  } catch (error) {
    if (isAtlasAPIError(error)) {
      return {
        status: error.status,
        error_code: error.errorCode,
        message: error.message,
        response: error.response,
      };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function deliveryMatches(delivery, taskID) {
  return (
    delivery.tasks.length === 1 &&
    delivery.tasks[0].task_id === taskID &&
    delivery.tasks[0].status === "pending"
  );
}

function deliveryState(delivery) {
  return {
    task_ids: delivery.tasks.map((task) => task.task_id),
    statuses: delivery.tasks.map((task) => task.status),
  };
}

function matchesPendingTask(task, assetID, value) {
  return (
    task.asset_id === assetID &&
    task.command === queuedCommand &&
    task.status === "pending" &&
    isDeepStrictEqual(task.input, { value }) &&
    !hasOwn(task, "acknowledged_at") &&
    !hasOwn(task, "started_at") &&
    !hasOwn(task, "finished_at")
  );
}

function taskState(task) {
  return {
    task_id: task.task_id,
    asset_id: task.asset_id,
    command: task.command,
    input: task.input,
    status: task.status,
    created_at: task.created_at,
    updated_at: task.updated_at,
    ...(hasOwn(task, "acknowledged_at")
      ? { acknowledged_at: task.acknowledged_at }
      : {}),
    ...(hasOwn(task, "started_at") ? { started_at: task.started_at } : {}),
    ...(hasOwn(task, "finished_at") ? { finished_at: task.finished_at } : {}),
    ...(hasOwn(task, "output") ? { output: task.output } : {}),
    ...(hasOwn(task, "failure") ? { failure: task.failure } : {}),
    ...(hasOwn(task, "cancellation")
      ? { cancellation: task.cancellation }
      : {}),
  };
}

function hasTimestamp(value, key) {
  return (
    hasOwn(value, key) &&
    typeof value[key] === "string" &&
    Number.isFinite(Date.parse(value[key]))
  );
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
