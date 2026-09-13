import { isDeepStrictEqual } from "node:util";

import {
  isRFC3339Timestamp,
  isResourceType,
} from "@the-drunken-coder/atlas-sdk";

/**
 * Mirrors the browser API's `isRunSummary` guard and binds each consumed
 * lifecycle response to the requested scenario, run ID, and input context.
 * Journey assertions still compare the scenario's expected values separately.
 */
export function parseBrowserRunSummary(value, expected) {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.scenarioId !== "string" ||
    typeof value.scenarioName !== "string" ||
    !isAtlasTargetSummary(value.target) ||
    !isRunStatus(value.status) ||
    !hasValidLifecycleTimestamps(value) ||
    !isInputRecord(value.inputs) ||
    (value.jsonInput !== undefined && !isJSONValue(value.jsonInput)) ||
    !Array.isArray(value.createdResources) ||
    !value.createdResources.every(isCreatedResource) ||
    !Array.isArray(value.assertions) ||
    !value.assertions.every(isAssertionResult) ||
    typeof value.cleaned !== "boolean" ||
    value.lastError !== undefined
  ) {
    throw new Error("Invalid browser run summary");
  }
  if (
    value.scenarioId !== expected.scenarioID ||
    value.scenarioName !== expected.scenarioName ||
    (expected.runID !== undefined && value.id !== expected.runID) ||
    !hasExpectedTarget(value.target, expected.target) ||
    !hasExpectedInputs(value.inputs, expected.inputs) ||
    !isDeepStrictEqual(value.jsonInput, expected.jsonInput)
  ) {
    throw new Error(`Unexpected browser run summary from ${expected.context}`);
  }
  return value;
}

function hasValidLifecycleTimestamps(value) {
  if (
    !isRFC3339Timestamp(value.startedAt) ||
    !isRFC3339Timestamp(value.updatedAt)
  )
    return false;
  const startedAt = Date.parse(value.startedAt);
  const updatedAt = Date.parse(value.updatedAt);
  if (updatedAt < startedAt) return false;
  if (value.status === "running") return value.finishedAt === undefined;
  if (!isRFC3339Timestamp(value.finishedAt)) return false;
  const finishedAt = Date.parse(value.finishedAt);
  return finishedAt >= startedAt && updatedAt >= finishedAt;
}

function hasExpectedTarget(actual, expected) {
  return (
    isAtlasTargetSummary(expected) &&
    actual.id === expected.id &&
    actual.label === expected.label &&
    actual.baseUrl === expected.baseUrl &&
    actual.deployed === expected.deployed &&
    actual.apiKeyConfigured === expected.apiKeyConfigured
  );
}

function hasExpectedInputs(actual, expected) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    isDeepStrictEqual(actualKeys, expectedKeys) &&
    expectedKeys.every((key) => sameInputValue(actual[key], expected[key]))
  );
}

function sameInputValue(actual, expected) {
  if (typeof actual !== "number" || typeof expected !== "number") {
    return actual === expected;
  }
  return (
    Math.abs(actual - expected) <=
    Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected)) * 32
  );
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
  return (
    isRecord(value) &&
    isResourceType(value.type) &&
    typeof value.id === "string"
  );
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
      (item) =>
        typeof item === "string" ||
        typeof item === "boolean" ||
        isFiniteNumber(item),
    )
  );
}

function isRunStatus(value) {
  return ["running", "completed", "failed", "cancelled", "abandoned"].includes(
    value,
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
    )
      continue;
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
