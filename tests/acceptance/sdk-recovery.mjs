import { randomUUID } from "node:crypto";
import { AtlasClient, isAtlasAPIError } from "@the-drunken-coder/atlas-sdk";
import { runAcceptance } from "./support/stack.mjs";

const disconnectTimeoutMs = 10_000;
const reconnectAttemptTimeoutMs = 5_000;
const convergenceTimeoutMs = 10_000;
const recoveryCycles = parseRecoveryCycles(
  process.env.ATLAS_ACCEPTANCE_RECOVERY_CYCLES,
);
const reproduction =
  recoveryCycles === 1
    ? "npm run build:sdk && node tests/acceptance/sdk-recovery.mjs"
    : `npm run build:sdk && ATLAS_ACCEPTANCE_RECOVERY_CYCLES=${recoveryCycles} node tests/acceptance/sdk-recovery.mjs`;

await runAcceptance({
  name: "sdk-recovery",
  reproduction,
  run: async ({ baseUrl, apiKey, record, restartCore, runID, signal }) => {
    const NativeWebSocket = globalThis.WebSocket;
    if (typeof NativeWebSocket !== "function") {
      record({
        check:
          "Node provides the WebSocket interface required by the Atlas SDK",
        classification: "required_dependency_unavailable",
        expected: "globalThis.WebSocket constructor",
        actual: typeof NativeWebSocket,
        passed: false,
      });
    }

    const gate = createReconnectGate(NativeWebSocket);
    const writer = client(baseUrl, apiKey);
    const verifier = client(baseUrl, apiKey);
    const receiver = new AtlasClient({
      baseUrl,
      apiKey,
      sync: "all",
      pollIntervalMs: 0,
      requestTimeoutMs: 10_000,
      feedHandshakeTimeoutMs: 5_000,
      WebSocket: gate.WebSocket,
    });
    const scenarioStartedAt = Date.now();
    const timeline = (phase, actual, cycle) =>
      record({
        check: `recovery timeline: ${phase}`,
        phase,
        ...(cycle === undefined ? {} : { cycle }),
        elapsed_ms: Date.now() - scenarioStartedAt,
        actual,
        passed: true,
      });

    record({
      check: "recovery scenario parameters",
      expected: {
        recovery_cycles: recoveryCycles,
        disconnect_timeout_ms: disconnectTimeoutMs,
        reconnect_attempt_timeout_ms: reconnectAttemptTimeoutMs,
        convergence_timeout_ms: convergenceTimeoutMs,
      },
      actual: {
        recovery_cycles: recoveryCycles,
        disconnect_timeout_ms: disconnectTimeoutMs,
        reconnect_attempt_timeout_ms: reconnectAttemptTimeoutMs,
        convergence_timeout_ms: convergenceTimeoutMs,
        run_id: runID,
      },
      passed: true,
    });

    try {
      await receiver.sync.start();
      signal.throwIfAborted();
      const initialStatus = summarizeStatus(receiver.sync.status());
      record({
        check:
          "receiving SDK established a healthy native feed before fault injection",
        expected: {
          running: true,
          healthy: true,
          degraded: false,
          native_connections: 1,
        },
        actual: {
          ...initialStatus,
          native_connections: gate.nativeConnections,
        },
        passed:
          initialStatus.running &&
          initialStatus.healthy &&
          !initialStatus.degraded &&
          gate.nativeConnections === 1,
      });
      timeline("baseline feed connected", {
        ...initialStatus,
        native_connections: gate.nativeConnections,
      });

      for (let cycle = 1; cycle <= recoveryCycles; cycle++) {
        await runRecoveryCycle({
          cycle,
          gate,
          receiver,
          record,
          restartCore,
          signal,
          timeline,
          verifier,
          writer,
        });
      }
    } finally {
      gate.release();
      writer.sync.stop();
      verifier.sync.stop();
      receiver.sync.stop();
    }
  },
});

async function runRecoveryCycle({
  cycle,
  gate,
  receiver,
  record,
  restartCore,
  signal,
  timeline,
  verifier,
  writer,
}) {
  const retainedEntityID = `retained-${cycle}-${randomUUID()}`;
  const deletedEntityID = `deleted-${cycle}-${randomUUID()}`;
  const retainedBaselineAlias = `recovery-retained-${cycle}-baseline`;
  const retainedUpdatedAlias = `recovery-retained-${cycle}-updated`;
  const deletedBaselineAlias = `recovery-deleted-${cycle}-baseline`;
  const observations = [];
  const stopWatchingRetained = receiver.entities.watch(
    retainedEntityID,
    (entity, event) => observations.push({ entity, event }),
  );
  const stopWatchingDeleted = receiver.entities.watch(
    deletedEntityID,
    (entity, event) => observations.push({ entity, event }),
  );
  let restartResult;
  let gateReleased = false;

  try {
    const retainedCreated = await writer.entities.create(
      {
        entity_id: retainedEntityID,
        entity_type: "asset",
        alias: retainedBaselineAlias,
      },
      { signal },
    );
    const deletedCreated = await writer.entities.create(
      {
        entity_id: deletedEntityID,
        entity_type: "asset",
        alias: deletedBaselineAlias,
      },
      { signal },
    );
    const baselineVersion = Math.max(
      retainedCreated.metadata.version,
      deletedCreated.metadata.version,
    );
    const baseline = await observeWithin({
      check: "receiving SDK observed both baseline Entity creates",
      classification: "baseline_not_observed",
      expected: {
        retained: {
          event: "create",
          id: retainedEntityID,
          alias: retainedBaselineAlias,
          version: retainedCreated.metadata.version,
        },
        deleted: {
          event: "create",
          id: deletedEntityID,
          alias: deletedBaselineAlias,
          version: deletedCreated.metadata.version,
        },
        last_version: baselineVersion,
      },
      observe: () =>
        baselineObservation(
          receiver,
          observations,
          retainedCreated,
          deletedCreated,
        ),
      ready: (actual) =>
        actual.retained?.alias === retainedBaselineAlias &&
        actual.retained?.version === retainedCreated.metadata.version &&
        actual.deleted?.alias === deletedBaselineAlias &&
        actual.deleted?.version === deletedCreated.metadata.version &&
        actual.status.healthy &&
        actual.status.last_version >= baselineVersion,
      record,
      signal,
      timeoutMs: convergenceTimeoutMs,
    });
    const baselineCursor = baseline.status.last_version;
    record({
      check: "receiving SDK reached a valid pre-interruption baseline",
      cycle,
      expected: {
        retained_alias: retainedBaselineAlias,
        deleted_alias: deletedBaselineAlias,
        last_version: baselineVersion,
      },
      actual: {
        retained_alias: baseline.snapshot.retained_alias,
        deleted_alias: baseline.snapshot.deleted_alias,
        last_version: baselineCursor,
      },
      passed:
        baseline.snapshot.retained_alias === retainedBaselineAlias &&
        baseline.snapshot.deleted_alias === deletedBaselineAlias &&
        baselineCursor === baselineVersion,
    });
    timeline(
      "valid baseline established",
      { baseline_cursor: baselineCursor },
      cycle,
    );

    const blockedAttemptsBeforeRestart = gate.blockedAttempts;
    gate.block();
    timeline(
      "new receiver connections blocked",
      { blocked_attempts: blockedAttemptsBeforeRestart },
      cycle,
    );
    restartResult = restartCore().then(
      () => ({ passed: true }),
      (error) => ({ passed: false, error: summarizeError(error) }),
    );

    const disconnectedStatus = await observeWithin({
      check: "receiving SDK detected the Core restart as a feed disconnection",
      classification: "disconnect_not_observed",
      expected: { running: true, healthy: false, degraded: true },
      observe: () => summarizeStatus(receiver.sync.status()),
      ready: (actual) => actual.running && !actual.healthy && actual.degraded,
      record,
      signal,
      timeoutMs: disconnectTimeoutMs,
    });
    timeline("receiver disconnected", disconnectedStatus, cycle);

    const completedRestart = await restartResult;
    record({
      check: "Core restart completed before recovery writes",
      cycle,
      classification: completedRestart.passed
        ? undefined
        : "core_restart_failed",
      expected: { passed: true },
      actual: completedRestart,
      passed: completedRestart.passed,
    });
    timeline("Core ready with retained storage", completedRestart, cycle);

    const blockedAttempts = await observeWithin({
      check:
        "automatic receiver reconnect attempted while its connection gate was closed",
      classification: "reconnect_not_attempted",
      expected: { blocked_attempts_greater_than: blockedAttemptsBeforeRestart },
      observe: () => ({ blocked_attempts: gate.blockedAttempts }),
      ready: (actual) => actual.blocked_attempts > blockedAttemptsBeforeRestart,
      record,
      signal,
      timeoutMs: reconnectAttemptTimeoutMs,
    });
    timeline("automatic reconnect attempt blocked", blockedAttempts, cycle);

    const retainedAfterRestart = await verifier.entities.get(retainedEntityID, {
      fresh: true,
      signal,
    });
    const deletedAfterRestart = await verifier.entities.get(deletedEntityID, {
      fresh: true,
      signal,
    });
    record({
      check:
        "independent SDK reads proved both baseline Entities survived Core restart",
      cycle,
      classification: "durability_mismatch",
      expected: {
        retained: summarizeEntity(retainedCreated),
        deleted: summarizeEntity(deletedCreated),
      },
      actual: {
        retained: summarizeEntity(retainedAfterRestart),
        deleted: summarizeEntity(deletedAfterRestart),
      },
      passed:
        sameEntity(retainedAfterRestart, retainedCreated) &&
        sameEntity(deletedAfterRestart, deletedCreated),
    });

    const retainedUpdated = await writer.entities.update(
      retainedEntityID,
      { alias: retainedUpdatedAlias },
      { ifMatchVersion: retainedCreated.metadata.version },
    );
    const externallyUpdated = await verifier.entities.get(retainedEntityID, {
      fresh: true,
      signal,
    });
    record({
      check:
        "independent SDK read proved the retained Entity update committed while the receiver was disconnected",
      cycle,
      classification: "durability_mismatch",
      expected: summarizeEntity(retainedUpdated),
      actual: summarizeEntity(externallyUpdated),
      passed:
        sameEntity(externallyUpdated, retainedUpdated) &&
        externallyUpdated.alias === retainedUpdatedAlias,
    });

    await writer.entities.delete(deletedEntityID);
    const externallyDeleted = await deletedRead(
      verifier,
      deletedEntityID,
      signal,
    );
    record({
      check:
        "independent SDK read proved the second Entity deletion committed while the receiver was disconnected",
      cycle,
      classification: "durability_mismatch",
      expected: { status: 404 },
      actual: externallyDeleted,
      passed: externallyDeleted.status === 404,
    });

    const durableChanges = await changedSinceAll(
      verifier,
      baselineCursor,
      signal,
    );
    const retainedUpdateIndex = durableChanges.events.findIndex(
      (event) =>
        event.event === "update" &&
        event.resource_type === "entity" &&
        event.id === retainedEntityID &&
        event.resource?.alias === retainedUpdatedAlias &&
        event.version === retainedUpdated.metadata.version,
    );
    const deletedEventIndex = durableChanges.events.findIndex(
      (event) =>
        event.event === "delete" &&
        event.resource_type === "entity" &&
        event.id === deletedEntityID,
    );
    const durableUpdate = durableChanges.events[retainedUpdateIndex];
    const durableDelete = durableChanges.events[deletedEventIndex];
    record({
      check:
        "changed-since exposed the real offline update and deletion in commit order",
      cycle,
      classification: "changed_since_mismatch",
      expected: {
        events: [
          {
            event: "update",
            id: retainedEntityID,
            alias: retainedUpdatedAlias,
            version: retainedUpdated.metadata.version,
          },
          {
            event: "delete",
            id: deletedEntityID,
            version_greater_than: retainedUpdated.metadata.version,
          },
        ],
      },
      actual: {
        events: durableChanges.events.map(summarizeFeedEvent),
        pages: durableChanges.pages,
        version: durableChanges.version,
      },
      passed:
        retainedUpdateIndex >= 0 &&
        deletedEventIndex > retainedUpdateIndex &&
        durableDelete?.version > retainedUpdated.metadata.version,
    });
    const deleteVersion = durableDelete.version;
    timeline(
      "offline writes committed",
      {
        update_version: durableUpdate.version,
        delete_version: deleteVersion,
        changed_since_pages: durableChanges.pages,
      },
      cycle,
    );

    const disconnectedSnapshot = receiver.sync.snapshot();
    const statusBeforeRelease = summarizeStatus(receiver.sync.status());
    record({
      check:
        "receiver remained at its baseline cursor and state before reconnection",
      cycle,
      classification: "disconnect_boundary_mismatch",
      expected: {
        status: {
          running: true,
          healthy: false,
          degraded: true,
          last_version: baselineCursor,
        },
        retained_alias: retainedBaselineAlias,
        deleted_alias: deletedBaselineAlias,
      },
      actual: {
        status: statusBeforeRelease,
        retained_alias: disconnectedSnapshot.entities[retainedEntityID]?.alias,
        deleted_alias: disconnectedSnapshot.entities[deletedEntityID]?.alias,
      },
      passed:
        statusBeforeRelease.running &&
        !statusBeforeRelease.healthy &&
        statusBeforeRelease.degraded &&
        statusBeforeRelease.last_version === baselineCursor &&
        disconnectedSnapshot.entities[retainedEntityID]?.alias ===
          retainedBaselineAlias &&
        disconnectedSnapshot.entities[deletedEntityID]?.alias ===
          deletedBaselineAlias,
    });

    gate.release();
    gateReleased = true;
    timeline(
      "receiver connection gate released",
      { blocked_attempts: gate.blockedAttempts },
      cycle,
    );

    const converged = await observeWithin({
      check:
        "receiving SDK automatically recovered the retained update and separate deletion",
      classification: "recovery_timeout",
      expected: {
        status: {
          running: true,
          healthy: true,
          degraded: false,
          last_version_at_least: deleteVersion,
        },
        retained: summarizeEntity(retainedUpdated),
        deleted: "absent",
        recovered_events: [
          {
            event: "update",
            id: retainedEntityID,
            version: retainedUpdated.metadata.version,
          },
          { event: "delete", id: deletedEntityID, version: deleteVersion },
        ],
      },
      observe: () =>
        recoveryObservation(
          receiver,
          observations,
          retainedUpdated,
          deleteVersion,
          deletedEntityID,
        ),
      ready: (actual) =>
        actual.status.running &&
        actual.status.healthy &&
        !actual.status.degraded &&
        actual.status.last_version >= deleteVersion &&
        actual.snapshot.retained?.alias === retainedUpdatedAlias &&
        actual.snapshot.retained?.version ===
          retainedUpdated.metadata.version &&
        actual.snapshot.deleted === "absent" &&
        actual.update_event?.version === retainedUpdated.metadata.version &&
        actual.delete_event?.version === deleteVersion,
      record,
      signal,
      timeoutMs: convergenceTimeoutMs,
    });
    timeline("receiver converged", converged, cycle);

    const receiverRead = await receiver.entities.get(retainedEntityID);
    const finalRetainedRead = await verifier.entities.get(retainedEntityID, {
      fresh: true,
      signal,
    });
    const finalDeletedRead = await deletedRead(
      verifier,
      deletedEntityID,
      signal,
    );
    record({
      check:
        "receiver and independent SDK expose the final updated and deleted Entity states",
      cycle,
      classification: "convergence_mismatch",
      expected: {
        receiver_retained: summarizeEntity(retainedUpdated),
        external_retained: summarizeEntity(retainedUpdated),
        external_deleted: { status: 404 },
      },
      actual: {
        receiver_retained: summarizeEntity(receiverRead),
        external_retained: summarizeEntity(finalRetainedRead),
        external_deleted: finalDeletedRead,
      },
      passed:
        sameEntity(receiverRead, retainedUpdated) &&
        sameEntity(finalRetainedRead, retainedUpdated) &&
        finalDeletedRead.status === 404,
    });
  } finally {
    if (restartResult) await restartResult;
    if (!gateReleased) gate.release();
    stopWatchingRetained();
    stopWatchingDeleted();
  }
}

function client(baseUrl, apiKey) {
  return new AtlasClient({
    baseUrl,
    apiKey,
    sync: false,
    pollIntervalMs: 0,
    requestTimeoutMs: 10_000,
  });
}

function createReconnectGate(NativeWebSocket) {
  let blocked = false;
  let blockedAttempts = 0;
  let nativeConnections = 0;

  class AcceptanceWebSocket {
    constructor(url) {
      if (!blocked) {
        nativeConnections++;
        return new NativeWebSocket(url);
      }
      blockedAttempts++;
      return new RejectedWebSocket();
    }
  }

  return {
    WebSocket: AcceptanceWebSocket,
    block: () => {
      blocked = true;
    },
    release: () => {
      blocked = false;
    },
    get blockedAttempts() {
      return blockedAttempts;
    },
    get nativeConnections() {
      return nativeConnections;
    },
  };
}

class RejectedWebSocket {
  readyState = 0;
  #listeners = new Map();

  constructor() {
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.#emit("error");
      this.#emit("close");
    });
  }

  send() {
    throw new Error("acceptance reconnect gate is closed");
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.#emit("close"));
  }

  addEventListener(type, listener) {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  #emit(type) {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener({});
  }
}

async function observeWithin({
  check,
  classification,
  expected,
  observe,
  ready,
  record,
  signal,
  timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  let actual = observe();
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (ready(actual)) return actual;
    await abortableDelay(25, signal);
    actual = observe();
  }
  record({
    check,
    classification,
    expected,
    actual,
    timeout_ms: timeoutMs,
    passed: false,
  });
}

async function changedSinceAll(clientInstance, sinceVersion, signal) {
  const events = [];
  let cursor;
  let version = sinceVersion;
  for (let pages = 1; pages <= 10; pages++) {
    signal.throwIfAborted();
    const response = await clientInstance.queries.changedSince(sinceVersion, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    events.push(...response.events);
    version = response.version;
    if (!response.has_more) return { events, pages, version };
    cursor = response.next_cursor;
  }
  throw new Error("changed-since recovery evidence exceeded 10 pages");
}

function baselineObservation(
  receiver,
  observations,
  retainedCreated,
  deletedCreated,
) {
  const snapshot = receiver.sync.snapshot();
  return {
    status: summarizeStatus(receiver.sync.status()),
    snapshot: {
      retained_alias: snapshot.entities[retainedCreated.entity_id]?.alias,
      deleted_alias: snapshot.entities[deletedCreated.entity_id]?.alias,
    },
    retained: summarizeObservedEvent(
      observations.find(
        ({ event }) =>
          event.event === "create" &&
          event.resource_type === "entity" &&
          event.id === retainedCreated.entity_id &&
          event.version === retainedCreated.metadata.version,
      ),
    ),
    deleted: summarizeObservedEvent(
      observations.find(
        ({ event }) =>
          event.event === "create" &&
          event.resource_type === "entity" &&
          event.id === deletedCreated.entity_id &&
          event.version === deletedCreated.metadata.version,
      ),
    ),
  };
}

function recoveryObservation(
  receiver,
  observations,
  retainedUpdated,
  deleteVersion,
  deletedEntityID,
) {
  const snapshot = receiver.sync.snapshot();
  return {
    status: summarizeStatus(receiver.sync.status()),
    snapshot: {
      retained: snapshot.entities[retainedUpdated.entity_id]
        ? summarizeEntity(snapshot.entities[retainedUpdated.entity_id])
        : undefined,
      deleted:
        snapshot.entities[deletedEntityID] === undefined ? "absent" : "present",
    },
    update_event: summarizeObservedEvent(
      observations.find(
        ({ event }) =>
          event.event === "update" &&
          event.resource_type === "entity" &&
          event.id === retainedUpdated.entity_id &&
          event.version === retainedUpdated.metadata.version,
      ),
    ),
    delete_event: summarizeObservedEvent(
      observations.find(
        ({ entity, event }) =>
          entity === undefined &&
          event.event === "delete" &&
          event.resource_type === "entity" &&
          event.id === deletedEntityID &&
          event.version === deleteVersion,
      ),
    ),
  };
}

async function deletedRead(clientInstance, entityID, signal) {
  try {
    const entity = await clientInstance.entities.get(entityID, {
      fresh: true,
      signal,
    });
    return { status: 200, entity: summarizeEntity(entity) };
  } catch (error) {
    return isAtlasAPIError(error)
      ? { status: error.status, message: error.message }
      : { status: "unknown", error: summarizeError(error) };
  }
}

function summarizeObservedEvent(observation) {
  if (!observation) return undefined;
  return {
    event: observation.event.event,
    resource_type: observation.event.resource_type,
    id: observation.event.id,
    version: observation.event.version,
    alias: observation.entity?.alias,
    entity: observation.entity === undefined ? "absent" : "present",
  };
}

function summarizeFeedEvent(event) {
  return {
    event: event.event,
    resource_type: event.resource_type,
    id: event.id,
    version: event.version,
    alias: event.resource?.alias,
  };
}

function summarizeStatus(status) {
  return {
    running: status.running,
    healthy: status.healthy,
    degraded: status.degraded,
    last_version: status.lastVersion,
    ...(status.error ? { error: status.error } : {}),
  };
}

function summarizeEntity(entity) {
  return {
    id: entity.entity_id,
    alias: entity.alias,
    version: entity.metadata.version,
  };
}

function sameEntity(actual, expected) {
  return (
    actual.entity_id === expected.entity_id &&
    actual.alias === expected.alias &&
    actual.metadata.version === expected.metadata.version
  );
}

function summarizeError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };
}

function parseRecoveryCycles(value) {
  const cycles = value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 5) {
    throw new Error(
      "ATLAS_ACCEPTANCE_RECOVERY_CYCLES must be an integer from 1 through 5",
    );
  }
  return cycles;
}

function abortableDelay(milliseconds, signal) {
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
