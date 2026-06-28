import {
  AtlasAPIError,
  AtlasClient,
  type AtlasClientOptions,
  type AtlasSubscription,
  type AtlasWatchEvent,
  type EntityCheckInOptions,
  type EntityCheckInResponse,
  type EntityCreateRequest,
  type EntityResource,
  type EntityUpdateRequest,
  type FullDatasetResponse,
  type ObjectCreateRequest,
  type ObjectResource,
  type TaskCompleteOptions,
  type TaskCreateRequest,
  type TaskFailOptions,
  type TaskLifecycleOptions,
  type TaskResource,
  type TaskStatus,
  type TaskStatusOptions
} from "../../../atlas_sdk/src/index.js";
import type { SimulationConfig } from "./config.js";

export type AtlasClientLike = {
  entities: {
    get(id: string): Promise<EntityResource>;
    create(entity: EntityCreateRequest): Promise<EntityResource>;
    update(id: string, patch: EntityUpdateRequest): Promise<EntityResource>;
    delete(id: string): Promise<void>;
    checkIn(id: string, options?: EntityCheckInOptions): Promise<EntityCheckInResponse>;
  };
  tasks: {
    get(id: string): Promise<TaskResource>;
    create(task: TaskCreateRequest): Promise<TaskResource>;
    delete(id: string): Promise<void>;
    acknowledge(id: string, options?: TaskLifecycleOptions): Promise<TaskResource>;
    complete(id: string, options?: TaskCompleteOptions): Promise<TaskResource>;
    fail(id: string, options?: TaskFailOptions): Promise<TaskResource>;
    setStatus(id: string, status: TaskStatus, options?: TaskStatusOptions): Promise<TaskResource>;
  };
  objects: {
    get(id: string): Promise<ObjectResource>;
    create(object: ObjectCreateRequest): Promise<ObjectResource>;
    delete(id: string): Promise<void>;
  };
  queries: {
    full(): Promise<FullDatasetResponse>;
  };
  sync: {
    start(): Promise<void>;
    stop(): void;
    status(): { running: boolean; healthy: boolean; degraded: boolean; lastVersion: number };
  };
  watch<T extends EntityResource | TaskResource | ObjectResource>(filter: AtlasSubscription, callback: (value: T | undefined, event: AtlasWatchEvent) => void): () => void;
  handshake(): Promise<void>;
};

export type ClientMode = false | "all" | "selective";

export type AtlasClientFactory = (options?: { sync?: ClientMode; pollIntervalMs?: number }) => AtlasClientLike;

export function createAtlasClientFactory(config: SimulationConfig): AtlasClientFactory {
  return (options = {}) =>
    new AtlasClient({
      baseUrl: config.atlasBaseUrl,
      apiKey: config.atlasApiKey,
      sync: options.sync ?? false,
      pollIntervalMs: options.pollIntervalMs ?? 2_000
    } satisfies AtlasClientOptions);
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof AtlasAPIError && error.status === 404;
}
