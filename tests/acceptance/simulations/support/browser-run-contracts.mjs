import { isResourceType } from "@the-drunken-coder/atlas-sdk";

/**
 * Mirrors the browser API's `isRunSummary` guard and binds each consumed
 * lifecycle response to the requested scenario and, when known, run ID.
 * Journey assertions still compare the scenario's expected values separately.
 */
export function parseBrowserRunSummary(value, expected) {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.scenarioId !== "string" ||
    typeof value.scenarioName !== "string" ||
    (value.target !== undefined && !isAtlasTargetSummary(value.target)) ||
    !isRunStatus(value.status) ||
    typeof value.startedAt !== "string" ||
    (value.finishedAt !== undefined && typeof value.finishedAt !== "string") ||
    (value.updatedAt !== undefined && typeof value.updatedAt !== "string") ||
    !isInputRecord(value.inputs) ||
    (value.jsonInput !== undefined && !isJSONValue(value.jsonInput)) ||
    !Array.isArray(value.createdResources) ||
    !value.createdResources.every(isCreatedResource) ||
    !Array.isArray(value.assertions) ||
    !value.assertions.every(isAssertionResult) ||
    typeof value.cleaned !== "boolean" ||
    (value.lastError !== undefined && typeof value.lastError !== "string")
  ) {
    throw new Error("Invalid browser run summary");
  }
  if (
    value.scenarioId !== expected.scenarioID ||
    (expected.runID !== undefined && value.id !== expected.runID)
  ) {
    throw new Error(`Unexpected browser run summary from ${expected.context}`);
  }
  return value;
}

function isAssertionResult(value) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.passed === "boolean" &&
    typeof value.timestamp === "string" &&
    (value.message === undefined || typeof value.message === "string")
  );
}

function isCreatedResource(value) {
  return isRecord(value) && isResourceType(value.type) && typeof value.id === "string";
}

function isAtlasTargetSummary(value) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.baseUrl === "string" &&
    typeof value.deployed === "boolean" &&
    typeof value.apiKeyConfigured === "boolean"
  );
}

function isInputRecord(value) {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (item) => typeof item === "string" || typeof item === "boolean" || isFiniteNumber(item),
    )
  );
}

function isRunStatus(value) {
  return ["running", "completed", "failed", "cancelled", "abandoned"].includes(value);
}

function isJSONValue(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current === "boolean" || typeof current === "string") continue;
    if (isFiniteNumber(current)) continue;
    if (Array.isArray(current)) pending.push(...current);
    else if (isRecord(current)) pending.push(...Object.values(current));
    else return false;
  }
  return true;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
