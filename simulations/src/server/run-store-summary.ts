import { type AtlasTargetSummary, type JSONNumber, jsonNumber, type RunSummary } from "../shared/types.js";
import { cloneValue, type RunRecord, type RunTarget } from "./run-store-types.js";

export function toSummary(run: RunRecord): RunSummary {
  return {
    id: run.id,
    scenarioId: run.scenario.id,
    scenarioName: run.scenario.name,
    ...(run.target ? { target: cloneValue(run.target) } : {}),
    status: run.status,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    updatedAt: run.events.at(-1)?.timestamp ?? run.finishedAt ?? run.startedAt,
    inputs: wireInputs(run.inputs),
    ...(run.jsonInput === undefined ? {} : { jsonInput: cloneValue(run.jsonInput) }),
    createdResources: cloneValue(run.createdResources),
    assertions: cloneValue(run.assertions),
    cleaned: run.cleaned,
    ...(run.cleanupError || run.lastError ? { lastError: run.cleanupError ?? run.lastError } : {})
  };
}

export function targetSummary(target: RunTarget): AtlasTargetSummary {
  return {
    id: target.id,
    label: target.label,
    baseUrl: target.baseUrl,
    deployed: target.deployed,
    apiKeyConfigured: target.apiKeyConfigured
  };
}

function wireInputs(inputs: Record<string, string | number | boolean>): Record<string, string | JSONNumber | boolean> {
  return Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => [key, typeof value === "number" ? jsonNumber(value) : value])
  );
}
