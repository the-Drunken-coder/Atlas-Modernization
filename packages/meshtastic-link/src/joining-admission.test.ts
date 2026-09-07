import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LINK_PROTOCOL_REVISION, RADIO_CONTRACT_REVISION } from "./contract.js";
import {
  type DiscoveryBeacon,
  decodeJoinMessage,
  encodeJoinMessage,
  type GatewayAuthenticationPolicy,
  GatewayJoinService
} from "./joining.js";
import { GatewayMembershipStore } from "./membership.js";
import type { LinkRadio, RadioPacket, RadioSendOptions } from "./radio.js";

vi.mock("./types.js", async (original) => ({
  ...(await original<typeof import("./types.js")>()),
  LINK_SOURCE_IDENTITY_LIMIT: 2
}));

class CaptureRadio implements LinkRadio {
  readonly max_payload_bytes = 233;
  readonly sent: Array<{ payload: Uint8Array; options: RadioSendOptions }> = [];
  private readonly handlers = new Set<(packet: RadioPacket) => void>();

  async send(payload: Uint8Array, options: RadioSendOptions): Promise<void> {
    this.sent.push({ payload: payload.slice(), options });
  }

  onPacket(handler: (packet: RadioPacket) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }

  receive(packet: RadioPacket): void {
    for (const handler of this.handlers) handler(packet);
  }
}

const authentication: GatewayAuthenticationPolicy = {
  challenge: async () => "challenge",
  prove: async () => "proof",
  verify: async () => true
};

function beacon(joinAttemptID = "join-attempt"): DiscoveryBeacon {
  return {
    type: "discovery",
    join_attempt_id: joinAttemptID,
    radio_node_id: 101,
    asset_id: "asset-alpha",
    service_session: "asset-session",
    link_revision: LINK_PROTOCOL_REVISION,
    radio_contract_revision: RADIO_CONTRACT_REVISION,
    capabilities: ["json", "fragmentation", "confirmation"]
  };
}

function packet(
  message: Parameters<typeof encodeJoinMessage>[0],
  publicKeyEncrypted: boolean,
  receivedAt: number
): RadioPacket {
  return {
    payload: encodeJoinMessage(message),
    received_at: receivedAt,
    radio_source: 101,
    channel: 0,
    public_key_encrypted: publicKeyEncrypted
  };
}

async function membershipStore(): Promise<{ directory: string; store: GatewayMembershipStore }> {
  const directory = await mkdtemp(join(tmpdir(), "atlas-link-join-admission-"));
  const store = new GatewayMembershipStore(join(directory, "membership.json"));
  await store.initialize({
    gateway_node_id: "gateway",
    channel_index: 1,
    channel_name: "ATLAS",
    channel_key_base64: Buffer.alloc(32, 9).toString("base64")
  });
  return { directory, store };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for Gateway join operation");
}

describe("Gateway join admission", () => {
  it("rejects new identities at capacity while allowing generation updates", async () => {
    const { directory, store } = await membershipStore();
    try {
      await store.admitAsset("asset-alpha");
      await store.admitAsset("asset-beta");

      await expect(store.admitAsset("asset-gamma")).rejects.toMatchObject({ reason: "capacity" });
      await expect(store.admitAsset("asset-alpha")).resolves.toMatchObject({ source_generation: 2 });
      await expect(store.load()).resolves.toMatchObject({
        asset_generations: { "asset-alpha": 2, "asset-beta": 1 }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not send or cache acceptance when source admission rejects", async () => {
    const { directory, store } = await membershipStore();
    const radio = new CaptureRadio();
    const errors: Error[] = [];
    const gateway = new GatewayJoinService(
      radio,
      0,
      store,
      authentication,
      (error) => errors.push(error),
      () => {
        throw new Error("source activation rejected");
      }
    );
    const joinBeacon = beacon();
    try {
      radio.receive(packet(joinBeacon, false, 0));
      await waitFor(() => radio.sent.length === 1);
      expect(decodeJoinMessage(radio.sent[0]!.payload)?.type).toBe("challenge");

      radio.receive(
        packet({ type: "response", join_attempt_id: joinBeacon.join_attempt_id, response: "response" }, true, 1)
      );
      await waitFor(() => errors.length === 1);
      expect(radio.sent).toHaveLength(1);
      await expect(store.load()).resolves.toMatchObject({ asset_generations: { "asset-alpha": 1 } });

      radio.sent.length = 0;
      radio.receive(packet(joinBeacon, false, 2));
      await waitFor(() => radio.sent.length === 1);
      expect(decodeJoinMessage(radio.sent[0]!.payload)?.type).toBe("challenge");
    } finally {
      await gateway.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not send acceptance after Gateway shutdown during source admission", async () => {
    const { directory, store } = await membershipStore();
    const radio = new CaptureRadio();
    let admissionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      admissionStarted = resolve;
    });
    let releaseAdmission!: () => void;
    const admissionReleased = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const gateway = new GatewayJoinService(radio, 0, store, authentication, undefined, async () => {
      admissionStarted();
      await admissionReleased;
    });
    try {
      const joinBeacon = beacon("closing-join");
      radio.receive(packet(joinBeacon, false, 0));
      await waitFor(() => radio.sent.length === 1);
      radio.receive(
        packet({ type: "response", join_attempt_id: joinBeacon.join_attempt_id, response: "response" }, true, 1)
      );
      await started;

      let closeResolved = false;
      const closing = gateway.close().then(() => {
        closeResolved = true;
      });
      await Promise.resolve();
      expect(closeResolved).toBe(false);
      releaseAdmission();
      await closing;

      expect(radio.sent).toHaveLength(1);
      expect(decodeJoinMessage(radio.sent[0]!.payload)?.type).toBe("challenge");
      await expect(store.load()).resolves.toMatchObject({ asset_generations: { "asset-alpha": 1 } });
    } finally {
      releaseAdmission();
      await gateway.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
