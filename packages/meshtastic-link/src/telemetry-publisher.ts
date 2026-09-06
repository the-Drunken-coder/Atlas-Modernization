import type { Clock, TimerHandle } from "./clock.js";
import type { LinkOperationResult, StatePublication } from "./types.js";

export type TelemetrySample = (sampledAt: number) => StatePublication | PromiseLike<StatePublication>;

export type TelemetryPublish = (
  publication: StatePublication
) => LinkOperationResult | void | PromiseLike<LinkOperationResult | void>;

export type TelemetryPublisherOptions = {
  clock: Clock;
  nodeID: string;
  periodMs: number;
  sample: TelemetrySample;
  publish: TelemetryPublish;
  onError?: (error: unknown) => void;
};

export function telemetryPhaseMs(nodeID: string, periodMs: number): number {
  validateNodeID(nodeID);
  validatePeriod(periodMs);
  return stableHash(nodeID) % periodMs;
}

/**
 * Schedules application-owned telemetry samples on a stable phase without queuing
 * another sample while the current sample or publication is still pending.
 */
export class TelemetryPublisher {
  readonly phaseMs: number;
  private readonly clock: Clock;
  private readonly periodMs: number;
  private readonly sample: TelemetrySample;
  private readonly publish: TelemetryPublish;
  private readonly onError: (error: unknown) => void;
  private timer: TimerHandle | undefined;
  private generation = 0;
  private pendingGeneration: number | undefined;
  private runningState = false;

  constructor(options: TelemetryPublisherOptions) {
    validateNodeID(options.nodeID);
    validatePeriod(options.periodMs);
    this.clock = options.clock;
    this.periodMs = options.periodMs;
    this.sample = options.sample;
    this.publish = options.publish;
    this.onError = options.onError ?? (() => undefined);
    this.phaseMs = telemetryPhaseMs(options.nodeID, options.periodMs);
  }

  get running(): boolean {
    return this.runningState;
  }

  start(): void {
    if (this.runningState) return;
    this.runningState = true;
    const generation = ++this.generation;
    this.schedule(generation, nextEmissionAt(this.clock.now(), this.phaseMs, this.periodMs));
  }

  stop(): void {
    if (!this.runningState && this.timer === undefined) return;
    this.runningState = false;
    this.generation++;
    if (this.timer !== undefined) this.clock.cancel(this.timer);
    this.timer = undefined;
  }

  private schedule(generation: number, targetAt: number): void {
    if (!this.isCurrent(generation)) return;
    this.timer = this.clock.schedule(Math.max(0, targetAt - this.clock.now()), () => {
      if (!this.isCurrent(generation)) return;
      this.timer = undefined;
      this.schedule(generation, nextEmissionAfter(targetAt, this.clock.now(), this.periodMs));
      this.emit(generation);
    });
  }

  private emit(generation: number): void {
    if (!this.isCurrent(generation) || this.pendingGeneration !== undefined) return;
    this.pendingGeneration = generation;

    const sampledAt = this.clock.now();
    let sampled: StatePublication | PromiseLike<StatePublication>;
    try {
      sampled = this.sample(sampledAt);
    } catch (error) {
      this.fail(generation, error);
      return;
    }

    if (isPromiseLike(sampled)) {
      try {
        void sampled.then(
          (publication) => this.publishSample(generation, sampledAt, publication),
          (error) => this.fail(generation, error)
        );
      } catch (error) {
        this.fail(generation, error);
      }
      return;
    }

    this.publishSample(generation, sampledAt, sampled);
  }

  private publishSample(generation: number, sampledAt: number, publication: StatePublication): void {
    if (!this.isCurrent(generation)) {
      this.complete(generation);
      return;
    }
    if (this.clock.now() - sampledAt >= this.periodMs) {
      this.complete(generation);
      return;
    }

    let result: LinkOperationResult | void | PromiseLike<LinkOperationResult | void>;
    try {
      result = this.publish(publication);
    } catch (error) {
      this.fail(generation, error);
      return;
    }

    if (isPromiseLike(result)) {
      try {
        void result.then(
          () => this.complete(generation),
          (error) => this.fail(generation, error)
        );
      } catch (error) {
        this.fail(generation, error);
      }
      return;
    }

    this.complete(generation);
  }

  private complete(generation: number): void {
    if (this.pendingGeneration === generation) this.pendingGeneration = undefined;
  }

  private fail(generation: number, error: unknown): void {
    if (this.isCurrent(generation)) this.reportError(error);
    this.complete(generation);
  }

  private isCurrent(generation: number): boolean {
    return this.runningState && this.generation === generation;
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // Error reporting must not stop future application-owned samples.
    }
  }
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof (value as PromiseLike<T>).then === "function";
}

function nextEmissionAt(now: number, phaseMs: number, periodMs: number): number {
  if (now <= phaseMs) return phaseMs;
  return phaseMs + (Math.floor((now - phaseMs) / periodMs) + 1) * periodMs;
}

function nextEmissionAfter(targetAt: number, now: number, periodMs: number): number {
  let next = targetAt + periodMs;
  if (next <= now) next += (Math.floor((now - next) / periodMs) + 1) * periodMs;
  return next;
}

function validateNodeID(nodeID: string): void {
  if (!nodeID.trim()) throw new TypeError("telemetry node ID must not be empty");
}

function validatePeriod(periodMs: number): void {
  if (!Number.isSafeInteger(periodMs) || periodMs < 1) {
    throw new RangeError("telemetry period must be a positive safe integer");
  }
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
