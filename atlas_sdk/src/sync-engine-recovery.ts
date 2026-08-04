import type { HttpTransport } from "./http.js";
import type { FeedEvent } from "./protocol.js";
import { changedSinceResponseValidator } from "./validation.js";

export type RecoveryEventApplier = (event: FeedEvent) => void;

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
    applyEvent: RecoveryEventApplier
  ): Promise<{ snapshotVersion: number | undefined; superseded: boolean }> {
    let snapshotVersion: number | undefined;
    let cursor: string | undefined;
    let lastEventVersion = sinceVersion;
    const events: FeedEvent[] = [];
    const seenCursors = new Set<string>();
    do {
      if (!isCurrentOperation()) return { snapshotVersion, superseded: true };
      const response = await this.transport.json(
        "GET",
        changedSincePath(sinceVersion, cursor),
        changedSinceResponseValidator(sinceVersion)
      );
      if (!isCurrentOperation()) return { snapshotVersion, superseded: true };
      if (snapshotVersion !== undefined && response.version !== snapshotVersion) {
        throw new TypeError("Atlas changed-since pagination changed response version");
      }
      snapshotVersion = response.version;
      for (const event of response.events) {
        if (event.version <= lastEventVersion) {
          throw new TypeError("Atlas changed-since events are not globally ordered");
        }
        lastEventVersion = event.version;
        events.push(event);
      }
      cursor = response.has_more ? requireCursor(response.next_cursor) : undefined;
      if (cursor && seenCursors.has(cursor)) throw new Error("Atlas changed-since pagination repeated cursor");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    for (const event of events) {
      if (!isCurrentOperation()) return { snapshotVersion, superseded: true };
      applyEvent(event);
    }
    return { snapshotVersion, superseded: false };
  }
}

function changedSincePath(sinceVersion: number, cursor?: string): string {
  return pathWithQuery("/queries/changed-since", { since_version: String(sinceVersion), cursor });
}

function requireCursor(cursor: string | undefined): string {
  if (!cursor) {
    throw new Error("Atlas response set has_more without next_cursor");
  }
  return cursor;
}

function pathWithQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}
