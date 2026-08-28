import type { FieldLinkEvent } from "./node.js";
import type { Priority } from "./node-types.js";

const WINDOW_MS = 60_000;

interface CongestionSample {
  readonly at: number;
  readonly type: "frame" | "transfer" | "retry" | "transport-error";
  readonly priority?: Priority;
  readonly bytes?: number;
  readonly waitMs?: number;
  readonly retries?: number;
}

export interface CongestionQueues {
  readonly pendingSends: number;
  readonly activeOutboundTransfers: number;
  readonly waitingOutboundTransfers: number;
  readonly activeInboundTransfers: number;
  readonly activePassiveInboundTransfers: number;
  readonly scheduledFrames: Readonly<Record<Priority, number>>;
  readonly meshcoreQueueLength: number;
}

export interface CongestionWaitSummary {
  readonly samples: number;
  readonly meanMs: number;
  readonly maximumMs: number;
}

export interface FieldLinkCongestionSnapshot {
  readonly sampledAt: string;
  readonly windowMs: number;
  readonly pressure: "idle" | "low" | "moderate" | "high";
  readonly queues: CongestionQueues;
  readonly traffic: {
    readonly framesSent: number;
    readonly bytesSent: number;
    readonly retries: number;
    readonly transportErrors: number;
  };
  readonly waitMs: Readonly<Record<Priority, CongestionWaitSummary>>;
}

/** Derives one transparent, local congestion snapshot from FieldLink events. */
export class CongestionMonitor {
  readonly #samples: CongestionSample[] = [];

  record(event: FieldLinkEvent): void {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) {
      return;
    }
    switch (event.type) {
      case "frame-sent": {
        if (
          !isPriority(event.priority) ||
          !isNonNegativeNumber(event.bytes) ||
          !isNonNegativeNumber(event.queueWaitMs)
        ) {
          return;
        }
        this.#samples.push({
          at,
          type: "frame",
          priority: event.priority,
          bytes: event.bytes,
          waitMs: event.queueWaitMs,
        });
        break;
      }
      case "transfer-started": {
        if (
          !isPriority(event.priority) ||
          !isNonNegativeNumber(event.queueWaitMs)
        ) {
          return;
        }
        this.#samples.push({
          at,
          type: "transfer",
          priority: event.priority,
          waitMs: event.queueWaitMs,
        });
        break;
      }
      case "transfer-retry": {
        this.#samples.push({ at, type: "retry", retries: 1 });
        break;
      }
      case "transport-error":
        this.#samples.push({ at, type: "transport-error" });
        break;
    }
    this.#prune(at);
  }

  snapshot(
    queues: CongestionQueues,
    now = Date.now(),
  ): FieldLinkCongestionSnapshot {
    this.#prune(now);
    const active = this.#samples.filter(
      (sample) => sample.at >= now - WINDOW_MS,
    );
    const frames = active.filter((sample) => sample.type === "frame");
    const retries = active.reduce(
      (sum, sample) => sum + (sample.retries ?? 0),
      0,
    );
    const transportErrors = active.filter(
      (sample) => sample.type === "transport-error",
    ).length;
    const waits = Object.fromEntries(
      (["high", "normal", "bulk"] as const).map((priority) => {
        const values = active.flatMap((sample) =>
          sample.priority === priority && sample.waitMs !== undefined
            ? [sample.waitMs]
            : [],
        );
        return [priority, summarize(values)];
      }),
    ) as Record<Priority, CongestionWaitSummary>;
    return {
      sampledAt: new Date(now).toISOString(),
      windowMs: WINDOW_MS,
      pressure: pressure(
        queues,
        frames.length,
        retries,
        transportErrors,
        waits,
      ),
      queues,
      traffic: {
        framesSent: frames.length,
        bytesSent: frames.reduce((sum, sample) => sum + (sample.bytes ?? 0), 0),
        retries,
        transportErrors,
      },
      waitMs: waits,
    };
  }

  #prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    const firstActive = this.#samples.findIndex(
      (sample) => sample.at >= cutoff,
    );
    if (firstActive === -1) {
      this.#samples.length = 0;
    } else if (firstActive > 0) {
      this.#samples.splice(0, firstActive);
    }
  }
}

function pressure(
  queues: CongestionQueues,
  framesSent: number,
  retries: number,
  transportErrors: number,
  waits: Readonly<Record<Priority, CongestionWaitSummary>>,
): FieldLinkCongestionSnapshot["pressure"] {
  const queued =
    queues.pendingSends +
    queues.waitingOutboundTransfers +
    queues.meshcoreQueueLength +
    Object.values(queues.scheduledFrames).reduce(
      (sum, value) => sum + value,
      0,
    );
  if (
    framesSent === 0 &&
    queued === 0 &&
    queues.activeOutboundTransfers === 0 &&
    queues.activeInboundTransfers === 0 &&
    queues.activePassiveInboundTransfers === 0
  ) {
    return "idle";
  }
  let score = 0;
  const activeTransfers =
    queues.activeOutboundTransfers +
    queues.activeInboundTransfers +
    queues.activePassiveInboundTransfers;
  if (activeTransfers >= 2) score += 1;
  if (activeTransfers >= 4) score += 1;
  if (queued >= 8) score += 1;
  if (queued >= 24) score += 2;
  if (waits.high.maximumMs >= 250) score += 1;
  if (waits.high.maximumMs >= 1_000) score += 2;
  if (retries > 0) score += 1;
  if (retries >= 5) score += 1;
  if (transportErrors > 0) score += 3;
  if (score >= 4) return "high";
  if (score >= 2) return "moderate";
  return "low";
}

function summarize(values: readonly number[]): CongestionWaitSummary {
  return {
    samples: values.length,
    meanMs:
      values.length === 0
        ? 0
        : values.reduce((sum, value) => sum + value, 0) / values.length,
    maximumMs: values.length === 0 ? 0 : Math.max(...values),
  };
}

function isPriority(value: unknown): value is Priority {
  return value === "high" || value === "normal" || value === "bulk";
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
