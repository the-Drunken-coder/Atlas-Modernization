import { jsonNumber, type AssertionResult, type CreatedResource, type JSONNumber, type JSONValue, type RunEvent, type RunEventDetails, type RunStatus, type RunSummary } from "../shared/types.js";
import type { AtlasClientFactory, AtlasClientLike } from "./atlas.js";
import { isNotFoundError } from "./atlas.js";
import { createScenarioContext, type Scenario, type ScenarioInput } from "./scenario.js";

type EventSubscriber = (event: RunEvent) => void;

const MAX_RUNS = 100;
const MAX_EVENTS_PER_RUN = 500;
const MAX_EVENT_HISTORY_BYTES_PER_RUN = 1_000_000;
const MAX_CREATED_RESOURCES_PER_RUN = 1_000;
const MAX_ASSERTIONS_PER_RUN = 1_000;
const MAX_EVENT_DATA_DEPTH = 200;
const MAX_EVENT_DATA_NODES = 10_000;
const MAX_EVENT_DATA_STRING_BYTES = 200_000;
const EVENT_MESSAGE_TRUNCATION_SUFFIX = "...[truncated]";

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
    const runInput: ScenarioInput = {
      fields: cloneValue(input.fields),
      ...(input.json === undefined ? {} : { json: cloneValue(input.json) })
    };
    const run: RunRecord = {
      id,
      scenario,
      status: "running",
      startedAt: now,
      inputs: cloneValue(runInput.fields),
      ...(runInput.json === undefined ? {} : { jsonInput: cloneValue(runInput.json) }),
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
    void this.execute(run, runInput);
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
    if (run.createdResources.length === 0) {
      run.cleaned = true;
      run.cleanupError = undefined;
      this.emit(run, { type: "cleanup", message: "Cleanup complete" });
      this.pruneRuns();
      return toSummary(run);
    }

    let client: AtlasClientLike;
    try {
      client = this.clientFactory({ sync: false });
    } catch (error) {
      run.cleanupError = errorMessage(error);
      this.emit(run, { type: "error", level: "error", message: run.cleanupError });
      throw error;
    }
    let cleanupFailure: unknown;
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
        cleanupFailure = error;
        break;
      }
    }
    const stopFailure = stopClientSync(client);
    if (stopFailure) {
      const message = errorMessage(stopFailure);
      run.cleanupError ??= message;
      this.emit(run, { type: "error", level: "error", message });
    }
    if (cleanupFailure) throw cleanupFailure;
    if (stopFailure) throw stopFailure;
    run.cleaned = true;
    run.cleanupError = undefined;
    this.emit(run, { type: "cleanup", message: "Cleanup complete" });
    this.pruneRuns();
    return toSummary(run);
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
      run.clients = [];
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
      if (run.createdResources.length >= MAX_CREATED_RESOURCES_PER_RUN) {
        throw new Error(`Simulation can track at most ${MAX_CREATED_RESOURCES_PER_RUN} created resources`);
      }
      const tracked = cloneValue(resource);
      run.createdResources.push(tracked);
      this.emit(run, { type: "resource", resource: tracked, message: `Created ${tracked.type} ${tracked.id}` });
    }
  }

  private assert(run: RunRecord, name: string, passed: boolean, message?: string): AssertionResult {
    if (run.assertions.length >= MAX_ASSERTIONS_PER_RUN) {
      throw new Error(`Simulation can record at most ${MAX_ASSERTIONS_PER_RUN} assertions`);
    }
    const boundedName = boundedEventMessage(name);
    const boundedMessage = message === undefined ? undefined : boundedEventMessage(message);
    const assertion: AssertionResult = {
      id: `assert-${run.assertions.length + 1}`,
      name: boundedName,
      passed,
      ...(boundedMessage ? { message: boundedMessage } : {}),
      timestamp: timestamp()
    };
    run.assertions.push(cloneValue(assertion));
    this.emit(run, {
      type: "assertion",
      level: passed ? "info" : "error",
      assertion: cloneValue(assertion),
      message: `${passed ? "PASS" : "FAIL"} ${boundedName}${boundedMessage ? `: ${boundedMessage}` : ""}`
    });
    return cloneValue(assertion);
  }

  private emit(run: RunRecord, details: RunEventDetails): void {
    if ("data" in details && details.data !== undefined) assertEventJSONValue(details.data);
    const event: RunEvent = {
      sequence: jsonNumber(++run.sequence),
      runId: run.id,
      timestamp: timestamp(),
      ...details,
      message: boundedEventMessage(details.message)
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
    updatedAt: run.events.at(-1)?.timestamp ?? run.finishedAt ?? run.startedAt,
    inputs: wireInputs(run.inputs),
    ...(run.jsonInput === undefined ? {} : { jsonInput: cloneValue(run.jsonInput) }),
    createdResources: cloneValue(run.createdResources),
    assertions: cloneValue(run.assertions),
    cleaned: run.cleaned,
    ...(run.cleanupError || run.lastError ? { lastError: run.cleanupError ?? run.lastError } : {})
  };
}

function wireInputs(inputs: Record<string, string | number | boolean>): Record<string, string | JSONNumber | boolean> {
  return Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => [key, typeof value === "number" ? jsonNumber(value) : value])
  );
}

function trimEvents(run: RunRecord): void {
  const overflow = run.events.length - MAX_EVENTS_PER_RUN;
  if (overflow > 0) run.events.splice(0, overflow);
  while (eventHistoryBytes(run.events) > MAX_EVENT_HISTORY_BYTES_PER_RUN && run.events.length > 1) {
    run.events.shift();
  }
}

function eventHistoryBytes(events: RunEvent[]): number {
  return events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8"), 0);
}

function assertEventJSONValue(value: unknown, depth = 0, state = { nodes: 0, stringBytes: 0 }): void {
  state.nodes += 1;
  if (state.nodes > MAX_EVENT_DATA_NODES) {
    throw new Error(`Run event data must contain at most ${MAX_EVENT_DATA_NODES} values`);
  }
  if (depth > MAX_EVENT_DATA_DEPTH) {
    throw new Error(`Run event data must be nested at most ${MAX_EVENT_DATA_DEPTH} levels`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    addEventDataStringBytes(value, state);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Run event data must contain only finite numbers");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertEventJSONValue(item, depth + 1, state);
    return;
  }
  if (typeof value !== "object") {
    throw new Error("Run event data must contain only JSON values");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Run event data must contain only JSON objects");
  }
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const item = record[key];
    addEventDataStringBytes(key, state);
    assertEventJSONValue(item, depth + 1, state);
  }
}

function addEventDataStringBytes(value: string, state: { stringBytes: number }): void {
  state.stringBytes += Buffer.byteLength(value, "utf8");
  if (state.stringBytes > MAX_EVENT_DATA_STRING_BYTES) {
    throw new Error(`Run event data strings must total at most ${MAX_EVENT_DATA_STRING_BYTES} bytes`);
  }
}

function boundedEventMessage(message: string): string {
  if (Buffer.byteLength(message, "utf8") <= MAX_EVENT_DATA_STRING_BYTES) return message;
  const budget = MAX_EVENT_DATA_STRING_BYTES - Buffer.byteLength(EVENT_MESSAGE_TRUNCATION_SUFFIX, "utf8");
  let bytes = 0;
  let result = "";
  for (const char of message) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > budget) break;
    bytes += charBytes;
    result += char;
  }
  return `${result}${EVENT_MESSAGE_TRUNCATION_SUFFIX}`;
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

function stopClientSync(client: AtlasClientLike): unknown {
  try {
    client.sync.stop();
    return undefined;
  } catch (error) {
    return error;
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
  try {
    return boundedEventMessage(error instanceof Error ? error.message : String(error));
  } catch {
    return "Unknown error";
  }
}
