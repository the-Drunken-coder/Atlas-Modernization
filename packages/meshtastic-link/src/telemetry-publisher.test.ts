import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.js";
import { TelemetryPublisher, type TelemetrySample, telemetryPhaseMs } from "./telemetry-publisher.js";
import { positionPublication } from "./test-fixtures.js";
import type { StatePublication } from "./types.js";

describe("TelemetryPublisher", () => {
  it("assigns stable phases within a five-second period", () => {
    const periodMs = 5_000;
    const phases = ["asset-alpha", "asset-bravo", "gateway"].map((nodeID) => telemetryPhaseMs(nodeID, periodMs));

    expect(phases).toEqual([telemetryPhaseMs("asset-alpha", periodMs), ...phases.slice(1)]);
    expect(phases.every((phase) => phase >= 0 && phase < periodMs)).toBe(true);
    expect(new Set(phases).size).toBe(3);
  });

  it("samples and publishes at the stable phase without replaying stale values", async () => {
    const clock = new VirtualClock();
    const periodMs = 20_000;
    const phaseMs = telemetryPhaseMs("asset-charlie", periodMs);
    const sampledAt: number[] = [];
    const published: StatePublication[] = [];
    let version = 0;
    const publisher = new TelemetryPublisher({
      clock,
      nodeID: "asset-charlie",
      periodMs,
      sample: (at) => {
        sampledAt.push(at);
        return positionPublication(++version);
      },
      publish: (publication) => {
        published.push(publication);
      }
    });

    publisher.start();
    await clock.advanceTo(phaseMs + periodMs * 2 + 1);

    expect(sampledAt).toEqual([phaseMs, phaseMs + periodMs, phaseMs + periodMs * 2]);
    expect(published.map((publication) => publication.operation_id)).toEqual([
      "position-1",
      "position-2",
      "position-3"
    ]);
    publisher.stop();
  });

  it("keeps one pending sample and skips ticks while the source is slow", async () => {
    const clock = new VirtualClock();
    const periodMs = 20_000;
    const phaseMs = telemetryPhaseMs("gateway", periodMs);
    const sampledAt: number[] = [];
    const published: StatePublication[] = [];
    let resolveFirst: ((publication: StatePublication) => void) | undefined;
    let version = 0;
    const sample: TelemetrySample = (at) => {
      sampledAt.push(at);
      if (version === 0) {
        return new Promise<StatePublication>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return positionPublication(++version);
    };
    const publisher = new TelemetryPublisher({
      clock,
      nodeID: "gateway",
      periodMs,
      sample,
      publish: (publication) => {
        published.push(publication);
      }
    });

    publisher.start();
    await clock.advanceTo(phaseMs + periodMs * 3 + 1);
    expect(sampledAt).toEqual([phaseMs]);
    expect(published).toEqual([]);

    resolveFirst?.(positionPublication(++version));
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toEqual([]);

    await clock.advanceTo(phaseMs + periodMs * 4 + 1);
    expect(sampledAt).toEqual([phaseMs, phaseMs + periodMs * 4]);
    expect(published.map((publication) => publication.operation_id)).toEqual(["position-2"]);
    publisher.stop();
  });

  it("does not publish a sample that resolves after stop and restarts cleanly", async () => {
    const clock = new VirtualClock();
    const periodMs = 20_000;
    const phaseMs = telemetryPhaseMs("gateway", periodMs);
    const published: StatePublication[] = [];
    let resolveFirst: ((publication: StatePublication) => void) | undefined;
    let calls = 0;
    const publisher = new TelemetryPublisher({
      clock,
      nodeID: "gateway",
      periodMs,
      sample: () => {
        calls++;
        if (calls === 1) {
          return new Promise<StatePublication>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return positionPublication(2);
      },
      publish: (publication) => {
        published.push(publication);
      }
    });

    publisher.start();
    publisher.start();
    await clock.advanceTo(phaseMs);
    expect(calls).toBe(1);
    publisher.stop();
    await clock.advanceBy(1);
    publisher.start();
    await clock.advanceTo(phaseMs + periodMs + 1);
    expect(calls).toBe(1);
    expect(published).toEqual([]);

    resolveFirst?.(positionPublication(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toEqual([]);

    await clock.advanceTo(phaseMs + periodMs * 2 + 1);
    expect(calls).toBe(2);
    expect(published.map((publication) => publication.operation_id)).toEqual(["position-2"]);
    expect(publisher.running).toBe(true);
    publisher.stop();
  });
});
