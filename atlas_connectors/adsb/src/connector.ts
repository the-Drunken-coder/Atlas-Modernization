import {
  AtlasAPIError,
  ConflictError,
  type EntityCheckInOptions,
  type EntityCheckInResponse,
  type EntityCreateRequest,
  type EntityResource,
  type EntityUpdateRequest,
  type JSONValue,
  type TaskCompleteOptions,
  type TaskFailOptions,
  type TaskLifecycleOptions,
  type TaskResource
} from "@the-drunken-coder/atlas-sdk";
import type { ConnectorConfig } from "./config.js";
import { demoTracks, scanRequestFromTask, type ScanRequest } from "./scan.js";

export type ConnectorClient = {
  entities: {
    get(id: string, options?: { fresh?: boolean }): Promise<EntityResource>;
    create(request: EntityCreateRequest): Promise<EntityResource>;
    update(id: string, request: EntityUpdateRequest): Promise<EntityResource>;
    checkIn(id: string, options?: EntityCheckInOptions<"full">): Promise<EntityCheckInResponse<TaskResource>>;
  };
  tasks: {
    acknowledge(id: string, options?: TaskLifecycleOptions): Promise<TaskResource>;
    complete(id: string, options?: TaskCompleteOptions): Promise<TaskResource>;
    fail(id: string, options?: TaskFailOptions): Promise<TaskResource>;
  };
};

export class ADSBConnector {
  constructor(
    private readonly client: ConnectorClient,
    private readonly config: ConnectorConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly log: (message: string) => void = console.log
  ) {}

  async ensureAsset(): Promise<void> {
    try {
      const entity = await this.client.entities.get(this.config.connectorId, { fresh: true });
      this.validateConnectorAsset(entity);
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    try {
      await this.client.entities.create({
        entity_id: this.config.connectorId,
        entity_type: "asset",
        subtype: "connector",
        alias: "ADS-B Connector Prototype",
        components: this.assetComponents("ready")
      });
      this.log(`Registered connector asset ${this.config.connectorId}`);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      this.validateConnectorAsset(await this.client.entities.get(this.config.connectorId, { fresh: true }));
    }
  }

  async tick(): Promise<number> {
    const checkIn = await this.client.entities.checkIn(this.config.connectorId, {
      status: "ready",
      components: { custom_connector: this.connectorDescription() },
      statusFilter: ["pending"],
      limit: 20
    });
    let processed = 0;
    for (const task of checkIn.tasks) {
      if (await this.processTask(task)) processed++;
    }
    return processed;
  }

  private async processTask(task: TaskResource): Promise<boolean> {
    let request: ScanRequest | undefined;
    try {
      request = scanRequestFromTask(task);
    } catch (error) {
      await this.client.tasks.fail(task.task_id, { error: { message: errorMessage(error) } });
      this.log(`Rejected scan task ${task.task_id}: ${errorMessage(error)}`);
      return true;
    }
    if (!request) return false;

    await this.client.tasks.acknowledge(task.task_id, { ifMatchVersion: task.metadata.version });
    try {
      await this.client.entities.checkIn(this.config.connectorId, { status: "scanning" });
      const observedAt = this.now().toISOString();
      const tracks = demoTracks(this.config.connectorId, task.task_id, request, observedAt);
      for (const track of tracks) await this.upsertTrack(track);
      await this.client.tasks.complete(task.task_id, {
        result: { summary: `Published ${tracks.length} demo aircraft tracks`, track_ids: tracks.map((track) => track.entity_id) }
      });
      this.log(`Completed scan task ${task.task_id}; published ${tracks.length} tracks`);
    } catch (error) {
      await this.client.tasks.fail(task.task_id, { error: { message: errorMessage(error) } });
      this.log(`Failed scan task ${task.task_id}: ${errorMessage(error)}`);
    } finally {
      await this.client.entities.checkIn(this.config.connectorId, { status: "ready" });
    }
    return true;
  }

  private async upsertTrack(track: EntityCreateRequest): Promise<void> {
    const patch: EntityUpdateRequest = {
      components: track.components ?? {},
      ...(track.alias === undefined ? {} : { alias: track.alias }),
      ...(track.subtype === undefined ? {} : { subtype: track.subtype })
    };
    try {
      const existing = await this.client.entities.get(track.entity_id, { fresh: true });
      if (existing.entity_type !== "track") throw new Error(`${track.entity_id} already exists but is not a track`);
      await this.client.entities.update(track.entity_id, patch);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await this.client.entities.create(track);
      } catch (createError) {
        if (!(createError instanceof ConflictError)) throw createError;
        const existing = await this.client.entities.get(track.entity_id, { fresh: true });
        if (existing.entity_type !== "track") throw new Error(`${track.entity_id} already exists but is not a track`);
        await this.client.entities.update(track.entity_id, patch);
      }
    }
  }

  private assetComponents(status: string): EntityCreateRequest["components"] {
    const now = this.now().toISOString();
    return {
      heartbeat: { last_seen: now },
      status: { value: status, last_update: now },
      custom_connector: this.connectorDescription()
    };
  }

  private connectorDescription(): Record<string, JSONValue> {
    return { connector_type: "adsb", mode: "prototype", capabilities: ["scan_area"] };
  }

  private validateConnectorAsset(entity: EntityResource): void {
    if (entity.entity_type !== "asset" || entity.subtype !== "connector") {
      throw new Error(`${this.config.connectorId} already exists but is not a connector asset`);
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof AtlasAPIError && error.status === 404;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
