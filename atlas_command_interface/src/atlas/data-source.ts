import {
  AtlasAPIError,
  AtlasClient,
  ConflictError,
  type AtlasWatchEvent,
  type EntityResource,
  type ErrorResponse,
  type FullDatasetQueryOptions,
  type FullDatasetResponse,
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

const MAX_SNAPSHOT_PAGES = 100;
const COMMAND_REQUEST_TIMEOUT_MS = 30_000;

export type CommandSubmission = {
  entityId: string;
  command: CommandDefinition;
  parameters?: Record<string, JSONValue>;
};

export type ConnectionHealth = { running: boolean; healthy: boolean; degraded: boolean };

export interface AtlasDataSource {
  loadSnapshot(): Promise<{ entities: EntityResource[]; tasks: TaskResource[] }>;
  loadCommandCatalog(): Promise<CommandCatalog>;
  watch(onEvent: (event: AtlasWatchEvent) => void): () => void;
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
    async loadSnapshot() {
      const entities: EntityResource[] = [];
      const tasks: TaskResource[] = [];
      let options: FullDatasetQueryOptions = {};
      let pages = 0;
      for (;;) {
        const page = await client.queries.full(options);
        pages += 1;
        entities.push(...(page.entities ?? []));
        tasks.push(...(page.tasks ?? []));
        const next = nextDatasetCursors(page);
        if (!next) break;
        if (pages >= MAX_SNAPSHOT_PAGES) throw new Error(`Atlas snapshot pagination exceeded ${MAX_SNAPSHOT_PAGES} pages`);
        options = next;
      }
      return { entities, tasks };
    },

    async loadCommandCatalog() {
      const object = await client.objects.get(COMMAND_CATALOG_OBJECT_ID, { fresh: true });
      return catalogFromObject(object);
    },

    watch(onEvent) {
      return client.watch({ filter: "all" }, (_value, event) => onEvent(event));
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
      return createCommandTask(config, submission.entityId, submission.command, parameters);
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

async function createCommandTask(config: AppConfig, entityId: string, command: CommandDefinition, parameters: Record<string, JSONValue>): Promise<TaskResource> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMMAND_REQUEST_TIMEOUT_MS);
  try {
    const response = await atlasFetch(`${config.atlasBaseUrl.replace(/\/+$/, "")}/tasks`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(buildCommandTaskRequest({ entityId, command, parameters })),
      signal: controller.signal
    });
    if (!response.ok) throw await atlasResponseError(response);
    return (await response.json()) as TaskResource;
  } finally {
    clearTimeout(timeout);
  }
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

async function atlasResponseError(response: Response): Promise<AtlasAPIError> {
  const payload = await readErrorPayload(response);
  const message = atlasErrorMessage(response.status, payload);
  if (response.status === 409 || response.status === 412) return new ConflictError(message, response.status, payload);
  return new AtlasAPIError(message, response.status, payload);
}

async function readErrorPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function atlasErrorMessage(status: number, payload: unknown): string {
  const response = payload as Partial<ErrorResponse> | undefined;
  const code = typeof response?.error_code === "string" ? response.error_code : undefined;
  const message = typeof response?.message === "string" ? response.message : undefined;
  if (code && message) return `Atlas request failed: ${status} ${code}: ${message}`;
  if (message) return `Atlas request failed: ${status}: ${message}`;
  return `Atlas request failed: ${status}`;
}

function nextDatasetCursors(page: FullDatasetResponse): FullDatasetQueryOptions | undefined {
  const cursors: FullDatasetQueryOptions = {};
  if (page.has_more_entities) cursors.entityCursor = requireNextCursor(page.next_entity_cursor, "entities");
  if (page.has_more_tasks) cursors.taskCursor = requireNextCursor(page.next_task_cursor, "tasks");
  return Object.keys(cursors).length > 0 ? cursors : undefined;
}

function requireNextCursor(value: string | undefined, resourceType: "entities" | "tasks"): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new Error(`Atlas snapshot page indicated more ${resourceType} without a next cursor`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
