import { afterEach, beforeEach, vi } from "vitest";
import {
  cleanupRun,
  loadHealth,
  loadRuns,
  loadScenarios,
  loadTargets,
  startRun,
  stopRun
} from "../../src/client/api.js";
import type {
  AtlasTargetSummary,
  HealthResponse,
  RunEvent,
  RunSummary,
  ScenarioDescriptor
} from "../../src/shared/types.js";
import { jsonNumber } from "../../src/shared/types.js";

export const scenario: ScenarioDescriptor = {
  id: "moving-assets",
  name: "Moving assets",
  summary: "Creates assets",
  acceptsJson: true,
  inputFields: [
    {
      key: "assetCount",
      label: "Asset count",
      type: "number",
      defaultValue: jsonNumber(2),
      min: jsonNumber(1),
      max: jsonNumber(4)
    }
  ]
};

export const syncScenario: ScenarioDescriptor = {
  id: "multi-client-sync",
  name: "Multi-client sync",
  summary: "Checks sync",
  acceptsJson: false,
  inputFields: []
};

export const localTarget: AtlasTargetSummary = {
  id: "local",
  label: "Local Core",
  baseUrl: "http://localhost:8000",
  deployed: false,
  apiKeyConfigured: true
};

export const deployedTarget: AtlasTargetSummary = {
  id: "deployed",
  label: "Atlas Command API",
  baseUrl: "https://atlascommandapi.org",
  deployed: true,
  apiKeyConfigured: true
};

export const run: RunSummary = {
  id: "sim-test",
  scenarioId: "moving-assets",
  scenarioName: "Moving assets",
  status: "running",
  startedAt: new Date().toISOString(),
  inputs: { assetCount: jsonNumber(2) },
  createdResources: [],
  assertions: [],
  cleaned: false
};

export let eventSources: FakeEventSource[] = [];

export function cloneRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    ...run,
    inputs: { ...run.inputs },
    createdResources: [...run.createdResources],
    assertions: [...run.assertions],
    ...overrides
  };
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class FakeEventSource {
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    eventSources.push(this);
  }

  emit(event: RunEvent) {
    if (this.closed) return;
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  }

  close() {
    this.closed = true;
    this.onmessage = null;
    this.onerror = null;
  }
}

beforeEach(() => {
  eventSources = [];
  vi.resetAllMocks();
  vi.mocked(loadTargets).mockResolvedValue({
    targets: [localTarget, deployedTarget],
    defaultTargetId: localTarget.id
  });
  vi.mocked(loadHealth).mockResolvedValue({ ok: true, status: jsonNumber(200), message: "ok" });
  vi.mocked(loadScenarios).mockResolvedValue([scenario]);
  vi.mocked(loadRuns).mockResolvedValue([]);
  vi.mocked(startRun).mockResolvedValue(cloneRun());
  vi.mocked(stopRun).mockResolvedValue(cloneRun({ status: "running" }));
  vi.mocked(cleanupRun).mockResolvedValue(cloneRun({ status: "completed", cleaned: true }));
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

export type { AtlasTargetSummary, HealthResponse, RunEvent, RunSummary, ScenarioDescriptor };
