import {
  type CommandCatalog,
  type CommandDefinition,
  type EntityResource,
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
  const client = createAuthenticatedAtlasClient(config.atlasBaseUrl, {
    sync: "all",
    WebSocket: globalThis.WebSocket
  });
  const snapshot = (): AtlasSnapshot => {
    const { entities, tasks } = client.sync.snapshot();
    return { entities, tasks };
  };
  let startupGeneration = 0;
  let startupError: ConnectionError | undefined;

  return {
    snapshot,

    loadCommandCatalog: () => client.commandCatalog(),

    loadEntityDetails: (entityId, signal) => client.entities.get(entityId, { fresh: true, signal }),

    watch(onSnapshot) {
      let previous = client.sync.snapshot();
      return client.sync.watchSnapshot((next) => {
        if (next.entities === previous.entities && next.tasks === previous.tasks) return;
        previous = next;
        onSnapshot({ entities: next.entities, tasks: next.tasks });
      });
    },

    async start() {
      const generation = ++startupGeneration;
      startupError = undefined;
      try {
        await client.sync.start();
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
      client.sync.stop();
      startupError = undefined;
    }
  };
}
