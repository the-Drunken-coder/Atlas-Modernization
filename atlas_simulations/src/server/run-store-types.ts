import type { AssertionResult, AtlasTargetSummary, CreatedResource, JSONValue, RunEvent, RunStatus, RunSummary } from "../shared/types.js";
import type { AtlasClientFactory, AtlasClientLike } from "./atlas.js";

export type EventSubscriber = (event: RunEvent) => void;

export type RunTarget = AtlasTargetSummary & {
  clientFactory?: AtlasClientFactory;
};

export type RunScenario = {
  id: string;
  name: string;
};

export type RunRecord = {
  id: string;
  scenario: RunScenario;
  target?: AtlasTargetSummary;
  clientFactory: AtlasClientFactory;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  inputs: Record<string, string | number | boolean>;
  jsonInput?: JSONValue;
  createdResources: CreatedResource[];
  cleanupResources: CreatedResource[];
  overflowCleanupResource?: CreatedResource;
  assertions: AssertionResult[];
  assertionHistoryBytes: number;
  events: RunEvent[];
  eventHistoryBytes: number;
  subscribers: Set<EventSubscriber>;
  controller: AbortController;
  clients: AtlasClientLike[];
  settled: boolean;
  cleanupStarted: boolean;
  cleaned: boolean;
  cleanupPromise?: Promise<RunSummary>;
  execution?: Promise<void>;
  sequence: number;
  lastError?: string;
  trackingError?: string;
  cleanupError?: string;
};

export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export function runId(): string {
  return `sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function timestamp(): string {
  return new Date().toISOString();
}
