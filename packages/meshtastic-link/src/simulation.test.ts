import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.js";
import type { RadioPacket } from "./radio.js";
import { SimulatedPacketNetwork } from "./simulation.js";

describe("simulated packet network", () => {
  it("rejects duplicate numeric radio identities", () => {
    const network = new SimulatedPacketNetwork({ seed: 1, clock: new VirtualClock() });
    network.addRadio("alpha", 2);
    expect(() => network.addRadio("bravo")).toThrow("node number 2 already exists");
  });

  it("accounts for response metadata in payload limits, airtime, and received packet IDs", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 1, clock, hopLimit: 1, contentionWindowAirtimes: 0 });
    const source = network.addRadio("source", 1);
    const receiver = network.addRadio("receiver", 2);
    network.connect("source", "receiver");
    const received: RadioPacket[] = [];
    receiver.onPacket((packet) => received.push(packet));
    const plain = { channel: 1 };
    const response = { channel: 1, request_id: 123 };
    expect(source.maxPayloadBytes(plain)).toBe(231);
    expect(source.maxPayloadBytes(response)).toBe(226);
    await expect(source.send(new Uint8Array(227), response)).rejects.toThrow("native send budget");
    await source.send(new Uint8Array(226), plain);
    await clock.runUntilIdle();
    const plainAirtime = network.metrics().modeled_airtime_ms;
    await source.send(new Uint8Array(226), response);
    await clock.runUntilIdle();
    expect(plainAirtime).toBe(network.airtimeMs(226));
    expect(network.metrics().modeled_airtime_ms - plainAirtime).toBeCloseTo(network.airtimeMs(231));
    expect(received.map((packet) => packet.radio_packet_id)).toEqual([1, 2]);
    expect(received.every((packet) => packet.payload.byteLength === 226)).toBe(true);
  });

  it("models directed PRIVATE_APP traffic as PKI on channel zero", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 1, clock, hopLimit: 1 });
    const source = network.addRadio("source", 1);
    const receiver = network.addRadio("receiver", 2);
    network.connect("source", "receiver");
    const received: RadioPacket[] = [];
    receiver.onPacket((packet) => received.push(packet));
    await source.send(new Uint8Array(219), { channel: 1, destination_radio_node: 2 });
    await clock.runUntilIdle();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ public_key_encrypted: true, channel: 0 });
    expect(network.metrics().modeled_airtime_ms).toBe(network.airtimeMs(231));
    await expect(source.send(new Uint8Array(220), { channel: 1, destination_radio_node: 2 })).rejects.toThrow(
      "native send budget"
    );
    await expect(source.send(new Uint8Array(1), { channel: 0, require_public_key: true })).rejects.toThrow(
      "requires a destination"
    );
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
