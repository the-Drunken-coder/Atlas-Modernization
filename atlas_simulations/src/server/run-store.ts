import {
  type AssertionResult,
  type CreatedResource,
  jsonNumber,
  type RunEvent,
  type RunEventDetails,
  type RunStatus,
  type RunSummary
} from "../shared/types.js";
import type { AtlasClientFactory, AtlasClientLike } from "./atlas.js";
import { isNotFoundError } from "./atlas.js";
import type { CleanupLedgerRecord, CleanupLedgerStore, CleanupLedgerTarget } from "./cleanup-ledger.js";
import {
  assertEventJSONValue,
  assertionBytes,
  boundedAssertionText,
  boundedEventMessage,
  errorMessage,
  eventBytes,
  hasFailedAssertions,
  lateAssertion,
  trimEvents
} from "./run-store-events.js";
import {
  CLEANUP_DELETE_TIMEOUT_MS,
  CLEANUP_TOTAL_TIMEOUT_MS,
  MAX_ASSERTION_HISTORY_BYTES_PER_RUN,
  MAX_ASSERTIONS_PER_RUN,
  MAX_CREATED_RESOURCES_PER_RUN,
  MAX_EVENT_HISTORY_BYTES_PER_RUN,
  MAX_RUNS
} from "./run-store-limits.js";
import {
  cleanupOrder,
  cleanupResourcesForRun,
  hasResource,
  sameResource,
  stopClientSync,
  withCleanupTimeout
} from "./run-store-resources.js";
import { targetSummary, toSummary } from "./run-store-summary.js";
import {
  cloneValue,
  type EventSubscriber,
  type RunRecord,
  type RunTarget,
  runId,
  timestamp
} from "./run-store-types.js";
import { createScenarioContext, type Scenario, type ScenarioInput } from "./scenario.js";

export type { RunTarget } from "./run-store-types.js";

export type RunStoreOptions = {
  ledger?: CleanupLedgerStore;
  resolveTarget?: (target: CleanupLedgerTarget) => RunTarget | undefined;
};

const ABANDONED_RUN_MESSAGE = "Workbench restarted before explicit cleanup; this deployed run was abandoned";

export class RunStore {
  private readonly runs = new Map<string, RunRecord>();

  constructor(
    private readonly clientFactory: AtlasClientFactory,
    private readonly options: RunStoreOptions = {}
  ) {
    for (const record of options.ledger?.load() ?? []) this.recover(record);
  }

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

  start(scenario: Readonly<Scenario>, input: ScenarioInput, target?: RunTarget): RunSummary {
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
      scenario: { id: scenario.id, name: scenario.name },
      ...(target ? { target: targetSummary(target) } : {}),
      clientFactory: target?.clientFactory ?? this.clientFactory,
      status: "running",
      startedAt: now,
      inputs: cloneValue(runInput.fields),
      ...(runInput.json === undefined ? {} : { jsonInput: cloneValue(runInput.json) }),
      createdResources: [],
      cleanupResources: [],
      assertions: [],
      assertionHistoryBytes: 0,
      events: [],
      eventHistoryBytes: 0,
      subscribers: new Set(),
      controller: new AbortController(),
      clients: [],
      settled: false,
      cleanupStarted: false,
      cleaned: false,
      sequence: 0
    };
    this.runs.set(id, run);
    this.emit(run, { type: "status", status: "running", message: `${scenario.name} started` });
    try {
      this.persist(run);
    } catch (error) {
      this.runs.delete(id);
      throw error;
    }
    run.execution = this.execute(run, scenario, runInput);
    return toSummary(run);
  }

  stop(id: string): RunSummary {
    const run = this.requireRun(id);
    if (run.status === "running" && !run.controller.signal.aborted) {
      run.controller.abort();
      this.emit(run, { type: "log", level: "warn", message: "Stop requested" });
      this.finish(run, "cancelled", "Stop requested");
    }
    return toSummary(run);
  }

  async cleanup(id: string, clientFactoryOverride?: AtlasClientFactory): Promise<RunSummary> {
    const run = this.requireRun(id);
    if (run.cleaned) return toSummary(run);
    if (run.status === "running") {
      throw new Error("Wait for the run to finish before cleanup");
    }
    if (!run.settled) await run.execution;
    if (!run.settled) throw new Error("Wait for the run to finish before cleanup");
    if (run.cleanupPromise !== undefined) return run.cleanupPromise;
    run.cleanupPromise = this.performCleanup(run, clientFactoryOverride);
    try {
      return await run.cleanupPromise;
    } finally {
      run.cleanupPromise = undefined;
    }
  }

  private async performCleanup(run: RunRecord, clientFactoryOverride?: AtlasClientFactory): Promise<RunSummary> {
    run.cleanupStarted = true;
    const cleanupResources = cleanupResourcesForRun(run);
    if (cleanupResources.length === 0) {
      return this.finishCleanup(run);
    }

    let client: AtlasClientLike;
    const cleanupController = new AbortController();
    try {
      client = (clientFactoryOverride ?? run.clientFactory)({ sync: false, signal: cleanupController.signal });
    } catch (error) {
      run.cleanupError = errorMessage(error);
      this.emit(run, { type: "error", level: "error", message: run.cleanupError });
      throw error;
    }
    let cleanupFailure: unknown;
    const cleanupDeadline = Date.now() + CLEANUP_TOTAL_TIMEOUT_MS;
    for (const resource of cleanupOrder(cleanupResources)) {
      try {
        const remainingCleanupMs = cleanupDeadline - Date.now();
        if (remainingCleanupMs <= 0) {
          throw new Error(`Timed out cleaning up run resources after ${CLEANUP_TOTAL_TIMEOUT_MS}ms`);
        }
        const timeoutMs = Math.min(CLEANUP_DELETE_TIMEOUT_MS, remainingCleanupMs);
        const resourceType = resource.type as string;
        if (resourceType === "task") {
          await withCleanupTimeout(client.tasks.delete(resource.id), cleanupController, resource, timeoutMs);
        } else if (resourceType === "object") {
          await withCleanupTimeout(client.objects.delete(resource.id), cleanupController, resource, timeoutMs);
        } else if (resourceType === "entity") {
          await withCleanupTimeout(client.entities.delete(resource.id), cleanupController, resource, timeoutMs);
        } else {
          throw new Error(`Unsupported cleanup resource type: ${resourceType}`);
        }
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
    return this.finishCleanup(run);
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
    if (run.cleaned) return () => undefined;
    // Completed runs can still emit cleanup events after an explicit cleanup request.
    run.subscribers.add(subscriber);
    return () => run.subscribers.delete(subscriber);
  }

  private async execute(run: RunRecord, scenario: Readonly<Scenario>, input: ScenarioInput): Promise<void> {
    let finalStatus: RunStatus = "completed";
    let finalMessage = "Run completed";
    let finalError: string | undefined;
    try {
      const registerClient = (client: AtlasClientLike) => run.clients.push(client);
      const context = createScenarioContext({
        runId: run.id,
        signal: run.controller.signal,
        clientFactory: run.clientFactory,
        registerClient,
        log: (message, data) => {
          if (!run.settled) this.emit(run, { type: "log", message, data });
        },
        assert: (name, passed, message) =>
          run.settled ? lateAssertion(name, passed, message) : this.assert(run, name, passed, message),
        track: (resource) => {
          if (!run.settled && !run.cleanupStarted && !run.cleaned) this.track(run, resource);
        },
        trackCleanupCandidate: (resource) => {
          if (!run.settled && !run.cleanupStarted && !run.cleaned) this.trackCleanupCandidate(run, resource);
        },
        allowGeneratedTaskIds: !run.target?.deployed
      });
      await scenario.run(context, input);
      if (run.controller.signal.aborted) {
        finalStatus = "cancelled";
        finalMessage = "Run cancelled";
      } else if (run.trackingError) {
        finalStatus = "failed";
        finalMessage = run.trackingError;
        run.lastError = run.trackingError;
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
      if (!run.controller.signal.aborted) run.controller.abort(new Error("Simulation finished"));
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
    run.subscribers.clear();
  }

  private track(run: RunRecord, resource: CreatedResource): void {
    if (run.cleanupStarted || run.cleaned) return;
    this.trackCleanupCandidate(run, resource);
    const tracked = cloneValue(resource);
    if (!hasResource(run.createdResources, tracked)) {
      if (run.createdResources.length >= MAX_CREATED_RESOURCES_PER_RUN) return;
      run.createdResources.push(cloneValue(tracked));
      this.emit(run, { type: "resource", resource: tracked, message: `Created ${tracked.type} ${tracked.id}` });
    }
  }

  private trackCleanupCandidate(run: RunRecord, resource: CreatedResource): void {
    if (run.cleanupStarted || run.cleaned) return;
    const tracked = cloneValue(resource);
    if (!hasResource(run.cleanupResources, tracked) && !sameResource(run.overflowCleanupResource, tracked)) {
      if (run.cleanupResources.length >= MAX_CREATED_RESOURCES_PER_RUN) {
        if (!run.overflowCleanupResource) {
          run.overflowCleanupResource = cloneValue(tracked);
          this.persist(run);
        }
        const message = `Simulation can track at most ${MAX_CREATED_RESOURCES_PER_RUN} created resources`;
        run.trackingError = message;
        run.lastError = message;
        throw new Error(message);
      }
      run.cleanupResources.push(cloneValue(tracked));
      this.persist(run);
    }
  }

  private finishCleanup(run: RunRecord): RunSummary {
    try {
      if (run.target?.deployed) {
        if (!this.options.ledger) throw new Error("Deployed simulations require a durable cleanup ledger");
        this.options.ledger.remove(run.id);
      }
    } catch (error) {
      run.cleanupError = errorMessage(error);
      this.emit(run, { type: "error", level: "error", message: run.cleanupError });
      throw error;
    }
    run.cleaned = true;
    run.cleanupError = undefined;
    this.emit(run, { type: "cleanup", message: "Cleanup complete" });
    run.subscribers.clear();
    this.pruneRuns();
    return toSummary(run);
  }

  private persist(run: RunRecord): void {
    if (!run.target?.deployed || run.cleaned) return;
    if (!this.options.ledger) throw new Error("Deployed simulations require a durable cleanup ledger");
    this.options.ledger.save({
      runId: run.id,
      scenarioId: run.scenario.id,
      scenarioName: run.scenario.name,
      startedAt: run.startedAt,
      target: {
        id: run.target.id,
        label: run.target.label,
        baseUrl: run.target.baseUrl
      },
      resources: cloneValue(cleanupResourcesForRun(run))
    });
  }

  private recover(record: CleanupLedgerRecord): void {
    const target = this.options.resolveTarget?.(cloneValue(record.target));
    if (!target?.clientFactory)
      throw new Error(`Cleanup ledger run ${record.runId} has no recoverable deployed target`);
    if (!target.deployed || target.id !== record.target.id || target.baseUrl !== record.target.baseUrl) {
      throw new Error(`Cleanup ledger run ${record.runId} no longer matches its deployed target`);
    }
    const now = timestamp();
    const controller = new AbortController();
    controller.abort(new Error(ABANDONED_RUN_MESSAGE));
    const cleanupResources = cloneValue(record.resources.slice(0, MAX_CREATED_RESOURCES_PER_RUN));
    const overflowCleanupResource = record.resources[MAX_CREATED_RESOURCES_PER_RUN];
    const run: RunRecord = {
      id: record.runId,
      scenario: { id: record.scenarioId, name: record.scenarioName },
      target: {
        id: record.target.id,
        label: record.target.label,
        baseUrl: record.target.baseUrl,
        deployed: true,
        apiKeyConfigured: target.apiKeyConfigured
      },
      clientFactory: target.clientFactory,
      status: "abandoned",
      startedAt: record.startedAt,
      finishedAt: now,
      inputs: {},
      createdResources: cloneValue(cleanupResources),
      cleanupResources,
      ...(overflowCleanupResource ? { overflowCleanupResource: cloneValue(overflowCleanupResource) } : {}),
      assertions: [],
      assertionHistoryBytes: 0,
      events: [],
      eventHistoryBytes: 0,
      subscribers: new Set(),
      controller,
      clients: [],
      settled: true,
      cleanupStarted: false,
      cleaned: false,
      sequence: 0,
      lastError: ABANDONED_RUN_MESSAGE
    };
    this.runs.set(run.id, run);
    this.emit(run, { type: "status", status: "abandoned", level: "warn", message: ABANDONED_RUN_MESSAGE });
  }

  private assert(run: RunRecord, name: string, passed: boolean, message?: string): AssertionResult {
    if (run.assertions.length >= MAX_ASSERTIONS_PER_RUN) {
      throw new Error(`Simulation can record at most ${MAX_ASSERTIONS_PER_RUN} assertions`);
    }
    const boundedName = boundedAssertionText(name);
    const boundedMessage = message === undefined ? undefined : boundedAssertionText(message);
    const assertion: AssertionResult = {
      id: `assert-${run.assertions.length + 1}`,
      name: boundedName,
      passed,
      ...(boundedMessage ? { message: boundedMessage } : {}),
      timestamp: timestamp()
    };
    const bytes = assertionBytes(assertion);
    if (run.assertionHistoryBytes + bytes > MAX_ASSERTION_HISTORY_BYTES_PER_RUN) {
      throw new Error(`Simulation can store at most ${MAX_ASSERTION_HISTORY_BYTES_PER_RUN} bytes of assertion history`);
    }
    run.assertions.push(cloneValue(assertion));
    run.assertionHistoryBytes += bytes;
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
    const bytes = eventBytes(event);
    if (bytes > MAX_EVENT_HISTORY_BYTES_PER_RUN) {
      throw new Error(`Run event must be at most ${MAX_EVENT_HISTORY_BYTES_PER_RUN} bytes`);
    }
    run.events.push(cloneValue(event));
    run.eventHistoryBytes += bytes;
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
