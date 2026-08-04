import { AtlasClient, type EntityResource, type JSONValue, type TaskResource } from "@the-drunken-coder/atlas-sdk";
import type { AppConfig } from "../app/config.js";
import {
  buildCommandTaskRequest,
  type CommandCatalog,
  type CommandDefinition,
  coerceParameters
} from "./command-model.js";
import { sanitizeConnectionError } from "./connection-error.js";
import type { UiGeometry } from "./geometry.js";
import type { AtlasSnapshot } from "./store.js";

export type CommandSubmission = {
  entityId: string;
  command: CommandDefinition;
  parameters?: Record<string, JSONValue>;
  signal?: AbortSignal;
};

export type ConnectionError = { source: "startup" | "live-sync"; message: string };
export type ConnectionHealth = { running: boolean; healthy: boolean; degraded: boolean; error?: ConnectionError };

export interface AtlasDataSource {
  snapshot(): AtlasSnapshot;
  loadCommandCatalog(): Promise<CommandCatalog>;
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
  const snapshot = (): AtlasSnapshot => {
    const { entities, tasks } = client.sync.snapshot();
    return { entities, tasks };
  };
  let startupGeneration = 0;
  let startupError: ConnectionError | undefined;

  return {
    snapshot,

    loadCommandCatalog: () => client.commandCatalog(),

    watch(onSnapshot) {
      const unsubscribe = client.watch({ filter: "all" }, (_value, event) => {
        if (event.resource_type === "entity" || event.resource_type === "task") onSnapshot(snapshot());
      });
      return unsubscribe;
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
      const parameters = coerceParameters(submission.command, submission.parameters);
      return client.tasks.create(
        buildCommandTaskRequest({ entityId: submission.entityId, command: submission.command, parameters }),
        {
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
