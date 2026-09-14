import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { runAcceptance } from "../support/stack.mjs";

const controlDirectory = process.env.ATLAS_MIGRATION_OBSERVER_CONTROL;
if (!controlDirectory) throw new Error("ATLAS_MIGRATION_OBSERVER_CONTROL must be set");
mkdirSync(controlDirectory, { recursive: true });

await runAcceptance({
  name: "migration-restore-observer",
  reproduction: "node tests/acceptance/migration-restore/observer.mjs",
  run: async ({ baseUrl, apiKey, artifacts, record, signal }) => {
    const entityID = `observer-${randomUUID()}`;
    assertResourceID(entityID);
    let entity = await requestJSON(baseUrl, apiKey, "/entities", {
      method: "POST",
      body: { entity_id: entityID, entity_type: "asset", alias: "observer-ready" },
      expectedStatus: 201,
      signal
    });
    record({
      check: "independent acceptance stack created its sentinel Entity",
      expected: { entity_id: entityID, alias: "observer-ready" },
      actual: summarizeEntity(entity),
      passed: isDeepStrictEqual(summarizeEntity(entity), { entity_id: entityID, alias: "observer-ready" })
    });
    writeFileSync(
      join(controlDirectory, "ready.json"),
      `${JSON.stringify({ artifacts, base_url: baseUrl, entity_id: entityID }, null, 2)}\n`
    );

    await waitForFile(join(controlDirectory, "activity-start.json"), 10 * 60_000, signal);
    const operationTimes = [];
    const activityDeadline = Date.now() + 2 * 60_000;
    while (!existsSync(join(controlDirectory, "activity-complete.json"))) {
      if (Date.now() >= activityDeadline) throw new Error("paired restore activity exceeded the observer's 120000 ms bound");
      const index = operationTimes.length + 1;
      const startedAt = new Date();
      const alias = `observer-active-${index}`;
      entity = await requestJSON(baseUrl, apiKey, `/entities/${encodeURIComponent(entityID)}`, {
        method: "PATCH",
        body: { alias },
        headers: { "If-Match": `"v${entity.metadata.version}"` },
        expectedStatus: 200,
        signal
      });
      const read = await requestJSON(baseUrl, apiKey, `/entities/${encodeURIComponent(entityID)}`, {
        expectedStatus: 200,
        signal
      });
      const completedAt = new Date();
      operationTimes.push({ started_at: startedAt.toISOString(), completed_at: completedAt.toISOString() });
      record({
        check: `independent acceptance operation ${index} succeeded during paired restore`,
        expected: { entity_id: entityID, alias, version: entity.metadata.version },
        actual: { ...summarizeEntity(read), version: read.metadata.version },
        passed:
          isDeepStrictEqual(summarizeEntity(read), { entity_id: entityID, alias }) &&
          read.metadata.version === entity.metadata.version
      });
      if (operationTimes.length === 1) {
        writeFileSync(
          join(controlDirectory, "activity-observed.json"),
          `${JSON.stringify({ first_operation: operationTimes[0] }, null, 2)}\n`
        );
      }
      await delay(250, signal);
    }
    writeFileSync(
      join(controlDirectory, "activity-report.json"),
      `${JSON.stringify({ operation_times: operationTimes }, null, 2)}\n`
    );

    const finalRead = await requestJSON(baseUrl, apiKey, `/entities/${encodeURIComponent(entityID)}`, {
      expectedStatus: 200,
      signal
    });
    record({
      check: "independent acceptance stack remained available after paired restore",
      expected: summarizeEntity(entity),
      actual: summarizeEntity(finalRead),
      passed: isDeepStrictEqual(summarizeEntity(finalRead), summarizeEntity(entity))
    });
  }
});

async function requestJSON(baseUrl, apiKey, path, options = {}) {
  const { method = "GET", body, headers = {}, expectedStatus, signal } = options;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "X-API-Key": apiKey,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  });
  const raw = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${path}: expected HTTP ${expectedStatus}, observed ${response.status}: ${raw}`);
  }
  return JSON.parse(raw);
}

async function waitForFile(path, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(100, signal);
  }
  return JSON.parse(readFileSync(path, "utf8"));
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

function summarizeEntity(entity) {
  return { entity_id: entity.entity_id, alias: entity.alias };
}

function assertResourceID(id) {
  if (id.length > 50 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id)) {
    throw new Error(`generated observer Entity ID violates the published 50-character resource ID contract: ${id}`);
  }
}
