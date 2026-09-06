import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.js";
import { FaultRadio } from "./experiments/fault-radio.js";
import { createGatewayFleetExperiment } from "./experiments/fleet.js";
import { decodeFrame } from "./frame.js";
import { SimulatedPacketNetwork } from "./simulation.js";
import { isStateDeltaPayload } from "./state-delta.js";
import { positionPublication } from "./test-fixtures.js";
import { LinkTransport, type TransportOptions } from "./transport.js";
import type { LinkMessage } from "./types.js";

function pair(
  options: Pick<TransportOptions, "stateDeltas" | "adaptiveRetries" | "retryIntervalMs"> = {},
  dropFirstState = false
) {
  const clock = new VirtualClock();
  const network = new SimulatedPacketNetwork({ seed: 42, clock, contentionWindowAirtimes: 0 });
  const assetRadio = network.addRadio("asset-a");
  const gatewayRadio = new FaultRadio(
    network.addRadio("gateway"),
    "gateway",
    dropFirstState
      ? [
          {
            source: "asset-a",
            receiver: "gateway",
            message_type: "state",
            operation_id: "position-1",
            action: "drop",
            count: 1,
            after_ms: 0,
            before_ms: 1000
          }
        ]
      : [],
    () => clock.now(),
    227
  );
  network.connect("asset-a", "gateway");
  const asset = new LinkTransport({
    node: { role: "asset", id: "asset-a" },
    radio: assetRadio,
    clock,
    sourceGeneration: 1,
    serviceSession: "asset-session",
    frameEncoding: "binary-v1",
    privateChannel: 0,
    ...options
  });
  const gateway = new LinkTransport({
    node: { role: "gateway", id: "gateway" },
    radio: gatewayRadio,
    clock,
    sourceGeneration: 1,
    serviceSession: "gateway-session",
    frameEncoding: "binary-v1",
    privateChannel: 0,
    ...options
  });
  return {
    clock,
    asset,
    gateway,
    gatewayRadio,
    async close() {
      asset.stop();
      gateway.stop();
      await assetRadio.close();
      await gatewayRadio.close();
    }
  };
}

describe("optimized production transport", () => {
  it("recovers from a lost baseline with a later full state, without accepting dependent deltas", async () => {
    const harness = pair({ stateDeltas: true }, true);
    const accepted: LinkMessage[] = [];
    harness.gateway.onEvent((event) => {
      if (event.type === "message") accepted.push(event.message);
    });
    try {
      for (let version = 1; version <= 5; version++) {
        harness.asset.submit(positionPublication(version));
        await harness.clock.advanceBy(5_000);
      }
      expect(harness.gatewayRadio.observations.dropped_packets).toBe(1);
      expect(accepted).toEqual([positionPublication(4), positionPublication(5)]);
      expect(harness.gateway.metrics().invalid_messages).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("never bases an update on a full publication that was coalesced before transmission", async () => {
    const harness = pair({ stateDeltas: true });
    const accepted: LinkMessage[] = [];
    const sentPayloads: Uint8Array[] = [];
    harness.gatewayRadio.onPacket((packet) => sentPayloads.push(decodeFrame(packet.payload).payload));
    harness.gateway.onEvent((event) => {
      if (event.type === "message") accepted.push(event.message);
    });
    try {
      harness.asset.submit(positionPublication(1));
      harness.asset.submit(positionPublication(2));
      await harness.clock.advanceBy(5_000);
      harness.asset.submit(positionPublication(3));
      await harness.clock.advanceBy(5_000);
      expect(accepted).toEqual([positionPublication(2), positionPublication(3)]);
      expect(sentPayloads.map(isStateDeltaPayload)).toEqual([false, true]);
    } finally {
      await harness.close();
    }
  });

  it.each([undefined, 4_000])("learns retry timing while respecting a fixed override (%s)", async (retryIntervalMs) => {
    const harness = pair({ adaptiveRetries: true, ...(retryIntervalMs === undefined ? {} : { retryIntervalMs }) });
    const command = createGatewayFleetExperiment().messages.find((message) => message.response);
    if (!command || command.message.type !== "task_delivery") throw new Error("Missing Task fixture");
    const sent: number[] = [];
    harness.asset.onEvent((event) => {
      if (event.type === "message" && event.operation_id === "first")
        harness.asset.settleInbound(event.settlement_id, true);
    });
    harness.gateway.onEvent((event) => {
      if (event.type === "packet_sent" && event.operation_id === "second") sent.push(event.sent_at);
    });
    try {
      harness.gateway.submit(command.message, { operationID: "first", destination: { role: "asset", id: "asset-a" } });
      await harness.clock.advanceBy(5_000);
      expect(harness.gateway.status("first")?.status).toBe("confirmed");
      harness.gateway.submit(
        { ...command.message, task: { ...command.message.task, task_id: "second" } },
        {
          operationID: "second",
          destination: { role: "asset", id: "asset-a" }
        }
      );
      await harness.clock.advanceBy(14_999);
      expect(sent.length).toBeGreaterThan(1);
      expect(sent[1]! - sent[0]!).toBe(retryIntervalMs ?? 2_000);
      await harness.clock.advanceBy(1);
      expect(harness.gateway.status("second")).toMatchObject({
        status: "failed",
        reason: "confirmation deadline expired"
      });
    } finally {
      await harness.close();
    }
  });
});

it("does not learn confirmation RTT from a rejected radio send followed by a successful retry", async () => {
  const harness = pair({ adaptiveRetries: true });
  const send = harness.gatewayRadio.send.bind(harness.gatewayRadio);
  let fail = true;
  harness.gatewayRadio.send = async (payload, options) => {
    if (fail) {
      fail = false;
      throw new Error("local admission unavailable");
    }
    return send(payload, options);
  };
  const command = createGatewayFleetExperiment().messages.find((message) => message.response);
  if (!command || command.message.type !== "task_delivery") throw new Error("Missing Task fixture");
  const sent: number[] = [];
  harness.asset.onEvent((event) => {
    if (event.type === "message" && event.operation_id === "first")
      harness.asset.settleInbound(event.settlement_id, true);
  });
  harness.gateway.onEvent((event) => {
    if (event.type === "packet_sent" && event.operation_id === "second") sent.push(event.sent_at);
  });
  try {
    harness.gateway.submit(command.message, { operationID: "first", destination: { role: "asset", id: "asset-a" } });
    await harness.clock.advanceBy(6_000);
    expect(harness.gateway.status("first")?.status).toBe("confirmed");
    expect(harness.gateway.metrics().radio_send_failures).toBe(1);
    harness.gateway.submit(
      { ...command.message, task: { ...command.message.task, task_id: "second" } },
      {
        operationID: "second",
        destination: { role: "asset", id: "asset-a" }
      }
    );
    await harness.clock.advanceBy(5_001);
    expect(sent).toHaveLength(2);
    expect(sent[1]! - sent[0]!).toBe(5_000);
  } finally {
    await harness.close();
  }
});
