import type { ExecutionModule } from "./execution-module.js";

export class SafetyBarrierError extends Error {
  readonly moduleIds: readonly string[];

  constructor(moduleIds: readonly string[]) {
    super(`Failed to establish safe state for execution modules: ${moduleIds.join(", ")}`);
    this.name = "SafetyBarrierError";
    this.moduleIds = moduleIds;
  }
}

export async function establishSafetyBarrier(modules: readonly ExecutionModule[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const results = await Promise.allSettled(
    modules.map(async (module) => {
      await module.establishSafeState({ signal });
      signal.throwIfAborted();
    })
  );
  signal.throwIfAborted();
  const failed = results.flatMap((result, index) => (result.status === "rejected" ? [modules[index].id] : []));
  if (failed.length > 0) throw new SafetyBarrierError(failed);
}
