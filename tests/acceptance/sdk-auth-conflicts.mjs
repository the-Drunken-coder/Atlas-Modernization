import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AtlasClient, ConflictError } from "@the-drunken-coder/atlas-sdk";
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

      const missingCredential = await requestEntity(baseUrl, entityID, undefined, signal);
      recordUnauthorized(record, "missing credentials", missingCredential);

      const invalidCredential = await requestEntity(baseUrl, entityID, "atlas-invalid-test-key", signal);
      recordUnauthorized(record, "invalid credentials", invalidCredential);

      const legitimateRead = await requestEntity(baseUrl, entityID, apiKey, signal);
      record({
        check: "legitimate API-key request reads the intended protected Entity",
        expected: { status: 200, entity_id: entityID, alias: initialAlias, version: created.metadata.version },
        actual: {
          status: legitimateRead.status,
          body: summarizeEntityBody(legitimateRead.body),
          response: legitimateRead.body
        },
        passed:
          legitimateRead.status === 200 &&
          isEntityBody(legitimateRead.body) &&
          legitimateRead.body.entity_id === entityID &&
          legitimateRead.body.alias === initialAlias &&
          legitimateRead.body.metadata.version === created.metadata.version
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

      await writer.entities.delete(entityID);
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

async function requestEntity(baseUrl, id, apiKey, signal) {
  const headers = { Accept: "application/json" };
  if (apiKey !== undefined) headers["X-API-Key"] = apiKey;
  const response = await fetch(`${baseUrl}/entities/${encodeURIComponent(id)}`, {
    method: "GET",
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  });
  const serialized = await response.text();
  let body;
  try {
    body = JSON.parse(serialized);
  } catch {
    body = serialized;
  }
  return {
    status: response.status,
    body,
    headers: {
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag")
    }
  };
}

function recordUnauthorized(record, credentialCase, response) {
  const expectedBody = { success: false, message: "Unauthorized", error_code: "UNAUTHORIZED" };
  record({
    check: `${credentialCase} cannot read a protected Entity and receives no protected data`,
    expected: { status: 401, ...expectedBody },
    actual: { status: response.status, body: response.body, headers: response.headers },
    passed:
      response.status === 401 &&
      isDeepStrictEqual(response.body, expectedBody) &&
      !includesProtectedData(response.body)
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

async function readEntityOutcome(client, id, signal) {
  try {
    const entity = await client.entities.get(id, { fresh: true, signal });
    return { ok: true, entity, observation: summarizeEntity(entity) };
  } catch (error) {
    return { ok: false, observation: summarizeSDKError(error) };
  }
}

function summarizeSDKError(error) {
  if (!(error instanceof Error)) return { error: String(error) };
  return {
    name: error.name,
    status: error.status,
    error_code: error.errorCode,
    message: error.message,
    response: error.response
  };
}

function summarizeEntityBody(body) {
  return isEntityBody(body)
    ? { entity_id: body.entity_id, alias: body.alias, version: body.metadata.version }
    : body;
}

function isEntityBody(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.entity_id === entityID &&
    typeof value.alias === "string" &&
    value.metadata !== null &&
    typeof value.metadata === "object" &&
    typeof value.metadata.version === "number"
  );
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
