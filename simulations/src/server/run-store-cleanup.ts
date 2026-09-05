import type { RunEventDetails, RunSummary } from "../shared/types.js";
import type { AtlasClientFactory, AtlasClientLike } from "./atlas.js";
import { isNotFoundError, isResourceInstanceTokenPreconditionFailure } from "./atlas.js";
import type { CleanupLedgerRecord, CleanupLedgerStore, CleanupLedgerTarget } from "./cleanup-ledger.js";
import { errorMessage } from "./run-store-events.js";
import {
  CLEANUP_DELETE_TIMEOUT_MS,
  CLEANUP_TOTAL_TIMEOUT_MS,
  MAX_CREATED_RESOURCES_PER_RUN
} from "./run-store-limits.js";
import { cleanupOrder, cleanupResourcesForRun, stopClientSync, withCleanupTimeout } from "./run-store-resources.js";
import { toSummary } from "./run-store-summary.js";
import { cloneValue, type RunRecord, type RunTarget, timestamp } from "./run-store-types.js";

const ABANDONED_RUN_MESSAGE = "Workbench restarted before explicit cleanup; this deployed run was abandoned";

export type RunStoreOptions = {
  ledger?: CleanupLedgerStore;
  resolveTarget?: (target: CleanupLedgerTarget) => RunTarget | undefined;
};

type Emit = (run: RunRecord, details: RunEventDetails) => void;

export async function cleanupRun(
  run: RunRecord,
  options: RunStoreOptions,
  clientFactoryOverride: AtlasClientFactory | undefined,
  emit: Emit,
  prune: () => void
): Promise<RunSummary> {
  run.cleanupStarted = true;
  const cleanupResources = cleanupResourcesForRun(run);
  if (cleanupResources.length === 0) return finishCleanup(run, options.ledger, emit, prune);

  let client: AtlasClientLike;
  const cleanupController = new AbortController();
  try {
    client = (clientFactoryOverride ?? run.clientFactory)({ sync: false, signal: cleanupController.signal });
  } catch (error) {
    run.cleanupError = errorMessage(error);
    emit(run, { type: "error", level: "error", message: run.cleanupError });
    throw error;
  }
  let cleanupFailure: unknown;
  const cleanupDeadline = Date.now() + CLEANUP_TOTAL_TIMEOUT_MS;
  for (const resource of cleanupOrder(cleanupResources)) {
    const publicResource = { type: resource.type, id: resource.id } satisfies RunRecord["createdResources"][number];
    try {
      const remainingCleanupMs = cleanupDeadline - Date.now();
      if (remainingCleanupMs <= 0) {
        throw new Error(`Timed out cleaning up run resources after ${CLEANUP_TOTAL_TIMEOUT_MS}ms`);
      }
      const timeoutMs = Math.min(CLEANUP_DELETE_TIMEOUT_MS, remainingCleanupMs);
      if (!resource.instanceToken) {
        throw new Error(`Cleanup resource ${resource.type} ${resource.id} has no instance token`);
      }
      if (resource.type === "object") {
        await withCleanupTimeout(
          client.objects.delete(resource.id, { instanceToken: resource.instanceToken }),
          cleanupController,
          resource,
          timeoutMs
        );
      } else if (resource.type === "entity") {
        await withCleanupTimeout(
          client.entities.delete(resource.id, { instanceToken: resource.instanceToken }),
          cleanupController,
          resource,
          timeoutMs
        );
      } else {
        throw new Error(`Unsupported cleanup resource type: ${resource.type}`);
      }
      emit(run, { type: "cleanup", resource: publicResource, message: `Deleted ${resource.type} ${resource.id}` });
    } catch (error) {
      if (isNotFoundError(error)) {
        emit(run, {
          type: "cleanup",
          resource: publicResource,
          message: `${resource.type} ${resource.id} was already gone`
        });
        continue;
      }
      if (isResourceInstanceTokenPreconditionFailure(error)) {
        emit(run, {
          type: "cleanup",
          resource: publicResource,
          message: `${resource.type} ${resource.id} owned instance is no longer present`
        });
        continue;
      }
      run.cleanupError = errorMessage(error);
      emit(run, { type: "error", level: "error", message: run.cleanupError });
      cleanupFailure = error;
      break;
    }
  }
  const stopFailure = stopClientSync(client);
  if (stopFailure) {
    const message = errorMessage(stopFailure);
    run.cleanupError ??= message;
    emit(run, { type: "error", level: "error", message });
  }
  if (cleanupFailure) throw cleanupFailure;
  if (stopFailure) throw stopFailure;
  return finishCleanup(run, options.ledger, emit, prune);
}

export function persistRun(run: RunRecord, options: RunStoreOptions): void {
  if (!run.target?.deployed || run.cleaned) return;
  if (!options.ledger) throw new Error("Deployed simulations require a durable cleanup ledger");
  options.ledger.save({
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

export function recoverRun(record: CleanupLedgerRecord, resolveTarget?: RunStoreOptions["resolveTarget"]): RunRecord {
  const target = resolveTarget?.(cloneValue(record.target));
  if (!target?.clientFactory) throw new Error(`Cleanup ledger run ${record.runId} has no recoverable deployed target`);
  if (!target.deployed || target.id !== record.target.id || target.baseUrl !== record.target.baseUrl) {
    throw new Error(`Cleanup ledger run ${record.runId} no longer matches its deployed target`);
  }
  const now = timestamp();
  const controller = new AbortController();
  controller.abort(new Error(ABANDONED_RUN_MESSAGE));
  const cleanupResources = cloneValue(record.resources.slice(0, MAX_CREATED_RESOURCES_PER_RUN));
  const overflowCleanupResource = record.resources[MAX_CREATED_RESOURCES_PER_RUN];
  return {
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
    createdResources: cleanupResources.map(({ type, id }) => ({ type, id })),
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
}

function finishCleanup(
  run: RunRecord,
  ledger: CleanupLedgerStore | undefined,
  emit: Emit,
  prune: () => void
): RunSummary {
  try {
    if (run.target?.deployed) {
      if (!ledger) throw new Error("Deployed simulations require a durable cleanup ledger");
      ledger.remove(run.id);
    }
  } catch (error) {
    run.cleanupError = errorMessage(error);
    emit(run, { type: "error", level: "error", message: run.cleanupError });
    throw error;
  }
  run.cleaned = true;
  run.cleanupError = undefined;
  emit(run, { type: "cleanup", message: "Cleanup complete" });
  run.subscribers.clear();
  prune();
  return toSummary(run);
}
