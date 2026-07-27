import type { AtlasClient } from "./client.js";
import type { FeedConnectionManager } from "./feed-connection.js";
import type { SyncEngine } from "./sync-engine.js";

/**
 * Internal test seam for SDK tests. Not part of the public API and deliberately not re-exported from the
 * package barrel; tests import this module directly.
 */
export type SyncEngineTestInternals = {
  readonly feed: FeedConnectionManager;
  syncRunning: boolean;
  readonly lifecycleGeneration: number;
  readonly activeRecoveryPromise: Promise<boolean> | undefined;
  changedSinceForGeneration(generation: number, sinceVersion?: number): Promise<boolean>;
  markSynchronized(): void;
};

const engines = new WeakMap<AtlasClient, SyncEngine>();

export function registerSyncEngineForTests(client: AtlasClient, engine: SyncEngine): void {
  engines.set(client, engine);
}

export function syncEngineTestInternals(client: AtlasClient): SyncEngineTestInternals {
  return engines.get(client)!;
}
