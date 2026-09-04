import {
  type AssertionResult,
  type CreatedResource,
  jsonNumber,
  type RunEvent,
  type RunEventDetails,
  type RunStatus,
  type RunSummary
} from "../shared/types.js";
import type { AtlasClientFactory } from "./atlas.js";
import { cleanupRun, persistRun, type RunStoreOptions, recoverRun } from "./run-store-cleanup.js";
import {
  assertEventJSONValue,
  assertionBytes,
  boundedAssertionText,
  boundedEventMessage,
  eventBytes,
  trimEvents
} from "./run-store-events.js";
import { executeRun } from "./run-store-execution.js";
import {
  MAX_ASSERTION_HISTORY_BYTES_PER_RUN,
  MAX_ASSERTIONS_PER_RUN,
  MAX_CREATED_RESOURCES_PER_RUN,
  MAX_EVENT_HISTORY_BYTES_PER_RUN,
  MAX_RUNS
} from "./run-store-limits.js";
import { hasResource, sameResource } from "./run-store-resources.js";
import { targetSummary, toSummary } from "./run-store-summary.js";
import {
  cloneValue,
  type EventSubscriber,
  type RunRecord,
  type RunTarget,
  runId,
  timestamp
} from "./run-store-types.js";
import type { Scenario, ScenarioInput } from "./scenario.js";

export type { RunStoreOptions } from "./run-store-cleanup.js";
export type { RunTarget } from "./run-store-types.js";

export class RunStore {
  private readonly runs = new Map<string, RunRecord>();

  constructor(
    private readonly clientFactory: AtlasClientFactory,
    private readonly options: RunStoreOptions = {}
  ) {
    for (const record of options.ledger?.load() ?? []) {
      const run = recoverRun(record, options.resolveTarget);
      this.runs.set(run.id, run);
      this.emit(run, { type: "status", status: "abandoned", level: "warn", message: run.lastError! });
    }
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
      persistRun(run, this.options);
    } catch (error) {
      this.runs.delete(id);
      throw error;
    }
    run.execution = executeRun(run, scenario, runInput, {
      emit: this.emit.bind(this),
      assert: this.assert.bind(this),
      track: this.track.bind(this),
      trackCleanupCandidate: this.trackCleanupCandidate.bind(this),
      untrackCleanupCandidate: this.untrackCleanupCandidate.bind(this),
      finish: this.finish.bind(this),
      prune: this.pruneRuns.bind(this)
    });
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
    run.cleanupPromise = cleanupRun(
      run,
      this.options,
      clientFactoryOverride,
      this.emit.bind(this),
      this.pruneRuns.bind(this)
    );
    try {
      return await run.cleanupPromise;
    } finally {
      run.cleanupPromise = undefined;
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
    if (run.cleaned) return () => undefined;
    // Completed runs can still emit cleanup events after an explicit cleanup request.
    run.subscribers.add(subscriber);
    return () => run.subscribers.delete(subscriber);
  }

  private finish(run: RunRecord, status: RunStatus, message: string): void {
    if (run.status !== "running") return;
    run.status = status;
    run.finishedAt = timestamp();
    this.emit(run, { type: "status", status, message });
    run.subscribers.clear();
  }

  private track(run: RunRecord, resource: CreatedResource, instanceToken?: string): void {
    if (run.cleanupStarted || run.cleaned) return;
    if (resource.type !== "task") {
      if (!instanceToken) throw new Error(`${resource.type} tracking requires an instance token`);
      this.trackCleanupCandidate(run, { ...resource, instanceToken });
    }
    const tracked = cloneValue(resource);
    if (!hasResource(run.createdResources, tracked)) {
      if (run.createdResources.length >= MAX_CREATED_RESOURCES_PER_RUN) return;
      run.createdResources.push(cloneValue(tracked));
      this.emit(run, { type: "resource", resource: tracked, message: `Created ${tracked.type} ${tracked.id}` });
    }
  }

  private trackCleanupCandidate(run: RunRecord, resource: RunRecord["cleanupResources"][number]): void {
    if (run.cleanupStarted || run.cleaned) return;
    const tracked = cloneValue(resource);
    if (!hasResource(run.cleanupResources, tracked) && !sameResource(run.overflowCleanupResource, tracked)) {
      if (run.cleanupResources.length >= MAX_CREATED_RESOURCES_PER_RUN) {
        if (!run.overflowCleanupResource) {
          const overflowCleanupResource = cloneValue(tracked);
          persistRun({ ...run, overflowCleanupResource }, this.options);
          run.overflowCleanupResource = overflowCleanupResource;
        }
        const message = `Simulation can track at most ${MAX_CREATED_RESOURCES_PER_RUN} created resources`;
        run.trackingError = message;
        run.lastError = message;
        throw new Error(message);
      }
      const cleanupResources = [...run.cleanupResources, cloneValue(tracked)];
      persistRun({ ...run, cleanupResources }, this.options);
      run.cleanupResources = cleanupResources;
    }
  }

  private untrackCleanupCandidate(run: RunRecord, resource: CreatedResource): void {
    if (run.cleanupStarted || run.cleaned) return;
    const index = run.cleanupResources.findIndex((candidate) => sameResource(candidate, resource));
    let changed = index !== -1;
    const cleanupResources = changed
      ? run.cleanupResources.filter((_, candidateIndex) => candidateIndex !== index)
      : run.cleanupResources;
    const overflowCleanupResource = sameResource(run.overflowCleanupResource, resource)
      ? undefined
      : run.overflowCleanupResource;
    if (overflowCleanupResource !== run.overflowCleanupResource) {
      changed = true;
    }
    if (changed) {
      persistRun({ ...run, cleanupResources, overflowCleanupResource }, this.options);
      run.cleanupResources = cleanupResources;
      run.overflowCleanupResource = overflowCleanupResource;
    }
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
