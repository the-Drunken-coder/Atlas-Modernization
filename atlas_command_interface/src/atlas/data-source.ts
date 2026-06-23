import {
  AtlasClient,
  type AtlasWatchEvent,
  type EntityResource,
  type FullDatasetQueryOptions,
  type FullDatasetResponse,
  type JSONValue,
  type TaskResource
} from "../../../atlas_sdk/src/index.js";
import type { AppConfig } from "../app/config.js";
import { catalogFromObject, COMMAND_CATALOG_OBJECT_ID, type CommandCatalog } from "./command-model.js";
import type { UiGeometry } from "./geometry.js";

const COMMAND_REQUEST_TIMEOUT_MS = 30_000;
const MAX_SNAPSHOT_PAGES = 100;

export type CommandSubmission = {
  entityId: string;
  commandId: string;
  parameters?: Record<string, JSONValue>;
};

export class CommandSubmitError extends Error {
  readonly status: number;
  readonly errorCode: string;

  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.name = "CommandSubmitError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

export type ConnectionHealth = { running: boolean; healthy: boolean; degraded: boolean };

export interface AtlasDataSource {
  loadSnapshot(): Promise<{ entities: EntityResource[]; tasks: TaskResource[] }>;
  loadCommandCatalog(): Promise<CommandCatalog>;
  watch(onEvent: (event: AtlasWatchEvent) => void): () => void;
  start(): Promise<void>;
  submitCommand(submission: CommandSubmission, credential: string): Promise<TaskResource>;
  updateGeometry(entityId: string, geometry: UiGeometry, ifMatchVersion?: number): Promise<EntityResource>;
  health?(): ConnectionHealth;
  dispose(): void;
}

/** The real data source: an Atlas SDK client pointed at the same-origin proxy. */
export function createSdkDataSource(config: AppConfig): AtlasDataSource {
  const client = new AtlasClient({
    baseUrl: config.atlasBaseUrl,
    sync: "all",
    fetch: (input, init) => fetch(input, init),
    WebSocket: globalThis.WebSocket
  });

  return {
    async loadSnapshot() {
      const entities: EntityResource[] = [];
      const tasks: TaskResource[] = [];
      let options: FullDatasetQueryOptions = {};
      let pages = 0;
      // The dataset endpoint is cursor-paginated per resource type.
      for (;;) {
        const page = await client.queries.full(options);
        pages += 1;
        entities.push(...(page.entities ?? []));
        tasks.push(...(page.tasks ?? []));
        const next = nextDatasetCursors(page);
        if (!next) break;
        if (pages >= MAX_SNAPSHOT_PAGES) {
          throw new Error(`Atlas snapshot pagination exceeded ${MAX_SNAPSHOT_PAGES} pages`);
        }
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

    async submitCommand(submission, credential) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), COMMAND_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch("/api/commands", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${credential}`
          },
          signal: controller.signal,
          body: JSON.stringify({
            entity_id: submission.entityId,
            command_id: submission.commandId,
            ...(submission.parameters ? { parameters: submission.parameters } : {})
          })
        });
        const data = (await response.json().catch(() => undefined)) as
          | { task?: TaskResource; error_code?: string; message?: string }
          | undefined;
        if (!response.ok || !data?.task) {
          throw new CommandSubmitError(response.status, data?.error_code ?? "COMMAND_FAILED", data?.message ?? `Command failed (${response.status})`);
        }
        return data.task;
      } finally {
        clearTimeout(timeout);
      }
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

function nextDatasetCursors(page: FullDatasetResponse): FullDatasetQueryOptions | undefined {
  const cursors: FullDatasetQueryOptions = {};
  if (page.has_more_entities) cursors.entityCursor = requireNextCursor(page.next_entity_cursor, "entities");
  if (page.has_more_tasks) cursors.taskCursor = requireNextCursor(page.next_task_cursor, "tasks");
  // Objects are loaded on demand, such as the command catalog above, so object
  // pagination must not delay the operator picture during snapshot bootstrap.
  return Object.keys(cursors).length > 0 ? cursors : undefined;
}

function requireNextCursor(value: string | undefined, resourceType: "entities" | "tasks"): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new Error(`Atlas snapshot page indicated more ${resourceType} without a next cursor`);
}
