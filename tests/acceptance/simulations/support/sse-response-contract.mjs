import { isResourceType } from "@the-drunken-coder/atlas-sdk";

export function eventStreamResponseError(response) {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    response.status === 200 &&
    mediaType === "text/event-stream" &&
    response.body
  ) {
    return undefined;
  }
  return `GET run events expected HTTP 200 with Content-Type text/event-stream, received HTTP ${response.status} with Content-Type ${mediaType ?? "missing"}`;
}

/**
 * Parse only frames the browser's EventSource `onmessage` handler would receive.
 */
export function parseBrowserRunEventFrame(frame) {
  const data = [];
  let eventType;
  for (const line of frame.split(/\r?\n/u)) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value =
      separator === -1 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "event") eventType = value;
    if (field === "data") data.push(value);
  }
  if (eventType !== undefined && eventType !== "" && eventType !== "message") {
    throw new Error(
      `Simulation event frame used EventSource-ignored type ${JSON.stringify(eventType)}`,
    );
  }
  return data.length > 0
    ? parseRunEventContract(JSON.parse(data.join("\n")))
    : undefined;
}

function parseRunEventContract(value) {
  if (!isRecord(value) || !hasRunEventBase(value)) {
    throw new Error("Invalid simulation run event");
  }
  const valid =
    (value.type === "status" && isRunStatus(value.status)) ||
    value.type === "log" ||
    (value.type === "assertion" && isAssertionResult(value.assertion)) ||
    (value.type === "resource" && isCreatedResource(value.resource)) ||
    (value.type === "error" && value.level === "error") ||
    (value.type === "cleanup" &&
      (value.resource === undefined || isCreatedResource(value.resource)));
  if (!valid) throw new Error("Invalid simulation run event");
  return value;
}

function hasRunEventBase(value) {
  return (
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 1 &&
    typeof value.runId === "string" &&
    isCanonicalTimestamp(value.timestamp) &&
    typeof value.message === "string" &&
    (value.level === undefined ||
      ["info", "warn", "error"].includes(value.level)) &&
    (value.data === undefined || isJSONValue(value.data))
  );
}

function isAssertionResult(value) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.passed === "boolean" &&
    isCanonicalTimestamp(value.timestamp) &&
    (value.message === undefined || typeof value.message === "string")
  );
}

function isCreatedResource(value) {
  return (
    isRecord(value) &&
    isResourceType(value.type) &&
    typeof value.id === "string"
  );
}

function isRunStatus(value) {
  return ["running", "completed", "failed", "cancelled", "abandoned"].includes(
    value,
  );
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    !Number.isNaN(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function isJSONValue(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "string"
    ) {
      continue;
    }
    if (typeof current === "number" && Number.isFinite(current)) continue;
    if (Array.isArray(current)) pending.push(...current);
    else if (isRecord(current)) pending.push(...Object.values(current));
    else return false;
  }
  return true;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
