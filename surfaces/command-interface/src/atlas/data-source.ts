import {
  AtlasClient,
  type AtlasWatchEvent,
  type CommandCatalog,
  type CommandDefinition,
  type EntityResource,
  type JSONValue,
  type TaskResource
} from "@the-drunken-coder/atlas-sdk";
import type { AppConfig } from "../app/config.js";
import { sanitizeConnectionError } from "./connection-error.js";
import type { UiGeometry } from "./geometry.js";
import type { AtlasSnapshot } from "./store.js";

export type CommandSubmission = {
  assetId: string;
  command: CommandDefinition;
  input: JSONValue;
  idempotencyKey: string;
  signal?: AbortSignal;
};

export type ConnectionError = { source: "startup" | "live-sync"; message: string };
export type ConnectionHealth = { running: boolean; healthy: boolean; degraded: boolean; error?: ConnectionError };

export interface AtlasDataSource {
  snapshot(): AtlasSnapshot;
  loadCommandCatalog(): Promise<CommandCatalog>;
  loadEntityDetails?(entityId: string, signal?: AbortSignal): Promise<EntityResource>;
  watch(onSnapshot: (snapshot: AtlasSnapshot) => void): () => void;
  start(): Promise<void>;
  submitCommand(submission: CommandSubmission): Promise<TaskResource>;
  updateGeometry(entityId: string, geometry: UiGeometry, ifMatchVersion?: number): Promise<EntityResource>;
  health?(): ConnectionHealth;
  dispose(): void;
}

/** The real data source: an Atlas SDK client pointed directly at Atlas Core. */
export function createSdkDataSource(config: AppConfig): AtlasDataSource {
  const client = new AtlasClient({
    baseUrl: config.atlasBaseUrl,
    credentials: "include",
    sync: "all",
    fetch: atlasFetch,
    WebSocket: globalThis.WebSocket
  });
  let runtimeManifestVersions: Readonly<Record<string, number>> | undefined;
  let started = false;
  const snapshot = (): AtlasSnapshot => {
    const { entities, tasks } = client.sync.snapshot();
    return {
      entities,
      tasks,
      ...(runtimeManifestVersions ? { runtimeManifestVersions } : {})
    };
  };
  let startupGeneration = 0;
  let startupError: ConnectionError | undefined;

  return {
    snapshot,

    loadCommandCatalog: () => client.commandCatalog(),

    loadEntityDetails: (entityId, signal) => client.entities.get(entityId, { fresh: true, signal }),

    watch(onSnapshot) {
      let previous = client.sync.snapshot();
      let previousSyncVersion = client.sync.status().lastVersion;
      let rawEntityEventObserved = false;
      // SyncEngine delivers raw event watchers before snapshot watchers. Keep
      // that ordering so a runtime signal is part of the snapshot that carries
      // the corresponding Entity update.
      const unsubscribeRuntimeManifestEvents = client.watch(
        { filter: "type", resource_type: "entity" },
        (_resource, event) => {
          rawEntityEventObserved = true;
          const runtimeManifestChange = runtimeManifestChangeVersion(event);
          if (!runtimeManifestChange) return;
          runtimeManifestVersions = {
            ...runtimeManifestVersions,
            [runtimeManifestChange.id]: runtimeManifestChange.version
          };
        }
      );
      const unsubscribeSnapshot = client.sync.watchSnapshot((next) => {
        const syncVersion = client.sync.status().lastVersion;
        if (started && syncVersion > previousSyncVersion && !rawEntityEventObserved) {
          runtimeManifestVersions = runtimeManifestVersionsAfterHydration(
            previous.entities,
            next.entities,
            runtimeManifestVersions
          );
        }
        previousSyncVersion = syncVersion;
        rawEntityEventObserved = false;
        if (next.entities === previous.entities && next.tasks === previous.tasks) return;
        previous = next;
        onSnapshot({
          entities: next.entities,
          tasks: next.tasks,
          ...(runtimeManifestVersions ? { runtimeManifestVersions } : {})
        });
      });
      return () => {
        unsubscribeRuntimeManifestEvents();
        unsubscribeSnapshot();
      };
    },

    async start() {
      const generation = ++startupGeneration;
      startupError = undefined;
      runtimeManifestVersions = undefined;
      try {
        await client.sync.start();
        started = true;
      } catch (cause) {
        if (generation === startupGeneration) {
          startupError = { source: "startup", message: sanitizeConnectionError(cause) };
        }
        throw cause;
      }
    },

    health() {
      const status = client.sync.status();
      const error =
        startupError ??
        (status.error ? { source: "live-sync" as const, message: sanitizeConnectionError(status.error) } : undefined);
      return {
        running: status.running,
        healthy: status.healthy,
        degraded: status.degraded,
        ...(error ? { error } : {})
      };
    },

    async submitCommand(submission) {
      return client.tasks.create(
        { asset_id: submission.assetId, command: submission.command.command, input: submission.input },
        {
          idempotencyKey: submission.idempotencyKey,
          signal: submission.signal
        }
      );
    },

    async updateGeometry(entityId, geometry, ifMatchVersion) {
      return client.entities.update(
        entityId,
        { components: { geometry } },
        ifMatchVersion === undefined ? undefined : { ifMatchVersion }
      );
    },

    dispose() {
      startupGeneration++;
      started = false;
      runtimeManifestVersions = undefined;
      client.sync.stop();
      startupError = undefined;
    }
  };
}

function runtimeManifestChangeVersion(event: AtlasWatchEvent): { id: string; version: number } | undefined {
  if (event.event !== "update" || event.resource_type !== "entity") return undefined;
  return event.change_reason === "runtime_manifest_changed" ? { id: event.id, version: event.version } : undefined;
}

function runtimeManifestVersionsAfterHydration(
  previousEntities: Readonly<Record<string, EntityResource>>,
  hydratedEntities: Readonly<Record<string, EntityResource>>,
  current: Readonly<Record<string, number>> | undefined
): Readonly<Record<string, number>> | undefined {
  const changedEntities = Object.entries(hydratedEntities).filter(
    ([id, entity]) => previousEntities[id]?.metadata.version !== entity.metadata.version
  );
  if (changedEntities.length === 0) return current;
  return {
    ...current,
    ...Object.fromEntries(changedEntities.map(([id, entity]) => [id, entity.metadata.version]))
  };
}

async function atlasFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, credentials: "include" });
  if (response.status === 401 && typeof window !== "undefined" && (await isCoreSessionExpired(response.clone()))) {
    window.dispatchEvent(new Event("atlas-auth-expired"));
  }
  return response;
}

async function isCoreSessionExpired(response: Response): Promise<boolean> {
  try {
    const payload = await response.json();
    return isRecord(payload) && payload.error_code === "UNAUTHORIZED";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
