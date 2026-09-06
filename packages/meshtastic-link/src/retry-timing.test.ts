import { describe, expect, it } from "vitest";
import { RetryTimingEstimator, type RetryTimingSample } from "./retry-timing.js";

const sample = (
  destination: string,
  measuredRttMs: number,
  observedAtMs: number,
  retransmitted = false
): RetryTimingSample => ({
  destination,
  measured_rtt_ms: measuredRttMs,
  observed_at_ms: observedAtMs,
  retransmitted
});

describe("RetryTimingEstimator", () => {
  it("uses the configured fixed interval before learning a peer", () => {
    const estimator = new RetryTimingEstimator({ fallback_ms: 5_000 });

    expect(estimator.estimate("asset-a", 0)).toBe(5_000);
  });

  it("learns only a non-retransmitted confirmed RTT with conservative variation", () => {
    const estimator = new RetryTimingEstimator({
      fallback_ms: 5_000,
      minimum_delay_ms: 1_000,
      maximum_delay_ms: 20_000
    });

    expect(estimator.observe(sample("asset-a", 1_000, 0, true))).toBe(false);
    expect(estimator.estimate("asset-a", 1)).toBe(5_000);

    expect(estimator.observe(sample("asset-a", 1_000, 2))).toBe(true);
    expect(estimator.estimate("asset-a", 2)).toBe(3_000);
    expect(estimator.observe(sample("asset-a", 1_200, 3))).toBe(true);
    expect(estimator.estimate("asset-a", 3)).toBe(2_725);
  });

  it("keeps RTT state isolated by destination", () => {
    const estimator = new RetryTimingEstimator({ fallback_ms: 5_000, minimum_delay_ms: 1_000 });

    estimator.observe(sample("asset-a", 1_000, 0));

    expect(estimator.estimate("asset-a", 0)).toBe(3_000);
    expect(estimator.estimate("asset-b", 0)).toBe(5_000);
  });

  it("applies the native-mesh floor to unusually small learned samples", () => {
    const estimator = new RetryTimingEstimator({
      fallback_ms: 5_000,
      maximum_delay_ms: 20_000
    });

    estimator.observe(sample("asset-a", 50, 0));

    expect(estimator.estimate("asset-a", 0)).toBe(2_000);
  });

  it("expires stale peer state back to the cold-start fallback", () => {
    const estimator = new RetryTimingEstimator({ fallback_ms: 5_000, peer_ttl_ms: 1_000 });
    estimator.observe(sample("asset-a", 1_000, 100));

    expect(estimator.estimate("asset-a", 1_099)).toBe(3_000);
    expect(estimator.estimate("asset-a", 1_100)).toBe(5_000);
  });

  it("caps peer state and evicts the least recently observed destination", () => {
    const estimator = new RetryTimingEstimator({ fallback_ms: 5_000, max_peers: 2 });
    estimator.observe(sample("asset-a", 1_000, 0));
    estimator.observe(sample("asset-b", 2_000, 1));
    estimator.observe(sample("asset-c", 3_000, 2));

    expect(estimator.estimate("asset-a", 2)).toBe(5_000);
    expect(estimator.estimate("asset-b", 2)).toBe(6_000);
    expect(estimator.estimate("asset-c", 2)).toBe(9_000);
  });

  it("bounds an extreme outlier and recovers with later uncontaminated samples", () => {
    const estimator = new RetryTimingEstimator({
      fallback_ms: 5_000,
      minimum_delay_ms: 1_000,
      maximum_delay_ms: 10_000
    });
    estimator.observe(sample("asset-a", 1_000, 0));
    estimator.observe(sample("asset-a", Number.MAX_VALUE, 1));

    expect(estimator.estimate("asset-a", 1)).toBe(10_000);
    for (let time = 2; time <= 40; time++) estimator.observe(sample("asset-a", 1_000, time));
    expect(estimator.estimate("asset-a", 40)).toBeLessThan(5_000);
  });

  it("ignores invalid RTT samples without changing cold-start behavior", () => {
    const estimator = new RetryTimingEstimator({ fallback_ms: 5_000 });

    expect(estimator.observe(sample("asset-a", 0, 0))).toBe(false);
    expect(estimator.observe(sample("asset-a", Number.NaN, 1))).toBe(false);
    expect(estimator.estimate("asset-a", 1)).toBe(5_000);
  });
});
