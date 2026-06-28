import type { AssertionResult, CreatedResource, JSONValue, RunEvent, RunEventDetails, RunStatus, RunSummary } from "../shared/types.js";
import type { AtlasClientFactory, AtlasClientLike } from "./atlas.js";
import { isNotFoundError } from "./atlas.js";
import { createScenarioContext, type Scenario, type ScenarioInput } from "./scenario.js";

type EventSubscriber = (event: RunEvent) => void;

const MAX_RUNS = 100;
const MAX_EVENTS_PER_RUN = 500;

type RunRecord = {
  id: string;
  scenario: Scenario;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  inputs: Record<string, string | number | boolean>;
  jsonInput?: JSONValue;
  createdResources: CreatedResource[];
  assertions: AssertionResult[];
  events: RunEvent[];
  subscribers: Set<EventSubscriber>;
  controller: AbortController;
  clients: AtlasClientLike[];
  settled: boolean;
  cleaned: boolean;
  cleanupPromise?: Promise<RunSummary>;
  sequence: number;
  lastError?: string;
  cleanupError?: string;
};

export class RunStore {
  private readonly runs = new Map<string, RunRecord>();

  constructor(private readonly clientFactory: AtlasClientFactory) {}

  list(): RunSummary[] {
    return [...this.runs.values()].map((run) => toSummary(run));
  }

  get(id: string): RunSummary | undefined {
    const run = this.runs.get(id);
    return run ? toSummary(run) : undefined;
  }

  events(id: string): RunEvent[] {
    return this.requireRun(id).events.map(cloneValue);
  }

  start(scenario: Scenario, input: ScenarioInput): RunSummary {
    this.pruneRuns(MAX_RUNS - 1);
    if (this.runs.size >= MAX_RUNS) {
      throw new Error("Clean up existing simulation runs before starting another run");
    }
    const id = this.nextRunId();
    const now = timestamp();
    const run: RunRecord = {
      id,
      scenario,
      status: "running",
      startedAt: now,
      inputs: cloneValue(input.fields),
      ...(input.json === undefined ? {} : { jsonInput: cloneValue(input.json) }),
      createdResources: [],
      assertions: [],
      events: [],
      subscribers: new Set(),
      controller: new AbortController(),
      clients: [],
      settled: false,
      cleaned: false,
      sequence: 0
    };
    this.runs.set(id, run);
    this.emit(run, { type: "status", status: "running", message: `${scenario.name} started` });
    void this.execute(run, input);
    return toSummary(run);
  }

  stop(id: string): RunSummary {
    const run = this.requireRun(id);
    if (run.status === "running" && !run.controller.signal.aborted) {
      run.controller.abort();
      this.emit(run, { type: "log", level: "warn", message: "Stop requested" });
    }
    return toSummary(run);
  }

  async cleanup(id: string): Promise<RunSummary> {
    const run = this.requireRun(id);
    if (run.cleaned) return toSummary(run);
    if (run.status === "running" || !run.settled) {
      throw new Error("Wait for the run to finish before cleanup");
    }
    if (run.cleanupPromise) return run.cleanupPromise;
    run.cleanupPromise = this.performCleanup(run);
    try {
      return await run.cleanupPromise;
    } finally {
      run.cleanupPromise = undefined;
    }
  }

  private async performCleanup(run: RunRecord): Promise<RunSummary> {
    let client: AtlasClientLike;
    try {
      client = this.clientFactory({ sync: false });
    } catch (error) {
      run.cleanupError = errorMessage(error);
      this.emit(run, { type: "error", level: "error", message: run.cleanupError });
      throw error;
    }
    let stopped = false;
    try {
      for (const resource of cleanupOrder(run.createdResources)) {
        try {
          if (resource.type === "task") await client.tasks.delete(resource.id);
          if (resource.type === "object") await client.objects.delete(resource.id);
          if (resource.type === "entity") await client.entities.delete(resource.id);
          this.emit(run, { type: "cleanup", resource, message: `Deleted ${resource.type} ${resource.id}` });
        } catch (error) {
          if (isNotFoundError(error)) {
            this.emit(run, { type: "cleanup", resource, message: `${resource.type} ${resource.id} was already gone` });
            continue;
          }
          run.cleanupError = errorMessage(error);
          this.emit(run, { type: "error", level: "error", message: run.cleanupError });
          throw error;
        }
      }
      stopCleanupClient(run, client);
      stopped = true;
      run.cleaned = true;
      run.cleanupError = undefined;
      this.emit(run, { type: "cleanup", message: "Cleanup complete" });
      this.pruneRuns();
      return toSummary(run);
    } finally {
      if (!stopped) {
        try {
          client.sync.stop();
        } catch (error) {
          run.cleanupError ??= errorMessage(error);
          this.emit(run, { type: "error", level: "error", message: errorMessage(error) });
        }
      }
    }
  }

  subscribe(id: string, subscriber: EventSubscriber): () => void {
    const run = this.requireRun(id);
    for (const event of run.events) {
      try {
        subscriber(cloneValue(event));
      } catch {
        return () => undefined;
      }
    }
    run.subscribers.add(subscriber);
    return () => run.subscribers.delete(subscriber);
  }

  private async execute(run: RunRecord, input: ScenarioInput): Promise<void> {
    let finalStatus: RunStatus = "completed";
    let finalMessage = "Run completed";
    let finalError: string | undefined;
    try {
      const registerClient = (client: AtlasClientLike) => run.clients.push(client);
      const context = createScenarioContext({
        runId: run.id,
        signal: run.controller.signal,
        clientFactory: this.clientFactory,
        registerClient,
        log: (message, data) => {
          if (!run.settled) this.emit(run, { type: "log", message, data });
        },
        assert: (name, passed, message) => (run.settled ? lateAssertion(name, passed, message) : this.assert(run, name, passed, message)),
        track: (resource) => {
          if (!run.settled) this.track(run, resource);
        }
      });
      await run.scenario.run(context, input);
      if (run.controller.signal.aborted) {
        finalStatus = "cancelled";
        finalMessage = "Run cancelled";
      } else if (hasFailedAssertions(run)) {
        finalStatus = "failed";
        finalMessage = "Run completed with failed assertions";
        run.lastError = finalMessage;
      }
    } catch (error) {
      if (run.controller.signal.aborted) {
        finalStatus = "cancelled";
        finalMessage = "Run cancelled";
      } else {
        finalError = errorMessage(error);
        run.lastError = finalError;
        finalStatus = "failed";
        finalMessage = finalError;
      }
    } finally {
      for (const client of run.clients) {
        try {
          client.sync.stop();
        } catch (error) {
          const message = `Failed to stop client sync: ${errorMessage(error)}`;
          if (finalStatus === "completed") {
            run.lastError = message;
            finalStatus = "failed";
            finalMessage = message;
          } else if (!run.lastError) {
            run.lastError = message;
          }
          this.emit(run, {
            type: "error",
            level: "error",
            message
          });
        }
      }
      run.settled = true;
      if (finalError) this.emit(run, { type: "error", level: "error", message: finalError });
      this.finish(run, finalStatus, finalMessage);
      this.pruneRuns();
    }
  }

  private finish(run: RunRecord, status: RunStatus, message: string): void {
    if (run.status !== "running") return;
    run.status = status;
    run.finishedAt = timestamp();
    this.emit(run, { type: "status", status, message });
  }

  private track(run: RunRecord, resource: CreatedResource): void {
    if (!run.createdResources.some((current) => current.type === resource.type && current.id === resource.id)) {
      const tracked = cloneValue(resource);
      run.createdResources.push(tracked);
      this.emit(run, { type: "resource", resource: tracked, message: `Created ${tracked.type} ${tracked.id}` });
    }
  }

  private assert(run: RunRecord, name: string, passed: boolean, message?: string): AssertionResult {
    const assertion: AssertionResult = {
      id: `assert-${run.assertions.length + 1}`,
      name,
      passed,
      ...(message ? { message } : {}),
      timestamp: timestamp()
    };
    run.assertions.push(cloneValue(assertion));
    this.emit(run, {
      type: "assertion",
      level: passed ? "info" : "error",
      assertion: cloneValue(assertion),
      message: `${passed ? "PASS" : "FAIL"} ${name}${message ? `: ${message}` : ""}`
    });
    return cloneValue(assertion);
  }

  private emit(run: RunRecord, details: RunEventDetails): void {
    const event: RunEvent = {
      sequence: ++run.sequence,
      runId: run.id,
      timestamp: timestamp(),
      ...details
    } as RunEvent;
    run.events.push(cloneValue(event));
    trimEvents(run);
    for (const subscriber of [...run.subscribers]) {
      try {
        subscriber(cloneValue(event));
      } catch {
        run.subscribers.delete(subscriber);
      }
    }
  }

  private requireRun(id: string): RunRecord {
    const run = this.runs.get(id);
    if (!run) {
      throw new Error(`Run ${id} was not found`);
    }
    return run;
  }

  private pruneRuns(targetSize = MAX_RUNS): void {
    for (const run of this.runs.values()) trimEvents(run);
    for (const [id, run] of this.runs) {
      if (this.runs.size <= targetSize) return;
      if (run.cleaned && run.settled) this.runs.delete(id);
    }
  }

  private nextRunId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = runId();
      if (!this.runs.has(id)) return id;
    }
    throw new Error("Could not allocate a unique simulation run ID");
  }
}

function toSummary(run: RunRecord): RunSummary {
  return {
    id: run.id,
    scenarioId: run.scenario.id,
    scenarioName: run.scenario.name,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    inputs: cloneValue(run.inputs),
    ...(run.jsonInput === undefined ? {} : { jsonInput: cloneValue(run.jsonInput) }),
    createdResources: cloneValue(run.createdResources),
    assertions: cloneValue(run.assertions),
    cleaned: run.cleaned,
    ...(run.cleanupError || run.lastError ? { lastError: run.cleanupError ?? run.lastError } : {})
  };
}

function trimEvents(run: RunRecord): void {
  const overflow = run.events.length - MAX_EVENTS_PER_RUN;
  if (overflow > 0) run.events.splice(0, overflow);
}

function hasFailedAssertions(run: RunRecord): boolean {
  return run.assertions.some((assertion) => !assertion.passed);
}

function lateAssertion(name: string, passed: boolean, message?: string): AssertionResult {
  return {
    id: "assert-late",
    name,
    passed,
    ...(message ? { message } : {}),
    timestamp: timestamp()
  };
}

function stopCleanupClient(run: RunRecord, client: AtlasClientLike): void {
  try {
    client.sync.stop();
  } catch (error) {
    run.cleanupError = errorMessage(error);
    throw error;
  }
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function cleanupOrder(resources: CreatedResource[]): CreatedResource[] {
  const order: Record<CreatedResource["type"], number> = { task: 0, object: 1, entity: 2 };
  return resources
    .map((resource, index) => ({ resource, index }))
    .sort((a, b) => order[a.resource.type] - order[b.resource.type] || b.index - a.index)
    .map(({ resource }) => resource);
}

function runId(): string {
  return `sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function timestamp(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
