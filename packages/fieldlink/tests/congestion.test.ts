import { describe, expect, it } from "vitest";

import { CongestionMonitor, type CongestionQueues } from "../src/congestion.js";

const emptyQueues: CongestionQueues = {
  pendingSends: 0,
  activeOutboundTransfers: 0,
  waitingOutboundTransfers: 0,
  activeInboundTransfers: 0,
  activePassiveInboundTransfers: 0,
  scheduledFrames: { high: 0, normal: 0, bulk: 0 },
  meshcoreQueueLength: 0,
};

describe("FieldLink congestion monitor", () => {
  it("reports idle when no traffic or queues exist", () => {
    const monitor = new CongestionMonitor();

    expect(monitor.snapshot(emptyQueues, 1_000)).toMatchObject({
      pressure: "idle",
      traffic: { framesSent: 0, bytesSent: 0, retries: 0 },
    });
  });

  it("reports high pressure from delayed high traffic and retries", () => {
    const monitor = new CongestionMonitor();
    monitor.record({
      type: "transfer-started",
      at: "1970-01-01T00:00:10.000Z",
      priority: "high",
      queueWaitMs: 1_200,
    });
    monitor.record({
      type: "frame-sent",
      at: "1970-01-01T00:00:10.100Z",
      priority: "high",
      bytes: 72,
      queueWaitMs: 50,
    });
    for (let retry = 0; retry < 4; retry += 1) {
      monitor.record({
        type: "transfer-retry",
        at: `1970-01-01T00:00:10.${200 + retry}Z`,
        phase: "fragment",
      });
    }

    const snapshot = monitor.snapshot(
      { ...emptyQueues, pendingSends: 8 },
      10_300,
    );

    expect(snapshot.pressure).toBe("high");
    expect(snapshot.traffic).toEqual({
      framesSent: 1,
      bytesSent: 72,
      retries: 4,
      transportErrors: 0,
    });
    expect(snapshot.waitMs.high).toMatchObject({
      samples: 2,
      maximumMs: 1_200,
    });
  });

  it("retains retry pressure even when a transfer later fails", () => {
    const monitor = new CongestionMonitor();
    monitor.record({
      type: "transfer-retry",
      at: "1970-01-01T00:00:10.000Z",
      phase: "open",
    });
    monitor.record({
      type: "transfer-failed",
      at: "1970-01-01T00:00:10.100Z",
      error: "receiver unavailable",
    });

    expect(monitor.snapshot(emptyQueues, 10_200).traffic.retries).toBe(1);
  });

  it("drops observations outside its one-minute window", () => {
    const monitor = new CongestionMonitor();
    monitor.record({
      type: "frame-sent",
      at: "1970-01-01T00:00:01.000Z",
      priority: "normal",
      bytes: 100,
      queueWaitMs: 10,
    });

    expect(monitor.snapshot(emptyQueues, 61_001).traffic.framesSent).toBe(0);
  });

  it("reports pressure from active inbound transfers without sent frames", () => {
    const monitor = new CongestionMonitor();

    expect(
      monitor.snapshot(
        {
          ...emptyQueues,
          activeInboundTransfers: 2,
          activePassiveInboundTransfers: 2,
        },
        1_000,
      ).pressure,
    ).toBe("moderate");
  });

  it("reports low pressure from one active outbound transfer", () => {
    const monitor = new CongestionMonitor();

    expect(
      monitor.snapshot({ ...emptyQueues, activeOutboundTransfers: 1 }, 1_000)
        .pressure,
    ).toBe("low");
  });
});
