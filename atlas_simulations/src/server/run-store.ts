import type { AssertionResult, CreatedResource, JSONValue, RunEvent, RunStatus, RunSummary } from "../shared/types.js";
import type { AtlasClientFactory, AtlasClientLike } from "./atlas.js";
import { isNotFoundError } from "./atlas.js";
import { createScenarioContext, type Scenario, type ScenarioInput } from "./scenario.js";

type EventSubscriber = (event: RunEvent) => void;

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
  sequence: number;
  lastError?: string;
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
    return this.requireRun(id).events;
  }

  start(scenario: Scenario, input: ScenarioInput): RunSummary {
    const id = runId();
    const now = timestamp();
    const run: RunRecord = {
      id,
      scenario,
      status: "running",
      startedAt: now,
      inputs: input.fields,
      ...(input.json === undefined ? {} : { jsonInput: input.json }),
      createdResources: [],
      assertions: [],
      events: [],
      subscribers: new Set(),
      controller: new AbortController(),
      clients: [],
      sequence: 0
    };
    this.runs.set(id, run);
    this.emit(run, { type: "status", status: "running", message: `${scenario.name} started` });
    void this.execute(run, input);
    return toSummary(run);
  }

  stop(id: string): RunSummary {
    const run = this.requireRun(id);
    if (run.status === "running") {
      run.controller.abort();
      this.finish(run, "cancelled", "Stop requested");
    }
    return toSummary(run);
  }

  async cleanup(id: string): Promise<RunSummary> {
    const run = this.requireRun(id);
    if (run.status === "running") {
      throw new Error("Stop the run before cleanup");
    }
    const client = this.clientFactory({ sync: false });
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
        run.lastError = errorMessage(error);
        this.emit(run, { type: "error", level: "error", message: run.lastError });
        throw error;
      }
    }
    run.status = "cleaned";
    run.finishedAt = run.finishedAt ?? timestamp();
    this.emit(run, { type: "status", status: "cleaned", message: "Cleanup complete" });
    return toSummary(run);
  }

  subscribe(id: string, subscriber: EventSubscriber): () => void {
    const run = this.requireRun(id);
    for (const event of run.events) subscriber(event);
    run.subscribers.add(subscriber);
    return () => run.subscribers.delete(subscriber);
  }

  private async execute(run: RunRecord, input: ScenarioInput): Promise<void> {
    const registerClient = (client: AtlasClientLike) => run.clients.push(client);
    const context = createScenarioContext({
      runId: run.id,
      signal: run.controller.signal,
      clientFactory: this.clientFactory,
      registerClient,
      log: (message, data) => this.emit(run, { type: "log", message, data }),
      assert: (name, passed, message) => this.assert(run, name, passed, message),
      track: (resource) => this.track(run, resource)
    });
    try {
      await run.scenario.run(context, input);
      if (run.controller.signal.aborted) {
        this.finish(run, "cancelled", "Run cancelled");
      } else {
        this.finish(run, "completed", "Run completed");
      }
    } catch (error) {
      if (run.controller.signal.aborted) {
        this.finish(run, "cancelled", "Run cancelled");
      } else {
        run.lastError = errorMessage(error);
        this.finish(run, "failed", run.lastError);
        this.emit(run, { type: "error", level: "error", message: run.lastError });
      }
    } finally {
      for (const client of run.clients) {
        client.sync.stop();
      }
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
      run.createdResources.push(resource);
      this.emit(run, { type: "resource", resource, message: `Created ${resource.type} ${resource.id}` });
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
    run.assertions.push(assertion);
    this.emit(run, {
      type: "assertion",
      level: passed ? "info" : "error",
      assertion,
      message: `${passed ? "PASS" : "FAIL"} ${name}${message ? `: ${message}` : ""}`
    });
    return assertion;
  }

  private emit(run: RunRecord, details: Omit<RunEvent, "sequence" | "runId" | "timestamp">): void {
    const event: RunEvent = {
      sequence: ++run.sequence,
      runId: run.id,
      timestamp: timestamp(),
      ...details
    };
    run.events.push(event);
    for (const subscriber of run.subscribers) subscriber(event);
  }

  private requireRun(id: string): RunRecord {
    const run = this.runs.get(id);
    if (!run) {
      throw new Error(`Run ${id} was not found`);
    }
    return run;
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
    inputs: run.inputs,
    ...(run.jsonInput === undefined ? {} : { jsonInput: run.jsonInput }),
    createdResources: [...run.createdResources],
    assertions: [...run.assertions],
    ...(run.lastError ? { lastError: run.lastError } : {})
  };
}

function cleanupOrder(resources: CreatedResource[]): CreatedResource[] {
  const order: Record<CreatedResource["type"], number> = { task: 0, object: 1, entity: 2 };
  return [...resources].sort((a, b) => order[a.type] - order[b.type]);
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
