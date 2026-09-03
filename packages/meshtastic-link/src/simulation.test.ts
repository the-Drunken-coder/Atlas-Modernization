import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.js";
import { SimulatedPacketNetwork } from "./simulation.js";

describe("simulated packet network", () => {
  it("allows simultaneous transmissions in disconnected radio neighborhoods", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({
      seed: 1,
      clock,
      hopLimit: 1,
      propagationDelayMs: 0,
      relayDelayMs: 0,
      contentionWindowAirtimes: 0
    });
    const alpha = network.addRadio("alpha", 1);
    const alphaPeer = network.addRadio("alpha-peer", 2);
    const bravo = network.addRadio("bravo", 3);
    const bravoPeer = network.addRadio("bravo-peer", 4);
    network.connect("alpha", "alpha-peer");
    network.connect("bravo", "bravo-peer");
    let alphaReceived = 0;
    let bravoReceived = 0;
    alphaPeer.onPacket(() => alphaReceived++);
    bravoPeer.onPacket(() => bravoReceived++);
    const payload = Uint8Array.of(1);

    await alpha.send(payload, { channel: 1 });
    await bravo.send(payload, { channel: 1 });

    expect(alpha.pacingDelayMs(payload)).toBeCloseTo(bravo.pacingDelayMs(payload));
    await clock.runUntilIdle();
    expect({ alphaReceived, bravoReceived }).toEqual({ alphaReceived: 1, bravoReceived: 1 });
  });

  it("models a hidden-terminal collision at a shared receiver", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({
      seed: 2,
      clock,
      hopLimit: 1,
      propagationDelayMs: 0,
      relayDelayMs: 0,
      contentionWindowAirtimes: 0
    });
    const alpha = network.addRadio("alpha", 1);
    const receiver = network.addRadio("receiver", 2);
    const bravo = network.addRadio("bravo", 3);
    network.connect("alpha", "receiver");
    network.connect("bravo", "receiver");
    let received = 0;
    receiver.onPacket(() => received++);

    await alpha.send(Uint8Array.of(1), { channel: 1 });
    await bravo.send(Uint8Array.of(2), { channel: 1 });
    await clock.runUntilIdle();

    expect(received).toBe(0);
    expect(network.metrics()).toMatchObject({ mesh_transmissions: 2, collided_packets: 2 });
  });
});
