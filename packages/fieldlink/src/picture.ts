import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ObservationResourceType } from "./messages/observation.js";
import { observationMessage } from "./messages/observation.js";
import type { JsonObject } from "./messages/resource.js";
import type { ReceivedMessage } from "./node.js";

export interface PictureRecord {
  readonly observationId: string;
  readonly resourceType: ObservationResourceType;
  readonly resourceId: string;
  readonly body: JsonObject;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly source: string;
  readonly destination: string;
  readonly logicalId: string;
  readonly delivery: "complete" | "transfer";
  readonly authentication: "unverified";
  readonly snrDb?: number;
}

export interface PictureRecordView extends PictureRecord {
  readonly stale: boolean;
  readonly ageMs: number;
}

export interface FieldLinkPictureOptions {
  readonly path: string;
  readonly maximumJournalEntries?: number;
  readonly maximumLatestEntries?: number;
  readonly maximumSeenEntries?: number;
  readonly maximumStoredBytes?: number;
  readonly staleAfterMs?: number;
  readonly now?: () => number;
}

interface PictureNode {
  onMessage(
    listener: (message: ReceivedMessage) => void | Promise<void>,
  ): () => void;
  onPassiveMessage(
    listener: (message: ReceivedMessage) => void | Promise<void>,
  ): () => void;
}

interface StoredPicture {
  readonly latest: readonly PictureRecord[];
  readonly journal: readonly PictureRecord[];
  readonly seen: readonly string[];
}

const DEFAULT_MAXIMUM_JOURNAL_ENTRIES = 1_000;
const DEFAULT_MAXIMUM_LATEST_ENTRIES = 4_096;
const DEFAULT_MAXIMUM_SEEN_ENTRIES = 8_192;
const DEFAULT_MAXIMUM_STORED_BYTES = 64 * 1024 * 1024;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

/** Persistent latest-known state and bounded replay history. It performs no fusion. */
export class FieldLinkPicture {
  readonly #path: string;
  readonly #maximumJournalEntries: number;
  readonly #maximumLatestEntries: number;
  readonly #maximumSeenEntries: number;
  readonly #maximumStoredBytes: number;
  readonly #staleAfterMs: number;
  readonly #now: () => number;
  readonly #latest = new Map<string, PictureRecord>();
  readonly #journal: PictureRecord[] = [];
  readonly #seen = new Map<string, true>();
  #dirty = false;
  #persisting: Promise<void> | undefined;

  private constructor(options: FieldLinkPictureOptions) {
    this.#maximumJournalEntries = positiveInteger(
      "Picture journal limit",
      options.maximumJournalEntries ?? DEFAULT_MAXIMUM_JOURNAL_ENTRIES,
    );
    this.#maximumLatestEntries = positiveInteger(
      "Picture latest-state limit",
      options.maximumLatestEntries ?? DEFAULT_MAXIMUM_LATEST_ENTRIES,
    );
    this.#maximumSeenEntries = positiveInteger(
      "Picture replay-cache limit",
      options.maximumSeenEntries ?? DEFAULT_MAXIMUM_SEEN_ENTRIES,
    );
    this.#maximumStoredBytes = positiveInteger(
      "Picture byte limit",
      options.maximumStoredBytes ?? DEFAULT_MAXIMUM_STORED_BYTES,
    );
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
      throw new RangeError("Picture stale threshold must be positive");
    }
    this.#path = options.path;
    this.#staleAfterMs = staleAfterMs;
    this.#now = options.now ?? Date.now;
  }

  static async open(
    options: FieldLinkPictureOptions,
  ): Promise<FieldLinkPicture> {
    const picture = new FieldLinkPicture(options);
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(options.path, "utf8")) as unknown;
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) {
        return picture;
      }
      throw error;
    }
    if (!isStoredPicture(stored)) {
      throw new Error(`Invalid FieldLink Picture file: ${options.path}`);
    }
    for (const record of stored.latest) {
      picture.#latest.set(recordKey(record), structuredClone(record));
    }
    for (const record of stored.journal) {
      picture.#journal.push(structuredClone(record));
    }
    for (const key of stored.seen) {
      picture.#seen.set(key, true);
    }
    picture.#enforceBounds();
    return picture;
  }

  async record(received: ReceivedMessage): Promise<boolean> {
    if (!observationMessage.validate(received.message)) {
      return false;
    }
    const observation = received.message;
    const replayKey = `${received.source}:${observation.observation_id}`;
    if (this.#seen.has(replayKey)) {
      return false;
    }
    const record: PictureRecord = {
      observationId: observation.observation_id,
      resourceType: observation.resource_type,
      resourceId: observation.resource_id,
      body: structuredClone(observation.body),
      observedAt: observation.observed_at,
      receivedAt: received.receivedAt.toISOString(),
      source: received.source,
      destination: received.destination,
      logicalId: received.logicalId,
      delivery: received.delivery,
      authentication: "unverified",
      ...(received.snrDb === undefined ? {} : { snrDb: received.snrDb }),
    };
    const smallestStored: StoredPicture = {
      latest: [record],
      journal: [],
      seen: [replayKey],
    };
    if (serializedBytes(smallestStored) > this.#maximumStoredBytes) {
      throw new RangeError(
        `Observation ${record.observationId} exceeds the Picture byte limit`,
      );
    }

    remember(this.#seen, replayKey);
    this.#journal.push(record);
    const key = recordKey(record);
    const current = this.#latest.get(key);
    if (current === undefined || compareRecords(record, current) > 0) {
      this.#latest.delete(key);
      this.#latest.set(key, record);
    }
    this.#enforceBounds();
    this.#dirty = true;
    await this.#persist();
    return true;
  }

  latest(
    resourceType: ObservationResourceType,
    resourceId: string,
  ): PictureRecordView | undefined {
    const record = this.#latest.get(`${resourceType}:${resourceId}`);
    return record === undefined ? undefined : this.#view(record);
  }

  list(resourceType?: ObservationResourceType): readonly PictureRecordView[] {
    return [...this.#latest.values()]
      .filter(
        (record) =>
          resourceType === undefined || record.resourceType === resourceType,
      )
      .map((record) => this.#view(record));
  }

  journal(): readonly PictureRecord[] {
    return structuredClone(this.#journal);
  }

  async close(): Promise<void> {
    try {
      await this.#persisting;
    } catch {
      // The retry below reports a persistent failure but can recover a transient one.
    }
    if (this.#dirty) {
      await this.#persist();
    }
  }

  #view(record: PictureRecord): PictureRecordView {
    const ageMs = Math.max(0, this.#now() - Date.parse(record.observedAt));
    return {
      ...structuredClone(record),
      stale: ageMs >= this.#staleAfterMs,
      ageMs,
    };
  }

  #enforceBounds(): void {
    trimStart(this.#journal, this.#maximumJournalEntries);
    trimMap(this.#latest, this.#maximumLatestEntries);
    trimMap(this.#seen, this.#maximumSeenEntries);

    while (serializedBytes(this.#stored()) > this.#maximumStoredBytes) {
      if (this.#journal.length > 0) {
        this.#journal.shift();
      } else if (this.#seen.size > 0) {
        this.#seen.delete(this.#seen.keys().next().value as string);
      } else if (this.#latest.size > 0) {
        this.#latest.delete(this.#latest.keys().next().value as string);
      } else {
        break;
      }
    }
  }

  #stored(): StoredPicture {
    return {
      latest: [...this.#latest.values()],
      journal: this.#journal,
      seen: [...this.#seen.keys()],
    };
  }

  #persist(): Promise<void> {
    this.#dirty = true;
    if (this.#persisting !== undefined) {
      return this.#persisting;
    }
    const operation = this.#writeUntilClean();
    this.#persisting = operation;
    const clear = (): void => {
      if (this.#persisting === operation) {
        this.#persisting = undefined;
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  async #writeUntilClean(): Promise<void> {
    const temporaryPath = `${this.#path}.${process.pid}.tmp`;
    while (this.#dirty) {
      this.#dirty = false;
      const serialized = `${JSON.stringify(this.#stored(), null, 2)}\n`;
      try {
        await mkdir(dirname(this.#path), { recursive: true });
        await writeFile(temporaryPath, serialized, "utf8");
        await rename(temporaryPath, this.#path);
      } catch (error: unknown) {
        this.#dirty = true;
        throw error;
      }
    }
  }
}

/** Records both addressed and passive Observation messages in one Picture. */
export function attachFieldLinkPicture(
  node: PictureNode,
  picture: FieldLinkPicture,
): () => void {
  const record = (received: ReceivedMessage): Promise<void> =>
    picture.record(received).then(() => undefined);
  const unsubscribeAddressed = node.onMessage(record);
  const unsubscribePassive = node.onPassiveMessage(record);
  return () => {
    unsubscribeAddressed();
    unsubscribePassive();
  };
}

function recordKey(
  record: Pick<PictureRecord, "resourceType" | "resourceId">,
): string {
  return `${record.resourceType}:${record.resourceId}`;
}

function compareRecords(left: PictureRecord, right: PictureRecord): number {
  const time = Date.parse(left.observedAt) - Date.parse(right.observedAt);
  return time === 0
    ? left.observationId.localeCompare(right.observationId)
    : time;
}

function remember(map: Map<string, true>, key: string): void {
  map.delete(key);
  map.set(key, true);
}

function trimStart(values: unknown[], maximum: number): void {
  if (values.length > maximum) {
    values.splice(0, values.length - maximum);
  }
}

function trimMap<Key, Value>(map: Map<Key, Value>, maximum: number): void {
  while (map.size > maximum) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    map.delete(oldest);
  }
}

function serializedBytes(stored: StoredPicture): number {
  return Buffer.byteLength(JSON.stringify(stored), "utf8");
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function isStoredPicture(value: unknown): value is StoredPicture {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    Array.isArray(value.latest) &&
    value.latest.every(isPictureRecord) &&
    Array.isArray(value.journal) &&
    value.journal.every(isPictureRecord) &&
    Array.isArray(value.seen) &&
    value.seen.every((key) => typeof key === "string")
  );
}

function isPictureRecord(value: unknown): value is PictureRecord {
  if (
    !isRecord(value) ||
    typeof value.observationId !== "string" ||
    !isResourceType(value.resourceType) ||
    typeof value.resourceId !== "string" ||
    !isRecord(value.body) ||
    !observationMessage.validate({
      type: "observation",
      observation_id: value.observationId,
      observed_at: value.observedAt,
      resource_type: value.resourceType,
      resource_id: value.resourceId,
      body: value.body,
    }) ||
    typeof value.receivedAt !== "string" ||
    !Number.isFinite(Date.parse(value.receivedAt)) ||
    typeof value.source !== "string" ||
    typeof value.destination !== "string" ||
    typeof value.logicalId !== "string" ||
    (value.delivery !== "complete" && value.delivery !== "transfer") ||
    value.authentication !== "unverified"
  ) {
    return false;
  }
  return value.snrDb === undefined || Number.isFinite(value.snrDb);
}

function isResourceType(value: unknown): value is ObservationResourceType {
  return (
    value === "entity" ||
    value === "track" ||
    value === "geofeature" ||
    value === "object"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
