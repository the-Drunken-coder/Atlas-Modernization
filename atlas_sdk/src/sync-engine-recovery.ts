import type { HttpTransport } from "./http.js";
import { assertPaginationProgress, pathWithQuery, requireCursor } from "./pagination.js";
import type { FeedEvent } from "./protocol.js";
import type { AtlasRecoveredWatchEvent, AtlasWatchEvent, ChangedSinceCursors, ChangedSinceResponse } from "./types.js";
import { changedSinceToEvents } from "./types.js";
import { changedSinceResponseValidator } from "./validation.js";

export type RecoveryEventApplier = (event: FeedEvent) => void;
export type RecoveredEventApplier = (event: AtlasRecoveredWatchEvent) => void;

export class RecoveryCoordinator {
  private operation = 0;
  private activePromise: Promise<boolean> | undefined;
  private activeGeneration: number | undefined;
  private activeSinceVersion: number | undefined;

  currentOperation(): number {
    return this.operation;
  }

  activeRecoveryPromise(): Promise<boolean> | undefined {
    return this.activePromise;
  }

  invalidate(): number {
    const operation = ++this.operation;
    this.activePromise = undefined;
    this.activeGeneration = undefined;
    this.activeSinceVersion = undefined;
    return operation;
  }

  start(
    generation: number,
    sinceVersion: number,
    isCurrentGeneration: (generation: number) => boolean,
    recover: (operation: number) => Promise<boolean>
  ): Promise<boolean> {
    if (!isCurrentGeneration(generation)) return Promise.resolve(false);
    if (
      this.activePromise !== undefined &&
      this.activeGeneration === generation &&
      this.activeSinceVersion === sinceVersion
    ) {
      return this.activePromise;
    }
    const operation = this.invalidate();
    const recovery = recover(operation);
    this.activePromise = recovery;
    this.activeGeneration = generation;
    this.activeSinceVersion = sinceVersion;
    const clearActiveRecovery = () => {
      if (!isCurrentGeneration(generation) || this.activePromise !== recovery) return;
      this.activePromise = undefined;
      this.activeGeneration = undefined;
      this.activeSinceVersion = undefined;
    };
    void recovery.then(clearActiveRecovery, clearActiveRecovery);
    return recovery;
  }
}

export class RecoveryRunner {
  constructor(private readonly transport: HttpTransport) {}

  async run(
    sinceVersion: number,
    isCurrentOperation: () => boolean,
    applyEvent: RecoveryEventApplier,
    applyRecoveredEvent: RecoveredEventApplier
  ): Promise<{ snapshotVersion: number | undefined; superseded: boolean }> {
    let snapshotVersion: number | undefined;
    let cursors: ChangedSinceCursors = {};
    const events: AtlasWatchEvent[] = [];
    const seenCursors = new Map<string, Set<string>>();
    do {
      if (!isCurrentOperation()) return { snapshotVersion, superseded: true };
      const response = await this.transport.json(
        "GET",
        changedSincePath(sinceVersion, cursors),
        changedSinceResponseValidator(sinceVersion)
      );
      if (!isCurrentOperation()) return { snapshotVersion, superseded: true };
      if (snapshotVersion !== undefined && response.version !== snapshotVersion) {
        throw new TypeError("Atlas changed-since pagination changed response version");
      }
      snapshotVersion = response.version;
      events.push(...changedSinceToEvents(response));
      cursors = nextChangedSinceCursors(response);
      assertPaginationProgress("changed-since", cursors, seenCursors);
    } while (hasMoreChangedSince(cursors));

    for (const event of events.sort((a, b) => watchEventVersion(a) - watchEventVersion(b))) {
      if (!isCurrentOperation()) return { snapshotVersion, superseded: true };
      if (event.event === "recovered") {
        applyRecoveredEvent(event);
      } else if (event.event !== "local_delete") {
        applyEvent(event);
      }
    }
    return { snapshotVersion, superseded: false };
  }
}

function watchEventVersion(event: AtlasWatchEvent): number {
  return "version" in event ? event.version : 0;
}

function changedSincePath(sinceVersion: number, cursors: ChangedSinceCursors): string {
  return pathWithQuery("/queries/changed-since", { since_version: String(sinceVersion), ...cursors });
}

function nextChangedSinceCursors(response: ChangedSinceResponse): ChangedSinceCursors {
  const cursors: ChangedSinceCursors = {};
  if (response.has_more_entities)
    cursors.entity_cursor = requireCursor(response.next_entity_cursor, "next_entity_cursor");
  if (response.has_more_tasks) cursors.task_cursor = requireCursor(response.next_task_cursor, "next_task_cursor");
  if (response.has_more_objects)
    cursors.object_cursor = requireCursor(response.next_object_cursor, "next_object_cursor");
  if (response.has_more_deleted_entities) {
    cursors.deleted_entity_cursor = requireCursor(response.next_deleted_entity_cursor, "next_deleted_entity_cursor");
  }
  if (response.has_more_deleted_tasks) {
    cursors.deleted_task_cursor = requireCursor(response.next_deleted_task_cursor, "next_deleted_task_cursor");
  }
  if (response.has_more_deleted_objects) {
    cursors.deleted_object_cursor = requireCursor(response.next_deleted_object_cursor, "next_deleted_object_cursor");
  }
  return cursors;
}

function hasMoreChangedSince(cursors: ChangedSinceCursors): boolean {
  return Object.keys(cursors).length > 0;
}
