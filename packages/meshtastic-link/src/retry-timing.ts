const DEFAULT_MINIMUM_DELAY_MS = 2_000;
const DEFAULT_MAXIMUM_DELAY_MS = 60_000;
const DEFAULT_PEER_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_PEERS = 64;
const DEFAULT_SMOOTHING_ALPHA = 1 / 8;
const DEFAULT_VARIATION_BETA = 1 / 4;

export type RetryTimingSample = {
  destination: string;
  measured_rtt_ms: number;
  observed_at_ms: number;
  retransmitted: boolean;
};

export type RetryTimingEstimatorOptions = {
  /** Existing fixed retry interval used until a peer has a valid sample. */
  fallback_ms: number;
  /** Minimum learned retry delay; keep this above a realistic native-mesh floor. */
  minimum_delay_ms?: number;
  /** Maximum learned retry delay; also bounds outlier influence. */
  maximum_delay_ms?: number;
  /** Time without a sample after which a peer returns to the cold-start fallback. */
  peer_ttl_ms?: number;
  /** Maximum number of destination states retained by the estimator. */
  max_peers?: number;
};

type PeerTimingState = {
  smoothed_rtt_ms: number;
  variation_ms: number;
  last_observed_at_ms: number;
  order: number;
};

/**
 * Estimates the next confirmation retry delay independently for each destination.
 *
 * Samples follow Karn's rule: callers must set `retransmitted` when the confirmed
 * operation reached its application confirmation only after a retry. Such samples
 * are ignored because their RTT is ambiguous. The estimator owns no deadlines and
 * never schedules retries; the transport remains responsible for both.
 */
export class RetryTimingEstimator {
  private readonly fallbackMs: number;
  private readonly minimumDelayMs: number;
  private readonly maximumDelayMs: number;
  private readonly peerTtlMs: number;
  private readonly maxPeers: number;
  private readonly peers = new Map<string, PeerTimingState>();
  private nextOrder = 0;

  constructor(options: RetryTimingEstimatorOptions) {
    this.fallbackMs = positiveFinite(options.fallback_ms, "fallback_ms");
    this.minimumDelayMs = positiveFinite(options.minimum_delay_ms ?? DEFAULT_MINIMUM_DELAY_MS, "minimum_delay_ms");
    this.maximumDelayMs = positiveFinite(options.maximum_delay_ms ?? DEFAULT_MAXIMUM_DELAY_MS, "maximum_delay_ms");
    if (this.maximumDelayMs < this.minimumDelayMs) {
      throw new RangeError("maximum_delay_ms must be at least minimum_delay_ms");
    }
    if (this.fallbackMs < this.minimumDelayMs || this.fallbackMs > this.maximumDelayMs) {
      throw new RangeError("fallback_ms must be within the learned delay bounds");
    }
    this.peerTtlMs = positiveFinite(options.peer_ttl_ms ?? DEFAULT_PEER_TTL_MS, "peer_ttl_ms");
    this.maxPeers = positiveInteger(options.max_peers ?? DEFAULT_MAX_PEERS, "max_peers");
  }

  /** Return a learned bounded estimate or the cold-start fallback. */
  estimate(destination: string, nowMs: number): number {
    this.validateDestination(destination);
    this.validateTime(nowMs, "nowMs");

    this.pruneExpired(nowMs);
    const state = this.peers.get(destination);
    if (!state) return this.fallbackMs;
    return this.bound(state.smoothed_rtt_ms + 4 * state.variation_ms);
  }

  /**
   * Learn from one confirmed outbound operation. Returns false when Karn's rule,
   * or invalid sample metadata prevents learning.
   */
  observe(sample: RetryTimingSample): boolean {
    this.validateDestination(sample.destination);
    this.validateTime(sample.observed_at_ms, "observed_at_ms");
    if (sample.retransmitted) return false;
    if (!Number.isFinite(sample.measured_rtt_ms) || sample.measured_rtt_ms <= 0) return false;

    this.pruneExpired(sample.observed_at_ms);
    const measuredRttMs = Math.min(sample.measured_rtt_ms, this.maximumDelayMs);
    const previous = this.peers.get(sample.destination);
    if (!previous) {
      this.ensurePeerCapacity();
      this.peers.set(sample.destination, {
        smoothed_rtt_ms: measuredRttMs,
        variation_ms: measuredRttMs / 2,
        last_observed_at_ms: sample.observed_at_ms,
        order: this.nextOrder++
      });
      return true;
    }

    previous.variation_ms =
      (1 - DEFAULT_VARIATION_BETA) * previous.variation_ms +
      DEFAULT_VARIATION_BETA * Math.abs(previous.smoothed_rtt_ms - measuredRttMs);
    previous.smoothed_rtt_ms =
      (1 - DEFAULT_SMOOTHING_ALPHA) * previous.smoothed_rtt_ms + DEFAULT_SMOOTHING_ALPHA * measuredRttMs;
    previous.last_observed_at_ms = sample.observed_at_ms;
    return true;
  }

  private bound(delayMs: number): number {
    return Math.min(this.maximumDelayMs, Math.max(this.minimumDelayMs, delayMs));
  }

  private ensurePeerCapacity(): void {
    if (this.peers.size < this.maxPeers) return;
    let oldestDestination: string | undefined;
    let oldestState: PeerTimingState | undefined;
    for (const [destination, state] of this.peers) {
      if (
        oldestState === undefined ||
        state.last_observed_at_ms < oldestState.last_observed_at_ms ||
        (state.last_observed_at_ms === oldestState.last_observed_at_ms && state.order < oldestState.order)
      ) {
        oldestDestination = destination;
        oldestState = state;
      }
    }
    if (oldestDestination !== undefined) this.peers.delete(oldestDestination);
  }

  private pruneExpired(nowMs: number): void {
    for (const [destination, state] of this.peers) {
      if (nowMs - state.last_observed_at_ms >= this.peerTtlMs) this.peers.delete(destination);
    }
  }

  private validateDestination(destination: string): void {
    if (typeof destination !== "string" || destination.trim() === "") {
      throw new TypeError("destination must be a non-empty string");
    }
  }

  private validateTime(value: number, name: string): void {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
