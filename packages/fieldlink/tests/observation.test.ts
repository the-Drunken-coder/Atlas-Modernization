import { describe, expect, it } from "vitest";

import { decodeFrame, FrameKind } from "../src/frame.js";
import {
  observationMessage,
  type ObservationMessage,
} from "../src/messages/observation.js";
import {
  FieldLinkNode,
  parseNodeId,
  type FieldLinkTransport,
  type TransportDatagram,
} from "../src/node.js";

describe("Observation publication", () => {
  it("round-trips valid state and rejects non-finite JSON", () => {
    for (const example of observationMessage.examples) {
      expect(observationMessage.validate(example)).toBe(true);
      expect(
        observationMessage.decode(observationMessage.encode(example)),
      ).toEqual(example);
    }
    expect(
      observationMessage.validate({
        ...observationMessage.examples[0],
        body: { latitude: Number.NaN },
      }),
    ).toBe(false);
  });

  it("requires an ISO timestamp with an explicit time zone", () => {
    const example = observationMessage.examples[0];
    expect(example).toBeDefined();
    expect(
      observationMessage.validate({
        ...example,
        observed_at: "2026-08-26T12:00:00+04:00",
      }),
    ).toBe(true);
    expect(
      observationMessage.validate({
        ...example,
        observed_at: "2026-08-26T12:00:00",
      }),
    ).toBe(false);
    expect(
      observationMessage.validate({
        ...example,
        observed_at: "2026-08-26 12:00:00Z",
      }),
    ).toBe(false);
    expect(
      observationMessage.validate({
        ...example,
        observed_at: "2026-02-30T12:00:00Z",
      }),
    ).toBe(false);
  });

  it("publishes one unconfirmed transfer that every listener collects", async () => {
    const network = new BroadcastMemoryNetwork();
    const aTransport = network.add();
    const bTransport = network.add();
    const cTransport = network.add();
    const a = new FieldLinkNode({
      nodeId: parseNodeId("aaaaaaaaaaaaaaaa"),
      transport: aTransport,
    });
    const b = new FieldLinkNode({
      nodeId: parseNodeId("bbbbbbbbbbbbbbbb"),
      transport: bTransport,
    });
    const c = new FieldLinkNode({
      nodeId: parseNodeId("cccccccccccccccc"),
      transport: cTransport,
    });
    const observedByA: unknown[] = [];
    const observedByB: unknown[] = [];
    const observedByC: unknown[] = [];
    const addressed: unknown[] = [];
    a.onPassiveMessage((message) => {
      observedByA.push(message.message);
    });
    b.onPassiveMessage((message) => {
      observedByB.push(message.message);
    });
    c.onPassiveMessage((message) => {
      observedByC.push(message.message);
    });
    b.onMessage((message) => {
      addressed.push(message.message);
    });
    const message = trackObservation("x".repeat(512));

    const result = await a.publish(message);

    expect(result).toMatchObject({
      delivery: "transfer",
      confirmed: false,
      messageName: "observation",
    });
    expect(observedByA).toEqual([message]);
    expect(observedByB).toEqual([message]);
    expect(observedByC).toEqual([message]);
    expect(addressed).toEqual([]);
    const kinds = aTransport.sent.map((bytes) => decodeFrame(bytes).kind);
    expect(kinds[0]).toBe(FrameKind.transferStart);
    expect(kinds.slice(1).every((kind) => kind === FrameKind.fragment)).toBe(
      true,
    );
    expect(bTransport.sent).toEqual([]);
    expect(cTransport.sent).toEqual([]);

    await Promise.all([a.close(), b.close(), c.close()]);
  });

  it("collects a directed Observation without invoking a foreign handler", async () => {
    const network = new BroadcastMemoryNetwork();
    const a = new FieldLinkNode({
      nodeId: parseNodeId("aaaaaaaaaaaaaaaa"),
      transport: network.add(),
    });
    const b = new FieldLinkNode({
      nodeId: parseNodeId("bbbbbbbbbbbbbbbb"),
      transport: network.add(),
    });
    const c = new FieldLinkNode({
      nodeId: parseNodeId("cccccccccccccccc"),
      transport: network.add(),
    });
    const addressed: unknown[] = [];
    const passive: unknown[] = [];
    b.onMessage((message) => {
      addressed.push(message.message);
    });
    c.onPassiveMessage((message) => {
      passive.push(message.message);
    });
    const message = trackObservation("x".repeat(512));

    await a.send(message, { destination: b.nodeId });

    expect(addressed).toEqual([message]);
    expect(passive).toEqual([message]);
    await Promise.all([a.close(), b.close(), c.close()]);
  });
});

function trackObservation(payload: string): ObservationMessage {
  return {
    type: "observation",
    observation_id: "observation-track-1-42",
    observed_at: "2026-08-26T12:00:00.000Z",
    resource_type: "track",
    resource_id: "track-1",
    body: { track_id: "track-1", payload },
  };
}

class BroadcastMemoryNetwork {
  readonly transports: BroadcastMemoryTransport[] = [];

  add(): BroadcastMemoryTransport {
    const transport = new BroadcastMemoryTransport(this);
    this.transports.push(transport);
    return transport;
  }
}

class BroadcastMemoryTransport implements FieldLinkTransport {
  readonly sent: Uint8Array[] = [];
  readonly #network: BroadcastMemoryNetwork;
  readonly #listeners = new Set<
    (datagram: TransportDatagram) => void | Promise<void>
  >();

  constructor(network: BroadcastMemoryNetwork) {
    this.#network = network;
  }

  async send(bytes: Uint8Array): Promise<void> {
    this.sent.push(bytes.slice());
    for (const transport of this.#network.transports) {
      if (transport === this) continue;
      await transport.deliver({ bytes: bytes.slice(), snrDb: -7 });
    }
  }

  getQueueLength(): Promise<number> {
    return Promise.resolve(0);
  }

  onDatagram(
    listener: (datagram: TransportDatagram) => void | Promise<void>,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  async deliver(datagram: TransportDatagram): Promise<void> {
    for (const listener of this.#listeners) {
      await listener(datagram);
    }
  }
}
