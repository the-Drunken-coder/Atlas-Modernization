import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { decodeFrame, FrameKind } from "../src/frame.js";
import { attachResourceRequestHandler } from "../src/messages/resource.js";
import type { ObservationMessage } from "../src/messages/observation.js";
import {
  FieldLinkNode,
  parseNodeId,
  type FieldLinkTransport,
  type NodeId,
  type ReceivedMessage,
  type TransportDatagram,
} from "../src/node.js";
import { attachFieldLinkPicture, FieldLinkPicture } from "../src/picture.js";
import { eventually } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 10,
      }),
    ),
  );
});

describe("faulted four-node mission transport", () => {
  it("builds a passive shared picture while isolating addressed traffic and recovering a dropped fragment", async () => {
    const network = new FaultedBroadcastNetwork();
    const gateway = node(network, "gateway", "1111111111111111");
    const observer = node(network, "observer", "aaaaaaaaaaaaaaaa");
    const follower = node(network, "follower", "bbbbbbbbbbbbbbbb");
    const relay = node(network, "relay", "cccccccccccccccc");
    const nodes = [gateway, observer, follower, relay] as const;
    const pictures = await Promise.all(
      nodes.map(async ({ name, node }) => {
        const directory = await mkdtemp(join(tmpdir(), `fieldlink-${name}-`));
        temporaryDirectories.push(directory);
        const picture = await FieldLinkPicture.open({
          path: join(directory, "picture.json"),
          maximumJournalEntries: 16,
          maximumLatestEntries: 16,
          maximumSeenEntries: 32,
          maximumStoredBytes: 256 * 1024,
        });
        return { picture, detach: attachFieldLinkPicture(node, picture) };
      }),
    );

    network.mode = "duplicate-and-reorder";
    const observation = trackObservation("x".repeat(2_048));
    await observer.node.publish(observation);
    await network.settle();
    await eventually(() =>
      pictures.every(
        ({ picture }) => picture.latest("track", "track-shared") !== undefined,
      ),
    );

    for (const { picture } of pictures) {
      expect(picture.latest("track", "track-shared")?.body).toEqual(
        observation.body,
      );
      expect(picture.journal()).toHaveLength(1);
    }

    network.mode = "none";
    const followerTasks: ReceivedMessage[] = [];
    const relayAddressed: ReceivedMessage[] = [];
    follower.node.onMessage((received) => {
      if (received.message.type === "task") followerTasks.push(received);
    });
    relay.node.onMessage((received) => {
      relayAddressed.push(received);
    });
    await gateway.node.send(
      {
        type: "task",
        kind: "state",
        task: {
          task_id: "task-follow-track",
          asset_id: "asset-follower",
          status: "pending",
        },
      },
      { destination: follower.node.nodeId },
    );
    expect(followerTasks).toHaveLength(1);
    expect(relayAddressed).toHaveLength(0);

    const responses: ReceivedMessage[] = [];
    observer.node.onMessage((received) => {
      if (
        received.message.type === "resource" &&
        received.message.kind === "response"
      ) {
        responses.push(received);
      }
    });
    const detachResource = attachResourceRequestHandler(
      gateway.node,
      {
        execute: (request) =>
          Promise.resolve({
            type: "resource",
            kind: "response",
            request_id: request.request_id,
            status: 201,
            body: { stored: true },
          }),
      },
      observer.node.nodeId,
    );

    network.mode = "drop-one-fragment";
    const result = await observer.node.send(
      {
        type: "resource",
        kind: "request",
        operation: "create",
        request_id: "create-track",
        resource_type: "entity",
        body: {
          entity_id: "track-shared",
          entity_type: "track",
          extra: { samples: "x".repeat(4_096) },
        },
      },
      { destination: gateway.node.nodeId },
    );
    await network.settle();

    expect(network.droppedFragment).toBe(true);
    expect(result.retransmissions).toBeGreaterThanOrEqual(1);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.message).toMatchObject({
      type: "resource",
      kind: "response",
      request_id: "create-track",
      status: 201,
    });
    expect(relayAddressed).toHaveLength(0);
    expect(network.listenerErrors).toEqual([]);

    await detachResource();
    for (const entry of pictures) {
      entry.detach();
      await entry.picture.close();
    }
    await Promise.all(nodes.map(({ node }) => node.close()));
  }, 10_000);
});

function node(
  network: FaultedBroadcastNetwork,
  name: string,
  id: string,
): { name: string; node: FieldLinkNode } {
  return {
    name,
    node: new FieldLinkNode({
      nodeId: parseNodeId(id),
      transport: network.add(name, parseNodeId(id)),
      retryTimeoutMs: 100,
    }),
  };
}

function trackObservation(payload: string): ObservationMessage {
  return {
    type: "observation",
    observation_id: "track-shared-1",
    observed_at: "2026-08-26T18:00:00.000Z",
    resource_type: "track",
    resource_id: "track-shared",
    body: {
      track_id: "track-shared",
      latitude: 42.274,
      longitude: -71.806,
      payload,
    },
  };
}

type FaultMode = "none" | "duplicate-and-reorder" | "drop-one-fragment";

class FaultedBroadcastNetwork {
  readonly transports: FaultedBroadcastTransport[] = [];
  readonly listenerErrors: Error[] = [];
  mode: FaultMode = "none";
  droppedFragment = false;
  #heldForRelay: TransportDatagram | undefined;

  add(name: string, id: NodeId): FaultedBroadcastTransport {
    const transport = new FaultedBroadcastTransport(this, name, id);
    this.transports.push(transport);
    return transport;
  }

  async broadcast(
    sender: FaultedBroadcastTransport,
    bytes: Uint8Array,
  ): Promise<void> {
    const frame = decodeFrame(bytes);
    for (const target of this.transports) {
      if (target === sender) continue;
      if (
        this.mode === "drop-one-fragment" &&
        sender.name === "observer" &&
        target.name === "gateway" &&
        frame.kind === FrameKind.fragment &&
        frame.fragmentIndex === 1 &&
        !this.droppedFragment
      ) {
        this.droppedFragment = true;
        continue;
      }
      const datagram = { bytes: bytes.slice(), snrDb: -7, pathLength: 1 };
      if (
        this.mode === "duplicate-and-reorder" &&
        sender.name === "observer" &&
        target.name === "relay" &&
        frame.kind === FrameKind.fragment &&
        frame.fragmentIndex === 0
      ) {
        this.#heldForRelay = datagram;
        continue;
      }
      await target.deliver(datagram);
      if (this.mode === "duplicate-and-reorder") {
        await target.deliver(datagram);
      }
      if (
        this.#heldForRelay !== undefined &&
        target.name === "relay" &&
        frame.kind === FrameKind.fragment &&
        frame.fragmentIndex === 1
      ) {
        const held = this.#heldForRelay;
        this.#heldForRelay = undefined;
        await target.deliver(held);
        await target.deliver(held);
      }
    }
  }

  async settle(): Promise<void> {
    await Promise.all(this.transports.map((transport) => transport.settle()));
  }
}

class FaultedBroadcastTransport implements FieldLinkTransport {
  readonly #listeners = new Set<
    (datagram: TransportDatagram) => void | Promise<void>
  >();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    readonly network: FaultedBroadcastNetwork,
    readonly name: string,
    readonly id: NodeId,
  ) {}

  async send(bytes: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("transport closed");
    await this.network.broadcast(this, bytes.slice());
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
    this.#closed = true;
    return Promise.resolve();
  }

  deliver(datagram: TransportDatagram): Promise<void> {
    this.#tail = this.#tail.then(async () => {
      for (const listener of this.#listeners) {
        await Promise.resolve(
          listener({ ...datagram, bytes: datagram.bytes.slice() }),
        ).catch((error: unknown) => {
          this.network.listenerErrors.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }
    });
    return this.#tail;
  }

  async settle(): Promise<void> {
    for (;;) {
      const tail = this.#tail;
      await tail;
      if (tail === this.#tail) return;
    }
  }
}
