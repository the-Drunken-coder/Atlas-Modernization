import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AtlasAPIError, AtlasClient, ConflictError } from "@the-drunken-coder/atlas-sdk";
import { runAcceptance } from "./support/stack.mjs";

const reproduction = "npm run build:sdk && node tests/acceptance/sdk-auth-conflicts.mjs";
const entityID = randomUUID();
const initialAlias = "auth-initial";
const newerAlias = "auth-newer";
const staleAlias = "auth-stale";

assertFixtureContracts();

await runAcceptance({
  name: "sdk-auth-conflicts",
  reproduction,
  run: async ({ baseUrl, apiKey, record, signal }) => {
    const writer = createClient(baseUrl, apiKey);
    const newerClient = createClient(baseUrl, apiKey);
    const staleClient = createClient(baseUrl, apiKey);
    const verifier = createClient(baseUrl, apiKey);

    try {
      const created = await writer.entities.create(
        { entity_id: entityID, entity_type: "asset", alias: initialAlias },
        { signal }
      );
      record({
        check: "legitimate API-key client creates the protected Entity",
        expected: { entity_id: entityID, alias: initialAlias, version: "positive initial version" },
        actual: summarizeEntity(created),
        passed:
          created.entity_id === entityID &&
          created.alias === initialAlias &&
          created.metadata.version > 0
      });

      const missingCredential = await readEntityWithSDK(createClient(baseUrl), entityID, signal);
      recordUnauthorized(record, "missing credentials", missingCredential);

      const invalidCredential = await readEntityWithSDK(createClient(baseUrl, "atlas-invalid-test-key"), entityID, signal);
      recordUnauthorized(record, "invalid credentials", invalidCredential);

      const legitimateRead = await readEntityWithSDK(writer, entityID, signal);
      record({
        check: "legitimate API-key request reads the intended protected Entity",
        expected: { status: 200, entity_id: entityID, alias: initialAlias, version: created.metadata.version },
        actual: legitimateRead.error ?? { status: legitimateRead.status, response: legitimateRead.observation },
        passed:
          legitimateRead.status === 200 &&
          legitimateRead.entity.entity_id === entityID &&
          legitimateRead.entity.alias === initialAlias &&
          legitimateRead.entity.metadata.version === created.metadata.version
      });

      const staleSnapshot = await staleClient.entities.get(entityID, { fresh: true, signal });
      const newerSnapshot = await newerClient.entities.get(entityID, { fresh: true, signal });
      record({
        check: "two real SDK clients read the same base Entity version",
        expected: { entity_id: entityID, alias: initialAlias, matching_version: created.metadata.version },
        actual: {
          stale: summarizeEntity(staleSnapshot),
          newer: summarizeEntity(newerSnapshot)
        },
        passed:
          staleSnapshot.entity_id === entityID &&
          newerSnapshot.entity_id === entityID &&
          staleSnapshot.alias === initialAlias &&
          newerSnapshot.alias === initialAlias &&
          staleSnapshot.metadata.version === created.metadata.version &&
          newerSnapshot.metadata.version === created.metadata.version
      });

      const newerUpdate = await newerClient.entities.update(
        entityID,
        { alias: newerAlias },
        { ifMatchVersion: newerSnapshot.metadata.version }
      );
      record({
        check: "newer SDK write updates the Entity with its matching version",
        expected: {
          entity_id: entityID,
          alias: newerAlias,
          version: `greater than ${newerSnapshot.metadata.version}`
        },
        actual: summarizeEntity(newerUpdate),
        passed:
          newerUpdate.entity_id === entityID &&
          newerUpdate.alias === newerAlias &&
          newerUpdate.metadata.version > newerSnapshot.metadata.version
      });

      let staleWrite;
      try {
        const overwritten = await staleClient.entities.update(
          entityID,
          { alias: staleAlias },
          { ifMatchVersion: staleSnapshot.metadata.version }
        );
        staleWrite = { status: 200, response: summarizeEntity(overwritten) };
      } catch (error) {
        staleWrite = summarizeConflict(error);
      }
      const finalRead = await readEntityOutcome(verifier, entityID, signal);
      record({
        check: "stale SDK write is rejected by the current Entity version",
        expected: { status: 412, error_code: "PRECONDITION_FAILED" },
        actual: { stale_write: staleWrite, independent_read: finalRead.observation },
        passed:
          staleWrite.status === 412 &&
          staleWrite.error_code === "PRECONDITION_FAILED"
      });

      record({
        check: "independent SDK read confirms the newer Entity state was preserved",
        expected: { entity_id: entityID, alias: newerAlias, version: newerUpdate.metadata.version },
        actual: finalRead.observation,
        passed:
          finalRead.ok &&
          finalRead.entity.entity_id === entityID &&
          finalRead.entity.alias === newerAlias &&
          finalRead.entity.metadata.version === newerUpdate.metadata.version
      });
    } finally {
      writer.sync.stop();
      newerClient.sync.stop();
      staleClient.sync.stop();
      verifier.sync.stop();
    }
  }
});

function createClient(baseUrl, apiKey) {
  return new AtlasClient({
    baseUrl,
    apiKey,
    sync: false,
    pollIntervalMs: 0,
    requestTimeoutMs: 10_000
  });
}

async function readEntityWithSDK(client, id, signal) {
  try {
    const entity = await client.entities.get(id, { fresh: true, signal });
    return { status: 200, entity, observation: summarizeEntity(entity) };
  } catch (error) {
    return { status: undefined, error: summarizeSDKError(error) };
  }
}

function recordUnauthorized(record, credentialCase, response) {
  const expectedBody = { success: false, message: "Unauthorized", error_code: "UNAUTHORIZED" };
  record({
    check: `${credentialCase} cannot read a protected Entity and receives no protected data`,
    expected: { error_type: "AtlasAPIError", status: 401, error_code: "UNAUTHORIZED", response: expectedBody },
    actual: response.error ?? { status: response.status, response: response.observation },
    passed:
      response.error?.error_type === "AtlasAPIError" &&
      response.error.status === 401 &&
      response.error.error_code === "UNAUTHORIZED" &&
      isDeepStrictEqual(response.error.response, expectedBody) &&
      !includesProtectedData(response.error.response)
  });
}

function summarizeConflict(error) {
  if (!(error instanceof ConflictError)) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  return {
    status: error.status,
    error_code: error.errorCode,
    message: error.message,
    response: error.response
  };
}

function summarizeEntity(entity) {
  return { entity_id: entity.entity_id, alias: entity.alias, version: entity.metadata.version };
}

function summarizeSDKError(error) {
  if (!(error instanceof AtlasAPIError)) {
    return {
      error_type: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error)
    };
  }
  return {
    error_type: error.name,
    status: error.status,
    error_code: error.errorCode,
    response: error.response,
    message: error.message
  };
}

async function readEntityOutcome(client, id, signal) {
  try {
    const entity = await client.entities.get(id, { fresh: true, signal });
    return { ok: true, entity, observation: summarizeEntity(entity) };
  } catch (error) {
    return { ok: false, observation: summarizeSDKError(error) };
  }
}

function includesProtectedData(value) {
  const serialized = JSON.stringify(value) ?? "";
  return [entityID, initialAlias, newerAlias, staleAlias].some((protectedValue) => serialized.includes(protectedValue));
}

function assertFixtureContracts() {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/.test(entityID) || entityID.length > 50) {
    throw new Error(`fixture Entity ID must be a valid resource ID of at most 50 characters: ${entityID}`);
  }
  for (const alias of [initialAlias, newerAlias, staleAlias]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/.test(alias) || alias.length > 255) {
      throw new Error(`fixture alias must match the current Core alias contract: ${alias}`);
    }
  }
}
