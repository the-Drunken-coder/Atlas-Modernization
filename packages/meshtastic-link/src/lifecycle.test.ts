import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AssetJoinService, CooperativeAuthenticationPolicy } from "./joining.js";
import { startLinkService } from "./lifecycle.js";
import { GatewayMembershipStore } from "./membership.js";
import {
  type ActualRadioConfiguration,
  createUSShortFastProfile,
  type PrivateChannelMembership,
  type RadioProfile
} from "./profile.js";
import { MeshtasticSerialRadio } from "./radio.js";
import { LinkHTTPServer, LinkService } from "./service.js";

describe("Link lifecycle", () => {
  it("binds HTTP before Asset profile preparation and closes the owned radio", async () => {
    const profile = createUSShortFastProfile(20, "2.7.15");
    const preparationStarted = deferred();
    const releasePreparation = deferred();
    let configurationReads = 0;
    const fake = fakeRadio(profile, {
      beforeConfigurationRead: async () => {
        configurationReads++;
        if (configurationReads !== 1) return;
        preparationStarted.resolve();
        await releasePreparation.promise;
      }
    });
    const port = await availablePort();
    const starting = startLinkService({
      mode: "asset",
      nodeID: "asset-alpha",
      profile,
      authentication: new CooperativeAuthenticationPolicy(),
      openRadio: async () => fake.radio,
      port
    });

    await preparationStarted.promise;
    const configuring = await fetch(`http://127.0.0.1:${port}/v1/status`).then((response) => response.json());
    expect(configuring).toMatchObject({ lifecycle: "configuring", mode: "asset" });

    releasePreparation.resolve();
    const running = await starting;
    try {
      const discovering = await fetch(`http://${running.address.host}:${running.address.port}/v1/status`).then(
        (response) => response.json()
      );
      expect(discovering).toMatchObject({ lifecycle: "discovering", mode: "asset" });
    } finally {
      await running.close();
    }
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("starts Gateway mode with durable membership before reporting active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-link-lifecycle-"));
    const membershipPath = join(directory, "membership.json");
    const store = new GatewayMembershipStore(membershipPath);
    const profile = createUSShortFastProfile(20, "2.7.15");
    const fake = fakeRadio(profile);
    await store.initialize({
      gateway_node_id: "gateway-main",
      channel_index: profile.private_channel.index,
      channel_name: profile.private_channel.name,
      channel_key_base64: Buffer.alloc(32, 1).toString("base64")
    });

    try {
      const running = await startLinkService({
        mode: "gateway",
        nodeID: "gateway-main",
        profile,
        authentication: new CooperativeAuthenticationPolicy(),
        membershipPath,
        openRadio: async () => fake.radio,
        port: 0
      });
      try {
        const status = await fetch(`http://${running.address.host}:${running.address.port}/v1/status`).then(
          (response) => response.json()
        );
        expect(status).toMatchObject({ lifecycle: "active", mode: "gateway" });
        await expect(store.load()).resolves.toMatchObject({ gateway_generation: 1 });
      } finally {
        await running.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("keeps the startup error when cleanup also fails", async () => {
    const profile = createUSShortFastProfile(20, "2.7.15");
    const cleanupError = new Error("radio cleanup failed");
    const fake = fakeRadio(profile, { closeError: cleanupError });

    await expect(
      startLinkService({
        mode: "gateway",
        nodeID: "gateway-main",
        profile,
        authentication: new CooperativeAuthenticationPolicy(),
        openRadio: async () => fake.radio,
        port: 0
      })
    ).rejects.toThrow("--membership is required");
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("attempts every cleanup step and aggregates normal shutdown failures", async () => {
    const profile = createUSShortFastProfile(20, "2.7.15");
    const serviceError = new Error("service cleanup failed");
    const radioError = new Error("radio cleanup failed");
    const order: string[] = [];
    const fake = fakeRadio(profile, {
      closeError: radioError,
      beforeClose: () => order.push("radio")
    });
    const originalServiceStop = LinkService.prototype.stop;
    const originalAssetClose = AssetJoinService.prototype.close;
    const originalHTTPClose = LinkHTTPServer.prototype.close;
    vi.spyOn(LinkService.prototype, "stop").mockImplementation(function (this: LinkService) {
      order.push("service");
      originalServiceStop.call(this);
      throw serviceError;
    });
    vi.spyOn(AssetJoinService.prototype, "close").mockImplementation(async function (this: AssetJoinService) {
      order.push("asset join");
      await originalAssetClose.call(this);
    });
    vi.spyOn(LinkHTTPServer.prototype, "close").mockImplementation(async function (this: LinkHTTPServer) {
      order.push("http");
      await originalHTTPClose.call(this);
    });

    try {
      const running = await startLinkService({
        mode: "asset",
        nodeID: "asset-alpha",
        profile,
        authentication: new CooperativeAuthenticationPolicy(),
        openRadio: async () => fake.radio,
        port: 0
      });
      let failure: unknown;
      try {
        await running.close();
      } catch (error) {
        failure = error;
      }
      if (!(failure instanceof AggregateError)) throw new Error("shutdown did not return an AggregateError");
      expect(failure.errors).toEqual([serviceError, radioError]);
      expect(order).toEqual(["service", "asset join", "http", "radio"]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

type FakeRadioOptions = {
  beforeConfigurationRead?: () => Promise<void>;
  beforeClose?: () => void;
  closeError?: Error;
};

function fakeRadio(profile: RadioProfile, options: FakeRadioOptions = {}) {
  let privateMembership: PrivateChannelMembership | undefined;
  const close = vi.fn(async () => {
    options.beforeClose?.();
    if (options.closeError) throw options.closeError;
  });
  const radio: MeshtasticSerialRadio = Object.create(MeshtasticSerialRadio.prototype);
  Object.defineProperties(radio, {
    max_payload_bytes: { value: 231 },
    maxPayloadBytes: { value: () => 219 },
    pacingDelayMs: { value: () => 0 },
    send: { value: vi.fn(async () => undefined) },
    onPacket: { value: vi.fn(() => () => undefined) },
    onDisconnect: { value: vi.fn(() => () => undefined) },
    nodeNumber: { value: vi.fn(() => 101) },
    readConfiguration: {
      value: vi.fn(async () => {
        await options.beforeConfigurationRead?.();
        return actualConfiguration(profile);
      })
    },
    applyConfiguration: { value: vi.fn(async () => undefined) },
    readPrivateMembership: { value: vi.fn(async () => privateMembership) },
    clearPrivateMembership: {
      value: vi.fn(async () => {
        privateMembership = undefined;
      })
    },
    installPrivateMembership: {
      value: vi.fn(async (membership: PrivateChannelMembership) => {
        privateMembership = structuredClone(membership);
      })
    },
    close: { value: close }
  });
  return { radio, close };
}

function actualConfiguration(profile: RadioProfile): ActualRadioConfiguration {
  return {
    ...structuredClone(profile),
    hardware_model: "test-radio",
    firmware_version: profile.firmware.tested,
    use_preset: true,
    override_frequency: 0
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not obtain a TCP port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
