import type { CreatedResource } from "../shared/types.js";
import type { AtlasClientLike } from "./atlas.js";
import { CLEANUP_DELETE_TIMEOUT_MS } from "./run-store-limits.js";
import type { CleanupResource, RunRecord } from "./run-store-types.js";

export function cleanupResourcesForRun(run: RunRecord): CleanupResource[] {
  const resources = run.overflowCleanupResource
    ? [...run.cleanupResources, run.overflowCleanupResource]
    : run.cleanupResources;
  return resources.filter((resource) => resource.type !== "task");
}

export function hasResource(resources: CreatedResource[], resource: CreatedResource): boolean {
  return resources.some((current) => sameResource(current, resource));
}

export function sameResource(left: CreatedResource | undefined, right: CreatedResource): boolean {
  return left?.type === right.type && left.id === right.id;
}

export async function withCleanupTimeout(
  operation: Promise<void>,
  controller: AbortController,
  resource: CreatedResource,
  timeoutMs = CLEANUP_DELETE_TIMEOUT_MS
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`Timed out deleting ${resource.type} ${resource.id}`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function cleanupOrder(resources: CleanupResource[]): CleanupResource[] {
  const order: Record<CreatedResource["type"], number> = { object: 0, entity: 1, task: 2 };
  return [...resources].reverse().sort((a, b) => (order[a.type] ?? 3) - (order[b.type] ?? 3));
}

export function stopClientSync(client: AtlasClientLike): unknown {
  try {
    client.sync.stop();
    return undefined;
  } catch (error) {
    return error;
  }
}
