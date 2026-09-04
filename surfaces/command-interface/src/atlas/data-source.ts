import {
  AtlasClient,
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
