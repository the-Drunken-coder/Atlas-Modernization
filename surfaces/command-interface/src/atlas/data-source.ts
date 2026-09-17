import {
  type AtlasClient,
  type AtlasWatchEvent,
  type CommandCatalog,
  type CommandDefinition,
  type EntityResource,
  isAtlasAPIError,
  isAtlasTransportError,
  type JSONValue,
  type TaskResource
} from "@the-drunken-coder/atlas-sdk";
import type { AppConfig } from "../app/config.js";
import { createAuthenticatedAtlasClient } from "../auth/atlas.js";
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

export type TaskCancellation = {
  taskId: string;
  signal?: AbortSignal;
};

export type ConnectionError = { source: "startup" | "live-sync"; message: string };
export type ConnectionHealth = { running: boolean; healthy: boolean; degraded: boolean; error?: ConnectionError };

export type MovementHistoryReader = Pick<AtlasClient["entities"], "history" | "trail" | "inspectMovement">;

export interface AtlasDataSource {
  movement?: MovementHistoryReader;
  snapshot(): AtlasSnapshot;
  loadCommandCatalog(): Promise<CommandCatalog>;
  loadEntityDetails?(entityId: string, signal?: AbortSignal): Promise<EntityResource>;
  watch(onSnapshot: (snapshot: AtlasSnapshot) => void): () => void;
  start(): Promise<void>;
  submitCommand(submission: CommandSubmission): Promise<TaskResource>;
  cancelTask?(cancellation: TaskCancellation): Promise<TaskResource>;
  createGeofeature(entityId: string, name: string, geometry: UiGeometry): Promise<EntityResource>;
  canDeleteGeofeature?(entityId: string, instanceId: string): boolean;
  deleteGeofeature?(entityId: string, instanceId: string): Promise<void>;
  updateGeometry(entityId: string, geometry: UiGeometry, ifMatchVersion?: number): Promise<EntityResource>;
  health?(): ConnectionHealth;
  dispose(): void;
}

/** The real data source: an Atlas SDK client pointed directly at Atlas Core. */
export function createSdkDataSource(config: AppConfig): AtlasDataSource {
  const client = createAuthenticatedAtlasClient(config.atlasBaseUrl, {
    sync: "all",
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
  const geofeatureTokens = new Map<string, GeofeatureInstanceToken>();
  const pendingGeofeatureCreations = new Map<string, PendingGeofeatureCreation>();
  const tokenFor = (entityId: string): GeofeatureInstanceToken | undefined => {
    const cached = geofeatureTokens.get(entityId);
    if (cached) return cached;
    const stored = readGeofeatureToken(config.atlasBaseUrl, entityId);
    if (stored) geofeatureTokens.set(entityId, stored);
    return stored;
  };

  return {
    snapshot,
    movement: client.entities,

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
          if (runtimeManifestChange) {
            runtimeManifestVersions = {
              ...runtimeManifestVersions,
              [runtimeManifestChange.id]: runtimeManifestChange.version
            };
            return;
          }
          if (event.event === "delete" && event.resource_type === "entity") {
            runtimeManifestVersions = removeRuntimeManifestVersion(event.id, runtimeManifestVersions);
          }
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

    cancelTask: (cancellation) =>
      client.tasks.cancel(cancellation.taskId, {
        cancellation: { code: "requested", message: "Operator cancelled the Task." },
        signal: cancellation.signal
      }),

    async createGeofeature(entityId, name, geometry) {
      const pending = pendingGeofeatureCreations.get(entityId);
      const instanceToken =
        pending && pending.name === name && sameGeometry(pending.geometry, geometry)
          ? pending.token
          : crypto.randomUUID();
      pendingGeofeatureCreations.set(entityId, { name, geometry, token: instanceToken });
      try {
        const created = await client.entities.create(
          {
            entity_id: entityId,
            entity_type: "geofeature",
            alias: name,
            components: { geometry }
          },
          { instanceToken }
        );
        pendingGeofeatureCreations.delete(entityId);
        retainGeofeatureToken(config.atlasBaseUrl, created.entity_id, {
          instanceId: created.metadata.created_at,
          token: instanceToken
        });
        geofeatureTokens.set(created.entity_id, { instanceId: created.metadata.created_at, token: instanceToken });
        return created;
      } catch (cause) {
        if (
          !isAtlasTransportError(cause) &&
          !(isAtlasAPIError(cause) && (cause.status === 409 || cause.status >= 500))
        ) {
          pendingGeofeatureCreations.delete(entityId);
          throw cause;
        }
        // A committed POST can lose its response. Recover only the exact draft,
        // including on a same-ID retry; a different entity remains a conflict.
        const existing = await client.entities.get(entityId, { fresh: true }).catch(() => undefined);
        if (
          existing?.entity_id === entityId &&
          existing.entity_type === "geofeature" &&
          existing.alias === name &&
          sameGeometry(existing.components.geometry, geometry)
        ) {
          const retained = { instanceId: existing.metadata.created_at, token: instanceToken };
          pendingGeofeatureCreations.delete(entityId);
          retainGeofeatureToken(config.atlasBaseUrl, entityId, retained);
          geofeatureTokens.set(entityId, retained);
          return existing;
        }
        if (existing) pendingGeofeatureCreations.delete(entityId);
        throw cause;
      }
    },

    canDeleteGeofeature(entityId, instanceId) {
      return tokenFor(entityId)?.instanceId === instanceId;
    },

    async deleteGeofeature(entityId, instanceId) {
      const retained = tokenFor(entityId);
      if (!retained || retained.instanceId !== instanceId) throw new Error("Geo Feature deletion is unavailable");
      try {
        await client.entities.delete(entityId, { instanceToken: retained.token });
      } catch (cause) {
        if (!isAtlasTransportError(cause) && !(isAtlasAPIError(cause) && cause.status >= 500)) throw cause;

        try {
          await client.entities.get(entityId, { fresh: true });
        } catch (recoveryCause) {
          if (
            isAtlasAPIError(recoveryCause) &&
            recoveryCause.status === 404 &&
            recoveryCause.errorCode === "ENTITY_NOT_FOUND"
          ) {
            forgetGeofeatureToken(config.atlasBaseUrl, entityId);
            geofeatureTokens.delete(entityId);
            return;
          }
        }
        throw cause;
      }
      forgetGeofeatureToken(config.atlasBaseUrl, entityId);
      geofeatureTokens.delete(entityId);
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

type GeofeatureInstanceToken = { instanceId: string; token: string };
type PendingGeofeatureCreation = { name: string; geometry: UiGeometry; token: string };

function geofeatureTokenKey(baseUrl: string, entityId: string): string {
  return `atlas:geofeature-instance:${baseUrl}:${entityId}`;
}

function readGeofeatureToken(baseUrl: string, entityId: string): GeofeatureInstanceToken | undefined {
  try {
    const stored = globalThis.localStorage?.getItem(geofeatureTokenKey(baseUrl, entityId));
    if (!stored) return undefined;
    const value: unknown = JSON.parse(stored);
    if (
      !value ||
      typeof value !== "object" ||
      !("instanceId" in value) ||
      typeof value.instanceId !== "string" ||
      !("token" in value) ||
      typeof value.token !== "string"
    )
      return undefined;
    return { instanceId: value.instanceId, token: value.token };
  } catch {
    return undefined;
  }
}

function retainGeofeatureToken(baseUrl: string, entityId: string, value: GeofeatureInstanceToken): void {
  try {
    globalThis.localStorage?.setItem(geofeatureTokenKey(baseUrl, entityId), JSON.stringify(value));
  } catch {
    // In-memory retention still protects deletes for this data-source lifetime.
  }
}

function forgetGeofeatureToken(baseUrl: string, entityId: string): void {
  try {
    globalThis.localStorage?.removeItem(geofeatureTokenKey(baseUrl, entityId));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}
function runtimeManifestChangeVersion(event: AtlasWatchEvent): { id: string; version: number } | undefined {
  if (event.event !== "update" || event.resource_type !== "entity") return undefined;
  return event.change_reason === "runtime_manifest_changed" ? { id: event.id, version: event.version } : undefined;
}

function removeRuntimeManifestVersion(
  id: string,
  current: Readonly<Record<string, number>> | undefined
): Readonly<Record<string, number>> | undefined {
  if (!current || !Object.hasOwn(current, id)) return current;
  const { [id]: _removed, ...remaining } = current;
  return Object.keys(remaining).length === 0 ? undefined : remaining;
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

function sameGeometry(actual: UiGeometry | undefined, expected: UiGeometry): boolean {
  if (!actual || actual.type !== expected.type) return false;
  if (actual.type === "Feature" && expected.type === "Feature") {
    return (
      actual.properties.shape === expected.properties.shape &&
      actual.properties.radius_m === expected.properties.radius_m &&
      JSON.stringify(actual.geometry.coordinates) === JSON.stringify(expected.geometry.coordinates)
    );
  }
  return (
    actual.type !== "Feature" &&
    expected.type !== "Feature" &&
    JSON.stringify(actual.coordinates) === JSON.stringify(expected.coordinates)
  );
}
