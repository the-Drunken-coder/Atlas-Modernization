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

export type PictureApplyResult =
  | { status: "applied" }
  | {
      status: "rejected";
      reason: "stale_source" | "stale_sequence" | "stale_record" | "capacity";
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
  receivedAt: number;
};

const RECORD_SOURCE_SEQUENCE_REPLAY_MS = 10 * 60_000;
const RECORD_SOURCE_SEQUENCE_LIMIT = 4_096;
const PICTURE_ENTRY_LIMIT = 4_096;
const PICTURE_RETAINED_BYTES_LIMIT = 16 * 1024 * 1024;
const PICTURE_SOURCE_LIMIT = 4_096;
const PICTURE_LISTENER_LIMIT = 1_024;
const PICTURE_EVENT_BYTES_LIMIT = 8 * 1024 * 1024;
const APPLIED = { status: "applied" } as const satisfies PictureApplyResult;

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
  private readonly entryBytes = new Map<string, number>();
  private readonly events: PictureEvent[] = [];
  private readonly eventBytes: number[] = [];
  private readonly listeners = new Set<(event: PictureEvent) => void>();
  private readonly pendingEvents: PictureEvent[] = [];
  private retainedEntryBytes = 0;
  private retainedEventBytes = 0;
  private dispatchingEvents = false;

  constructor(
    session: string = randomUUID(),
    private readonly eventBufferLimit = 1024
  ) {
    if (!session) throw new TypeError("picture session must not be empty");
    if (!Number.isSafeInteger(eventBufferLimit) || eventBufferLimit < 1)
      throw new RangeError("event buffer must be positive");
    this.session = session;
  }

  apply(publication: StatePublication, context: PictureApplyContext): PictureApplyResult {
    const sourceRejection = this.acceptSource(context);
    if (sourceRejection) return rejected(sourceRejection);
    this.pruneRecordSourceSequences(context.received_at);
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
      return rejected("stale_sequence");
    }
    if (sourceSequence === undefined && this.recordSourceSequences.size >= RECORD_SOURCE_SEQUENCE_LIMIT) {
      return rejected("capacity");
    }
    this.recordSourceSequences.set(recordSourceKey, {
      sourceKey,
      generation: context.source_generation,
      session: context.service_session,
      sequence: context.source_sequence,
      receivedAt: context.received_at
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
      return rejected("stale_sequence");
    }
    if (
      tombstone &&
      sameNode(tombstone.source, context.source) &&
      tombstone.sourceGeneration === context.source_generation &&
      tombstone.serviceSession === context.service_session &&
      context.source_sequence <= tombstone.sourceSequence
    ) {
      return rejected("stale_sequence");
    }
    if (current && !isNewer(publication, current, context)) return rejected("stale_record");
    if (publication.deleted === true) {
      if (tombstone && !canReplaceTombstone(publication, tombstone)) return rejected("stale_record");
      const nextTombstone: PictureTombstone = {
        atlasVersion: publication.atlas_version,
        confirmation: publication.confirmation,
        source: context.source,
        sourceGeneration: context.source_generation,
        serviceSession: context.service_session,
        sourceSequence: context.source_sequence
      };
      if (!this.canRetain(key, retainedEntryBytes(nextTombstone))) return rejected("capacity");
      if (current) this.degradeTasksForExpiredAsset(current);
      this.retainTombstone(key, nextTombstone);
      if (current) {
        this.emit({ type: "remove", key });
      }
      return APPLIED;
    }

    const version = resourceVersion(publication);
    if (tombstone && (version === undefined || !canReplaceTombstone(publication, tombstone))) {
      return rejected("stale_record");
    }
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
    if (!this.canRetain(key, retainedEntryBytes(record))) return rejected("capacity");
    this.retainRecord(key, record);
    this.emit({ type: "upsert", key, record });
    if (context.source.role === "asset") this.markSourceConnectivity(context.source, true);
    return APPLIED;
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
        this.retainRecord(key, updated);
        this.emit({ type: connected ? "upsert" : "stale", key, record: updated });
      }
    }
  }

  refresh(now: number): void {
    this.pruneRecordSourceSequences(now);
    for (const [key, record] of this.records) {
      const age = now - record.received_at;
      const thresholds = freshnessThresholds(record);
      if (thresholds.removeAfterMs !== undefined && age >= thresholds.removeAfterMs) {
        this.degradeTasksForExpiredAsset(record);
        this.removeRecord(key);
        this.emit({ type: "remove", key });
      } else if (
        thresholds.staleAfterMs !== undefined &&
        age >= thresholds.staleAfterMs &&
        record.freshness === "fresh"
      ) {
        this.degradeTasksForExpiredAsset(record);
        const stale = { ...record, freshness: "stale" as const };
        this.retainRecord(key, stale);
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
    this.addListener(listener);
    return () => this.listeners.delete(listener);
  }

  activateSource(source: LinkNode, generation: number, session: string): boolean {
    if (!Number.isSafeInteger(generation) || generation < 0 || !session) {
      throw new TypeError("source activation requires a generation and service session");
    }
    const key = `${source.role}:${source.id}`;
    const current = this.sources.get(key);
    if (!current && this.sources.size >= PICTURE_SOURCE_LIMIT) return false;
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
    this.addListener(listener);
    return { replay, unsubscribe: () => this.listeners.delete(listener) };
  }

  private addListener(listener: (event: PictureEvent) => void): void {
    if (!this.listeners.has(listener) && this.listeners.size >= PICTURE_LISTENER_LIMIT) {
      throw new RangeError("picture subscriber capacity exhausted");
    }
    this.listeners.add(listener);
  }

  private acceptSource(context: PictureApplyContext): "stale_source" | "capacity" | undefined {
    const key = `${context.source.role}:${context.source.id}`;
    const current = this.sources.get(key);
    if (!current && this.sources.size >= PICTURE_SOURCE_LIMIT) return "capacity";
    return this.activateSource(context.source, context.source_generation, context.service_session)
      ? undefined
      : "stale_source";
  }

  private degradeTasksForExpiredAsset(record: PictureRecord): void {
    if (record.resource_type !== "entity") return;
    const entity = record.state as EntityResource;
    if (entity.entity_type === "asset") this.markSourceConnectivity({ role: "asset", id: entity.entity_id }, false);
  }

  private pruneRecordSourceSequences(now: number): void {
    for (const [key, position] of this.recordSourceSequences) {
      if (now - position.receivedAt >= RECORD_SOURCE_SEQUENCE_REPLAY_MS) {
        this.recordSourceSequences.delete(key);
      }
    }
  }

  private canRetain(key: string, bytes: number): boolean {
    const currentBytes = this.entryBytes.get(key) ?? 0;
    if (currentBytes === 0 && this.entryBytes.size >= PICTURE_ENTRY_LIMIT) return false;
    return this.retainedEntryBytes - currentBytes + bytes <= PICTURE_RETAINED_BYTES_LIMIT;
  }

  private retainRecord(key: string, record: PictureRecord): void {
    this.retainEntrySize(key, retainedEntryBytes(record));
    this.tombstones.delete(key);
    this.records.set(key, record);
  }

  private retainTombstone(key: string, tombstone: PictureTombstone): void {
    this.retainEntrySize(key, retainedEntryBytes(tombstone));
    this.records.delete(key);
    this.tombstones.set(key, tombstone);
  }

  private retainEntrySize(key: string, bytes: number): void {
    this.retainedEntryBytes -= this.entryBytes.get(key) ?? 0;
    this.entryBytes.set(key, bytes);
    this.retainedEntryBytes += bytes;
  }

  private removeRecord(key: string): void {
    this.records.delete(key);
    this.retainedEntryBytes -= this.entryBytes.get(key) ?? 0;
    this.entryBytes.delete(key);
  }

  private emit(event: Omit<PictureEvent, "session" | "revision">): void {
    const complete: PictureEvent = { ...event, session: this.session, revision: ++this.revision };
    const stored = structuredClone(complete);
    const bytes = retainedBytes(stored);
    if (bytes > PICTURE_EVENT_BYTES_LIMIT) {
      this.events.length = 0;
      this.eventBytes.length = 0;
      this.retainedEventBytes = 0;
    } else {
      this.events.push(stored);
      this.eventBytes.push(bytes);
      this.retainedEventBytes += bytes;
      while (this.events.length > this.eventBufferLimit || this.retainedEventBytes > PICTURE_EVENT_BYTES_LIMIT) {
        this.events.shift();
        this.retainedEventBytes -= this.eventBytes.shift() ?? 0;
      }
    }
    this.pendingEvents.push(complete);
    if (this.dispatchingEvents) return;
    this.dispatchingEvents = true;
    try {
      while (this.pendingEvents.length > 0) {
        const pending = this.pendingEvents.shift();
        if (!pending) continue;
        for (const listener of [...this.listeners]) {
          if (!this.listeners.has(listener)) continue;
          try {
            listener(structuredClone(pending));
          } catch {
            this.listeners.delete(listener);
          }
        }
      }
    } finally {
      this.dispatchingEvents = false;
    }
  }
}

function isNewer(publication: StatePublication, current: PictureRecord, context: PictureApplyContext): boolean {
  const nextVersion = resourceVersion(publication);
  const newerSourceGeneration =
    sameNode(current.source, context.source) && context.source_generation > current.source_generation;
  if (nextVersion !== undefined && current.atlas_version !== undefined) {
    if (nextVersion !== current.atlas_version) return nextVersion > current.atlas_version;
    const nextRank = confirmationRank(publication.confirmation);
    const currentRank = confirmationRank(current.confirmation);
    if (nextRank > currentRank) return true;
    if (nextRank < currentRank) {
      return Date.parse(publication.observation_time) > Date.parse(current.observation_time);
    }
    if (newerSourceGeneration) {
      return Date.parse(publication.observation_time) >= Date.parse(current.observation_time);
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
    if (newerSourceGeneration) return true;
    if (nextRank < currentRank) return false;
    return (
      sameNode(current.source, context.source) &&
      current.source_generation === context.source_generation &&
      current.service_session === context.service_session &&
      context.source_sequence > current.source_sequence
    );
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

function rejected(reason: Extract<PictureApplyResult, { status: "rejected" }>["reason"]): PictureApplyResult {
  return { status: "rejected", reason };
}

function retainedBytes(value: object): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function retainedEntryBytes(value: PictureRecord | PictureTombstone): number {
  return "freshness" in value ? retainedBytes({ ...value, freshness: "degraded" }) : retainedBytes(value);
}
