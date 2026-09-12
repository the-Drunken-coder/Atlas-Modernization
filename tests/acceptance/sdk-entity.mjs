import { randomUUID } from "node:crypto";
import { AtlasClient, isAtlasAPIError } from "@the-drunken-coder/atlas-sdk";
import { runAcceptance } from "./support/stack.mjs";

const reproduction = "npm run test:acceptance:sdk-entity";

await runAcceptance({
  name: "sdk-entity",
  reproduction,
  run: async ({ baseUrl, apiKey, record, signal }) => {
    const entityID = `acceptance-${randomUUID()}`;
    const createdAlias = "acceptance-created";
    const expectedUpdatedAlias = "acceptance-updated";
    const writer = new AtlasClient({ baseUrl, apiKey, sync: false, pollIntervalMs: 0, requestTimeoutMs: 10_000 });
    const receiver = new AtlasClient({
      baseUrl,
      apiKey,
      sync: "all",
      pollIntervalMs: 0,
      requestTimeoutMs: 10_000,
      feedHandshakeTimeoutMs: 5_000
    });
    const observations = [];
    const stopWatching = receiver.entities.watch(entityID, (entity, event) => observations.push({ entity, event }));

    try {
      await receiver.sync.start();
      signal.throwIfAborted();
      const syncStatus = receiver.sync.status();
      record({
        check: "receiving SDK connected to the real Core feed",
        expected: { running: true, healthy: true, degraded: false },
        actual: { running: syncStatus.running, healthy: syncStatus.healthy, degraded: syncStatus.degraded },
        passed: syncStatus.running && syncStatus.healthy && !syncStatus.degraded
      });

      const created = await writer.entities.create(
        {
          entity_id: entityID,
          entity_type: "asset",
          alias: createdAlias
        },
        { signal }
      );
      const createObservation = await observeUntil(
        () => observations.find(({ event }) => event.event === "create"),
        "receiving SDK create feed event",
        signal
      );
      record({
        check: "receiving SDK observed Entity creation through the feed",
        expected: {
          event: "create",
          resource_type: "entity",
          id: entityID,
          alias: createdAlias,
          version: created.metadata.version
        },
        actual: summarizeObservation(createObservation),
        passed:
          createObservation.event.resource_type === "entity" &&
          createObservation.event.id === entityID &&
          createObservation.entity?.alias === createdAlias &&
          createObservation.event.version === created.metadata.version
      });
      const createdRead = await receiver.entities.get(entityID, { fresh: true, signal });
      record({
        check: "receiving SDK read the created Entity through Core",
        expected: { id: entityID, alias: createdAlias, version: created.metadata.version },
        actual: summarizeEntity(createdRead),
        passed:
          createdRead.entity_id === entityID &&
          createdRead.alias === createdAlias &&
          createdRead.metadata.version === created.metadata.version
      });

      const updated = await writer.entities.update(
        entityID,
        { alias: expectedUpdatedAlias },
        { ifMatchVersion: created.metadata.version }
      );
      signal.throwIfAborted();
      const updateObservation = await observeUntil(
        () => observations.find(({ event }) => event.event === "update"),
        "receiving SDK update feed event",
        signal
      );
      record({
        check: "receiving SDK observed Entity update through the feed",
        expected: {
          event: "update",
          resource_type: "entity",
          id: entityID,
          alias: expectedUpdatedAlias,
          version: updated.metadata.version
        },
        actual: summarizeObservation(updateObservation),
        passed:
          updateObservation.event.resource_type === "entity" &&
          updateObservation.event.id === entityID &&
          updateObservation.entity?.alias === expectedUpdatedAlias &&
          updateObservation.event.version === updated.metadata.version &&
          updated.metadata.version > created.metadata.version
      });
      const updatedRead = await receiver.entities.get(entityID, { fresh: true, signal });
      record({
        check: "receiving SDK read the updated Entity through Core",
        expected: { id: entityID, alias: expectedUpdatedAlias, version: updated.metadata.version },
        actual: summarizeEntity(updatedRead),
        passed:
          updatedRead.entity_id === entityID &&
          updatedRead.alias === expectedUpdatedAlias &&
          updatedRead.metadata.version === updated.metadata.version
      });

      await writer.entities.delete(entityID);
      signal.throwIfAborted();
      const deleteObservation = await observeUntil(
        () => observations.find(({ event }) => event.event === "delete"),
        "receiving SDK delete feed event",
        signal
      );
      record({
        check: "receiving SDK observed Entity deletion through the feed",
        expected: { event: "delete", resource_type: "entity", id: entityID, entity: undefined },
        actual: summarizeObservation(deleteObservation),
        passed:
          deleteObservation.event.resource_type === "entity" &&
          deleteObservation.event.id === entityID &&
          deleteObservation.entity === undefined
      });

      let deletedRead;
      try {
        await receiver.entities.get(entityID, { fresh: true, signal });
        deletedRead = { status: 200 };
      } catch (error) {
        deletedRead = isAtlasAPIError(error) ? { status: error.status, message: error.message } : { error: String(error) };
      }
      record({
        check: "receiving SDK public read reports the deleted Entity absent",
        expected: { status: 404 },
        actual: deletedRead,
        passed: deletedRead.status === 404
      });
    } finally {
      stopWatching();
      writer.sync.stop();
      receiver.sync.stop();
    }
  }
});

async function observeUntil(observe, description, signal) {
  const deadline = Date.now() + 10_000;
  let actual;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    actual = observe();
    if (actual !== undefined) return actual;
    await abortableDelay(25, signal);
  }
  throw new Error(`${description}: expected an observable result within 10000 ms, observed ${JSON.stringify(actual)}`);
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

function summarizeObservation({ entity, event }) {
  return {
    event: event.event,
    resource_type: event.resource_type,
    id: event.id,
    alias: entity?.alias,
    version: event.version,
    entity: entity === undefined ? undefined : "present"
  };
}

function summarizeEntity(entity) {
  return { id: entity.entity_id, alias: entity.alias, version: entity.metadata.version };
}
