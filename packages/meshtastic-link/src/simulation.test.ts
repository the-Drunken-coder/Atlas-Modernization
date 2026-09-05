import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.js";
import { SimulatedPacketNetwork } from "./simulation.js";

describe("simulated packet network", () => {
  it.each([
    [1, false],
    [3, true]
  ] as const)("respects hop limit %i across a three-link path", async (hopLimit, expected) => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 42, clock, hopLimit });
    const source = network.addRadio("source", 101);
    network.addRadio("relay-one", 102);
    network.addRadio("relay-two", 103);
    const destination = network.addRadio("destination", 104);
    network.connect("source", "relay-one");
    network.connect("relay-one", "relay-two");
    network.connect("relay-two", "destination");
    let received = false;
    destination.onPacket(() => {
      received = true;
    });
    await source.send(Uint8Array.of(1), { channel: 1 });
    await clock.runUntilIdle();
    expect(received).toBe(expected);
  });

  it("rejects duplicate numeric radio identities", () => {
    const network = new SimulatedPacketNetwork({ seed: 1, clock: new VirtualClock() });
    network.addRadio("alpha", 2);
    expect(() => network.addRadio("bravo")).toThrow("node number 2 already exists");
  });

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
