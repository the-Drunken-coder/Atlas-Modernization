import {
  AtlasClient,
  type EntityResource,
  type JSONValue,
  type TaskResource
} from "../../../atlas_sdk/src/index.js";
import type { AppConfig } from "../app/config.js";
import {
  buildCommandTaskRequest,
  catalogFromObject,
  coerceParameters,
  COMMAND_CATALOG_OBJECT_ID,
  type CommandCatalog,
  type CommandDefinition
} from "./command-model.js";
import type { UiGeometry } from "./geometry.js";
import type { AtlasSnapshot } from "./store.js";

export type CommandSubmission = {
  entityId: string;
  command: CommandDefinition;
  parameters?: Record<string, JSONValue>;
};

export type ConnectionHealth = { running: boolean; healthy: boolean; degraded: boolean };

export interface AtlasDataSource {
  snapshot(): AtlasSnapshot;
  loadCommandCatalog(): Promise<CommandCatalog>;
  watch(onSnapshotChange: () => void): () => void;
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
    pollIntervalMs: 0,
    fetch: atlasFetch,
    WebSocket: globalThis.WebSocket
  });

  return {
    snapshot() {
      const snapshot = client.sync.snapshot();
      return { entities: snapshot.entities, tasks: snapshot.tasks };
    },

    async loadCommandCatalog() {
      const object = await client.objects.get(COMMAND_CATALOG_OBJECT_ID, { fresh: true });
      return catalogFromObject(object);
    },

    watch(onSnapshotChange) {
      return client.watch({ filter: "all" }, (_value, event) => {
        if (event.resource_type === "entity" || event.resource_type === "task") onSnapshotChange();
      });
    },

    async start() {
      await client.sync.start();
    },

    health() {
      const status = client.sync.status();
      return { running: status.running, healthy: status.healthy, degraded: status.degraded };
    },

    async submitCommand(submission) {
      const parameters = coerceParameters(submission.command, submission.parameters);
      return client.tasks.create(buildCommandTaskRequest({ entityId: submission.entityId, command: submission.command, parameters }));
    },

    async updateGeometry(entityId, geometry, ifMatchVersion) {
      return client.entities.update(
        entityId,
        { components: { geometry } },
        ifMatchVersion === undefined ? undefined : { ifMatchVersion }
      );
    },

    dispose() {
      client.sync.stop();
    }
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
