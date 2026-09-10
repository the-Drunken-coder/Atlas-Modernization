import type { PluginRelease } from "./plugin-distribution.js";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const MAX_OPERATIONS = 128;
const MAX_RUNTIME_BODY_BYTES = 1 << 20;
const MAX_OPERATION_ID_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_OPERATION_TIMEOUT_MS = 25_000;

/** Probe executed inside the Plugin container before accepting its private runtime. */
export const PLUGIN_RUNTIME_PROBE_SCRIPT = String.raw`
const paths = ["/manifest", "/health", "/atlas-manager-unknown-route"];
const maxBodyBytes = ${MAX_RUNTIME_BODY_BYTES};
const readBody = async (response) => {
  if (!response.body || typeof response.body.getReader !== "function") throw new Error("response body is missing");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new Error("response body chunk is invalid");
      length += next.value.byteLength;
      if (length > maxBodyBytes) {
        await reader.cancel();
        throw new Error("response body is too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Buffer.from(bytes).toString("utf8");
};
Promise.all(paths.map(async (path) => {
  const response = await fetch("http://127.0.0.1:8080" + path, { signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await readBody(response) };
})).then((responses) => process.stdout.write(JSON.stringify(responses))).catch(() => {
  process.exitCode = 1;
});
`;

type RuntimeResponse = {
  status: number;
  body: string;
};

/**
 * Verifies the private runtime contract against the signed Plugin release.
 * Docker transport and image identity are checked by the host adapter; this
 * helper only validates the bounded responses returned by that adapter.
 */
export function assertPluginRuntime(release: PluginRelease, responses: unknown): void {
  const [manifestResponse, healthResponse, unknownRouteResponse] = parseResponses(responses);
  if (manifestResponse.status !== 200) throw new Error("Plugin /manifest did not return HTTP 200.");
  if (healthResponse.status !== 200) throw new Error("Plugin /health did not return HTTP 200.");
  if (unknownRouteResponse.status !== 404) throw new Error("Plugin unknown route did not return HTTP 404.");

  const manifest = parseJSON(manifestResponse.body, "Plugin /manifest");
  assertManifest(release, manifest);

  const health = parseJSON(healthResponse.body, "Plugin /health");
  if (!isRecord(health) || Object.keys(health).length !== 1 || health.status !== "ok") {
    throw new Error('Plugin /health did not return {"status":"ok"}.');
  }

  const unknownRoute = parseJSON(unknownRouteResponse.body, "Plugin unknown route");
  if (!isRecord(unknownRoute) || unknownRoute.code !== "route_not_found") {
    throw new Error("Plugin unknown route did not return code route_not_found.");
  }
}

function parseResponses(value: unknown): [RuntimeResponse, RuntimeResponse, RuntimeResponse] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error("Plugin runtime acceptance returned an invalid response set.");
  }
  const responses = value.map((response, index) => {
    if (
      !isRecord(response) ||
      Object.keys(response).sort().join(",") !== "body,status" ||
      typeof response.status !== "number" ||
      !Number.isSafeInteger(response.status) ||
      typeof response.body !== "string" ||
      Buffer.byteLength(response.body, "utf8") > MAX_RUNTIME_BODY_BYTES
    ) {
      throw new Error(`Plugin runtime response ${index + 1} is invalid.`);
    }
    return { status: response.status, body: response.body };
  });
  return [responses[0] as RuntimeResponse, responses[1] as RuntimeResponse, responses[2] as RuntimeResponse];
}

function assertManifest(release: PluginRelease, value: unknown): void {
  if (!isRecord(value)) throw new Error("Plugin runtime manifest is not an object.");
  const allowedKeys = new Set([
    "plugin_id",
    "display_name",
    "core_to_plugin_protocol_major",
    "operations",
    "tool_asset_id"
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("Plugin runtime manifest contains an unknown field.");
  }
  if (
    value.plugin_id !== release.pluginId ||
    value.display_name !== release.displayName ||
    value.core_to_plugin_protocol_major !== release.coreToPluginProtocolMajor
  ) {
    throw new Error("Plugin runtime manifest identity does not match its signed release.");
  }
  if (!Object.hasOwn(value, "operations") || !Array.isArray(value.operations)) {
    throw new Error("Plugin runtime manifest operations must be an array.");
  }
  if (value.operations.length > MAX_OPERATIONS) {
    throw new Error("Plugin runtime manifest contains too many operations.");
  }

  const interactions = new Set<string>();
  let previousOperation = "";
  const operationIDs = new Set<string>();
  for (const operation of value.operations) {
    if (!isRecord(operation)) throw new Error("Plugin runtime manifest contains an invalid Operation descriptor.");
    const operationID = operation.operation_id;
    const displayName = operation.display_name;
    const timeout = operation.timeout_ms;
    if (
      typeof operationID !== "string" ||
      !IDENTIFIER_PATTERN.test(operationID) ||
      operationID.length > MAX_OPERATION_ID_LENGTH ||
      typeof displayName !== "string" ||
      displayName.trim() !== displayName ||
      displayName.length === 0 ||
      displayName.length > MAX_DISPLAY_NAME_LENGTH ||
      typeof timeout !== "number" ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > MAX_OPERATION_TIMEOUT_MS
    ) {
      throw new Error("Plugin runtime manifest contains an invalid Operation descriptor.");
    }
    if (operationID <= previousOperation || operationIDs.has(operationID)) {
      throw new Error("Plugin runtime manifest Operations are not sorted and unique.");
    }
    previousOperation = operationID;
    operationIDs.add(operationID);

    const operationKeys = Object.keys(operation).sort();
    if (operation.interaction === undefined) {
      if (operationKeys.join(",") !== "display_name,operation_id,timeout_ms") {
        throw new Error("Plugin runtime Operation contains an unknown field.");
      }
      continue;
    }
    if (
      !isRecord(operation.interaction) ||
      Object.keys(operation.interaction).length !== 1 ||
      operation.interaction.kind !== "map_area" ||
      operationKeys.join(",") !== "display_name,interaction,operation_id,timeout_ms"
    ) {
      throw new Error("Plugin runtime Operation interaction is invalid.");
    }
    interactions.add("map_area");
  }

  const advertisedInteractions = [...interactions].sort();
  if (
    advertisedInteractions.length !== release.interactions.length ||
    advertisedInteractions.some((value, index) => value !== release.interactions[index])
  ) {
    throw new Error("Plugin runtime manifest interactions do not match its signed release.");
  }

  if (Object.hasOwn(value, "tool_asset_id")) {
    throw new Error("Plugin runtime manifest tool_asset_id is not supported for query-only releases.");
  }
}

function parseJSON(body: string, label: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
