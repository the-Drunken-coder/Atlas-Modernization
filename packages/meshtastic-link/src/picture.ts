import { randomUUID } from "node:crypto";
import type { EntityResource, ObjectResource, ResourceType, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { resourceID } from "./contract.js";
import type { ConfirmationState, LinkNode, PublicationPath, StatePublication } from "./types.js";

export type PictureFreshness = "fresh" | "stale" | "degraded";

export type PictureRecord = {
  resource_type: ResourceType;
  id: string;
  state: EntityResource | TaskResource | ObjectResource;
  source: LinkNode;
  source_generation: number;
  service_session: string;
  source_sequence: number;
  source_asset_id?: string;
  runtime_id?: string;
  operation_id?: string;
  observation_time: string;
  received_at: number;
  atlas_version?: number;
  freshness: PictureFreshness;
  path: PublicationPath;
  confirmation: ConfirmationState;
};

export type PictureEvent = {
  session: string;
  revision: number;
  type: "upsert" | "stale" | "remove";
  key: string;
  record?: PictureRecord;
};

export type PictureSnapshot = {
  session: string;
  revision: number;
  records: PictureRecord[];
};

type SourcePosition = {
  generation: number;
  session: string;
};

type PictureTombstone = {
  atlasVersion: number;
  confirmation: ConfirmationState;
  source: LinkNode;
  sourceGeneration: number;
  serviceSession: string;
  sourceSequence: number;
};

type RecordSourceSequence = {
  sourceKey: string;
  generation: number;
  session: string;
  sequence: number;
};

export type PictureApplyContext = {
  source: LinkNode;
  source_generation: number;
  service_session: string;
  source_sequence: number;
  received_at: number;
};

export class PictureCursorError extends Error {}

export class SharedPicture {
  readonly session: string;
  private revision = 0;
  private readonly records = new Map<string, PictureRecord>();
  private readonly tombstones = new Map<string, PictureTombstone>();
  private readonly sources = new Map<string, SourcePosition>();
  private readonly recordSourceSequences = new Map<string, RecordSourceSequence>();
  private readonly events: PictureEvent[] = [];
  private readonly listeners = new Set<(event: PictureEvent) => void>();

  constructor(
    session: string = randomUUID(),
    private readonly eventBufferLimit = 1024
  ) {
    if (!session) throw new TypeError("picture session must not be empty");
    if (!Number.isSafeInteger(eventBufferLimit) || eventBufferLimit < 1)
      throw new RangeError("event buffer must be positive");
    this.session = session;
  }

  apply(publication: StatePublication, context: PictureApplyContext): boolean {
    if (!this.acceptSource(context)) return false;
    const id = resourceID(publication);
    const key = `${publication.resource_type}:${id}`;
    const sourceKey = `${context.source.role}:${context.source.id}`;
    const recordSourceKey = `${key}\0${sourceKey}`;
    const sourceSequence = this.recordSourceSequences.get(recordSourceKey);
    if (
      sourceSequence?.generation === context.source_generation &&
      sourceSequence.session === context.service_session &&
      context.source_sequence <= sourceSequence.sequence
    ) {
      return false;
    }
    this.recordSourceSequences.set(recordSourceKey, {
      sourceKey,
      generation: context.source_generation,
      session: context.service_session,
      sequence: context.source_sequence
    });
    const current = this.records.get(key);
    const tombstone = this.tombstones.get(key);
    if (
      current &&
      sameNode(current.source, context.source) &&
      current.source_generation === context.source_generation &&
      current.service_session === context.service_session &&
      context.source_sequence <= current.source_sequence
    ) {
      return false;
    }
    if (
      tombstone &&
      sameNode(tombstone.source, context.source) &&
      tombstone.sourceGeneration === context.source_generation &&
      tombstone.serviceSession === context.service_session &&
      context.source_sequence <= tombstone.sourceSequence
    ) {
      return false;
    }
    if (current && !isNewer(publication, current, context)) return false;
    if (publication.deleted === true) {
      if (tombstone && !canReplaceTombstone(publication, tombstone)) return false;
      this.tombstones.set(key, {
        atlasVersion: publication.atlas_version,
        confirmation: publication.confirmation,
        source: context.source,
        sourceGeneration: context.source_generation,
        serviceSession: context.service_session,
        sourceSequence: context.source_sequence
      });
      if (current) {
        this.records.delete(key);
        this.emit({ type: "remove", key });
      }
      return true;
    }

    const version = resourceVersion(publication);
    if (tombstone && (version === undefined || !canReplaceTombstone(publication, tombstone))) return false;
    this.tombstones.delete(key);
    const sourceAsset = sourceAssetID(publication, context.source);
    const record: PictureRecord = {
      resource_type: publication.resource_type,
      id,
      state: structuredClone(publication.resource),
      source: context.source,
      source_generation: context.source_generation,
      service_session: context.service_session,
      source_sequence: context.source_sequence,
      ...(sourceAsset === undefined ? {} : { source_asset_id: sourceAsset }),
      ...(publication.runtime_id === undefined ? {} : { runtime_id: publication.runtime_id }),
      ...(publication.operation_id === undefined ? {} : { operation_id: publication.operation_id }),
      observation_time: publication.observation_time,
      received_at: context.received_at,
      ...(version === undefined ? {} : { atlas_version: version }),
      freshness: "fresh",
      path: publication.path,
      confirmation: publication.confirmation
    };
    this.records.set(key, record);
    this.emit({ type: "upsert", key, record });
    if (context.source.role === "asset") this.markSourceConnectivity(context.source, true);
    return true;
  }

  markSourceConnectivity(source: LinkNode, connected: boolean): void {
    const freshness: PictureFreshness = connected ? "fresh" : "degraded";
    for (const [key, record] of this.records) {
      if (
        record.resource_type === "task" &&
        !isTerminalTask(record.state as TaskResource) &&
        (record.state as TaskResource).asset_id === source.id &&
        record.freshness !== freshness
      ) {
        const updated = { ...record, freshness };
        this.records.set(key, updated);
        this.emit({ type: connected ? "upsert" : "stale", key, record: updated });
      }
    }
  }

  refresh(now: number): void {
    for (const [key, record] of this.records) {
      const age = now - record.received_at;
      const thresholds = freshnessThresholds(record);
      if (thresholds.removeAfterMs !== undefined && age >= thresholds.removeAfterMs) {
        this.degradeTasksForExpiredAsset(record);
        this.records.delete(key);
        this.emit({ type: "remove", key });
      } else if (
        thresholds.staleAfterMs !== undefined &&
        age >= thresholds.staleAfterMs &&
        record.freshness === "fresh"
      ) {
        this.degradeTasksForExpiredAsset(record);
        const stale = { ...record, freshness: "stale" as const };
        this.records.set(key, stale);
        this.emit({ type: "stale", key, record: stale });
      }
    }
  }

  snapshot(): PictureSnapshot {
    return {
      session: this.session,
      revision: this.revision,
      records: structuredClone([...this.records.values()].sort(comparePictureRecords))
    };
  }

  eventsAfter(session: string, revision: number): PictureEvent[] {
    if (session !== this.session || !Number.isSafeInteger(revision) || revision < 0 || revision > this.revision) {
      throw new PictureCursorError("picture cursor belongs to another service session or is invalid");
    }
    const earliest = this.events[0]?.revision ?? this.revision + 1;
    if (revision < earliest - 1) throw new PictureCursorError("picture cursor expired; read a new snapshot");
    return structuredClone(this.events.filter((event) => event.revision > revision));
  }

  subscribe(listener: (event: PictureEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activateSource(source: LinkNode, generation: number, session: string): boolean {
    if (!Number.isSafeInteger(generation) || generation < 0 || !session) {
      throw new TypeError("source activation requires a generation and service session");
    }
    const key = `${source.role}:${source.id}`;
    const current = this.sources.get(key);
    if (
      current &&
      (generation < current.generation || (generation === current.generation && session !== current.session))
    ) {
      return false;
    }
    if (current && generation > current.generation) {
      this.markSourceConnectivity(source, false);
      for (const [recordSourceKey, position] of this.recordSourceSequences) {
        if (position.sourceKey === key) this.recordSourceSequences.delete(recordSourceKey);
      }
    }
    this.sources.set(key, { generation, session });
    return true;
  }

  subscribeAfter(
    session: string,
    revision: number,
    listener: (event: PictureEvent) => void
  ): { replay: PictureEvent[]; unsubscribe: () => void } {
    const replay = this.eventsAfter(session, revision);
    this.listeners.add(listener);
    return { replay, unsubscribe: () => this.listeners.delete(listener) };
  }

  private acceptSource(context: PictureApplyContext): boolean {
    return this.activateSource(context.source, context.source_generation, context.service_session);
  }

  private degradeTasksForExpiredAsset(record: PictureRecord): void {
    if (record.resource_type !== "entity") return;
    const entity = record.state as EntityResource;
    if (entity.entity_type === "asset") this.markSourceConnectivity({ role: "asset", id: entity.entity_id }, false);
  }

  private emit(event: Omit<PictureEvent, "session" | "revision">): void {
    const complete: PictureEvent = { ...event, session: this.session, revision: ++this.revision };
    this.events.push(structuredClone(complete));
    if (this.events.length > this.eventBufferLimit) this.events.shift();
    for (const listener of this.listeners) listener(structuredClone(complete));
  }
}

function isNewer(publication: StatePublication, current: PictureRecord, context: PictureApplyContext): boolean {
  const nextVersion = resourceVersion(publication);
  if (nextVersion !== undefined && current.atlas_version !== undefined) {
    if (nextVersion !== current.atlas_version) return nextVersion > current.atlas_version;
    const nextRank = confirmationRank(publication.confirmation);
    const currentRank = confirmationRank(current.confirmation);
    if (nextRank > currentRank) return true;
    if (nextRank < currentRank) {
      return Date.parse(publication.observation_time) > Date.parse(current.observation_time);
    }
    if (
      sameNode(current.source, context.source) &&
      current.source_generation === context.source_generation &&
      current.service_session === context.service_session
    ) {
      return context.source_sequence > current.source_sequence;
    }
    return Date.parse(publication.observation_time) > Date.parse(current.observation_time);
  }
  if (publication.resource_type === "task" && current.resource_type === "task") {
    const nextRank = confirmationRank(publication.confirmation);
    const currentRank = confirmationRank(current.confirmation);
    if (nextRank > currentRank) return true;
    const nextUpdatedAt = Date.parse(publication.resource.updated_at);
    const currentUpdatedAt = Date.parse((current.state as TaskResource).updated_at);
    if (nextUpdatedAt !== currentUpdatedAt) return nextUpdatedAt > currentUpdatedAt;
    return nextRank > currentRank;
  }
  return true;
}

function canReplaceTombstone(publication: StatePublication, tombstone: PictureTombstone): boolean {
  const version = resourceVersion(publication);
  if (version === undefined || version !== tombstone.atlasVersion)
    return version !== undefined && version > tombstone.atlasVersion;
  return confirmationRank(publication.confirmation) > confirmationRank(tombstone.confirmation);
}

function resourceVersion(publication: StatePublication): number | undefined {
  if (publication.deleted === true) return publication.atlas_version;
  return publication.resource_type === "task"
    ? undefined
    : (publication.atlas_version ?? publication.resource.metadata.version);
}

function sourceAssetID(publication: StatePublication, source: LinkNode): string | undefined {
  if (publication.deleted === true) return undefined;
  if (source.role === "asset") return source.id;
  if (publication.resource_type === "task") return publication.resource.asset_id;
  if (publication.resource_type === "entity" && publication.resource.entity_type === "asset") {
    return publication.resource.entity_id;
  }
  return undefined;
}

function confirmationRank(confirmation: ConfirmationState): number {
  return confirmation === "core_confirmed" || confirmation === "core_rejected" ? 2 : 1;
}

function freshnessThresholds(record: PictureRecord): { staleAfterMs?: number; removeAfterMs?: number } {
  if (record.resource_type === "task") {
    return isTerminalTask(record.state as TaskResource) ? { removeAfterMs: 10 * 60_000 } : {};
  }
  if (record.resource_type === "entity") {
    const entity = record.state as EntityResource;
    if (entity.entity_type === "asset" || entity.entity_type === "track") {
      if (entity.components.telemetry || entity.components.health) {
        return { staleAfterMs: 30_000, removeAfterMs: 120_000 };
      }
      if (entity.components.geometry) return { staleAfterMs: 5_000, removeAfterMs: 30_000 };
    }
  }
  return {};
}

function isTerminalTask(task: TaskResource): boolean {
  return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}

function sameNode(left: LinkNode, right: LinkNode): boolean {
  return left.role === right.role && left.id === right.id;
}

function comparePictureRecords(left: PictureRecord, right: PictureRecord): number {
  return left.resource_type.localeCompare(right.resource_type) || left.id.localeCompare(right.id);
}
