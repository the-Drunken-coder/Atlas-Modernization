import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCanonicalBaseline, runFirstVerticalSlice, runStressBaseline } from "./benchmark.js";
import { VirtualClock } from "./clock.js";
import { LINK_PROTOCOL_REVISION, RADIO_CONTRACT_REVISION } from "./contract.js";
import {
  AssetJoinService,
  type DiscoveryBeacon,
  decodeJoinMessage,
  encodeJoinMessage,
  type GatewayAuthenticationPolicy,
  GatewayJoinService,
  PreSharedKeyAuthenticationPolicy,
  type SourceAdmission
} from "./joining.js";
import { GatewayMembershipStore } from "./membership.js";
import {
  type ActualRadioConfiguration,
  type ConfigurationDifference,
  createUSShortFastProfile,
  type PrivateChannelMembership,
  type RadioConfigurationAdapter,
  type RadioProfile,
  RadioProfileManager
} from "./profile.js";
import { SimulatedPacketNetwork } from "./simulation.js";

describe("joining and Radio profile", () => {
  it("fits discovery in one packet and preserves the full contract revision", () => {
    const beacon: DiscoveryBeacon = {
      type: "discovery",
      join_attempt_id: "a".repeat(32),
      radio_node_id: 4_294_967_295,
      asset_id: "asset-alpha",
      service_session: "s".repeat(32),
      link_revision: LINK_PROTOCOL_REVISION,
      radio_contract_revision: RADIO_CONTRACT_REVISION,
      capabilities: ["json", "fragmentation", "confirmation"]
    };
    const encoded = encodeJoinMessage(beacon);
    expect(encoded.byteLength).toBeLessThanOrEqual(233);
    expect(decodeJoinMessage(encoded)).toEqual(beacon);
    expect(() => encodeJoinMessage(beacon, encoded.byteLength - 1)).toThrow("exceeds one Meshtastic packet");
  });

  it("mutually authenticates the Gateway and Asset through the replaceable join policy", async () => {
    const gateway = new PreSharedKeyAuthenticationPolicy("a".repeat(32));
    const asset = new PreSharedKeyAuthenticationPolicy("a".repeat(32));
    const wrongAsset = new PreSharedKeyAuthenticationPolicy("b".repeat(32));
    const beacon: DiscoveryBeacon = {
      type: "discovery",
      join_attempt_id: "a".repeat(32),
      radio_node_id: 7,
      asset_id: "asset-alpha",
      service_session: "s".repeat(32),
      link_revision: LINK_PROTOCOL_REVISION,
      radio_contract_revision: RADIO_CONTRACT_REVISION,
      capabilities: ["json", "fragmentation", "confirmation"]
    };
    const challenge = await gateway.challenge(beacon);
    const proof = await gateway.prove(beacon, challenge);
    const challengeMessage = {
      type: "challenge",
      join_attempt_id: beacon.join_attempt_id,
      challenge,
      gateway_proof: proof
    } as const;
    const encodedChallenge = encodeJoinMessage(challengeMessage);
    expect(encodedChallenge.byteLength).toBeLessThanOrEqual(233);
    expect(decodeJoinMessage(encodedChallenge)).toEqual(challengeMessage);
    expect(await asset.verifyGateway(beacon, challenge, proof)).toBe(true);
    expect(await wrongAsset.verifyGateway(beacon, challenge, proof)).toBe(false);
    expect(await gateway.verify(beacon, challenge, await asset.answer(challenge))).toBe(true);
    expect(await gateway.verify(beacon, challenge, await wrongAsset.answer(challenge))).toBe(false);
  });

  it("persists membership and serializes concurrent source-generation changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-link-membership-"));
    const path = join(directory, "membership.json");
    const store = new GatewayMembershipStore(path);
    await store.initialize({
      gateway_node_id: "gateway",
      channel_index: 1,
      channel_name: "ATLAS",
      channel_key_base64: Buffer.alloc(32, 7).toString("base64")
    });
    const secondStore = new GatewayMembershipStore(path);
    const [first, second] = await Promise.all([store.admitAsset("asset-alpha"), secondStore.admitAsset("asset-alpha")]);
    expect([first.source_generation, second.source_generation].sort()).toEqual([1, 2]);
    const firstActivation = await store.activateGateway();
    const secondActivation = await store.activateGateway();
    expect([firstActivation.gateway_generation, secondActivation.gateway_generation]).toEqual([1, 2]);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.asset_generations["asset-alpha"]).toBe(2);
    expect(persisted.channel_key_base64).toBe(Buffer.alloc(32, 7).toString("base64"));
  });

  it("does not let a crash-persistent sentinel file block membership mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-link-membership-stale-lock-"));
    const path = join(directory, "membership.json");
    const store = new GatewayMembershipStore(path);
    await store.initialize({
      gateway_node_id: "gateway",
      channel_index: 1,
      channel_name: "ATLAS",
      channel_key_base64: Buffer.alloc(32, 8).toString("base64")
    });
    await writeFile(`${path}.lock`, "interrupted-owner\n", { mode: 0o600 });

    await expect(store.activateGateway()).resolves.toMatchObject({ gateway_generation: 1 });
  });

  it("treats prototype-shaped Asset IDs as ordinary membership keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-link-membership-prototype-"));
    const store = new GatewayMembershipStore(join(directory, "membership.json"));
    await store.initialize({
      gateway_node_id: "gateway",
      channel_index: 1,
      channel_name: "ATLAS",
      channel_key_base64: Buffer.alloc(32, 8).toString("base64")
    });

    await expect(store.admitAsset("constructor")).resolves.toMatchObject({ source_generation: 1 });
    await expect(store.admitAsset("__proto__")).resolves.toMatchObject({ source_generation: 1 });
    await expect(store.admitAsset("__proto__")).resolves.toMatchObject({ source_generation: 2 });
    expect(Object.entries((await store.load()).asset_generations)).toEqual([
      ["constructor", 1],
      ["__proto__", 2]
    ]);
  });

  it("joins across one LOCAL_ONLY relay and assigns a new generation on restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-link-join-"));
    const store = new GatewayMembershipStore(join(directory, "membership.json"));
    const channelKey = Buffer.alloc(32, 9).toString("base64");
    await store.initialize({
      gateway_node_id: "gateway",
      channel_index: 1,
      channel_name: "ATLAS",
      channel_key_base64: channelKey
    });
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 11, clock, duplicateChance: 1 });
    const assetRadio = network.addRadio("asset-radio", 101);
    network.addRadio("relay-radio", 150);
    const gatewayRadio = network.addRadio("gateway-radio", 201);
    network.connect("asset-radio", "relay-radio");
    network.connect("relay-radio", "gateway-radio");
    const authentication = new PreSharedKeyAuthenticationPolicy("j".repeat(32));
    const joinErrors: string[] = [];
    const admissions: SourceAdmission[] = [];
    const gateway = new GatewayJoinService(
      gatewayRadio,
      0,
      store,
      authentication,
      (error) => joinErrors.push(error.message),
      (admission) => {
        admissions.push(admission);
      }
    );
    const installed: PrivateChannelMembership[] = [];
    let latestStatus: ReturnType<AssetJoinService["status"]> | undefined;
    const start = (session: string): AssetJoinService => {
      const service = new AssetJoinService({
        radio: assetRadio,
        clock,
        assetID: "asset-alpha",
        radioNodeID: 101,
        serviceSession: session,
        authentication,
        installMembership: async (membership) => {
          installed.push(membership);
        },
        random: () => 0.5,
        onStatus: (status) => {
          latestStatus = status;
        },
        onError: (error) => joinErrors.push(error.message)
      });
      service.start();
      return service;
    };

    const first = start("session-one");
    await advanceUntilJoined(clock, () => latestStatus, joinErrors);
    expect(latestStatus).toMatchObject({ state: "joined", gateway_node_id: "gateway", source_generation: 1 });
    expect(installed[0]).toEqual({ channel_index: 1, channel_name: "ATLAS", channel_key_base64: channelKey });
    first.stop();

    latestStatus = undefined;
    const second = start("session-two");
    await advanceUntilJoined(clock, () => latestStatus, joinErrors);
    expect(latestStatus).toMatchObject({ state: "joined", source_generation: 2 });
    expect(admissions).toEqual([
      {
        source: { role: "asset", id: "asset-alpha" },
        source_generation: 1,
        service_session: "session-one"
      },
      {
        source: { role: "asset", id: "asset-alpha" },
        source_generation: 2,
        service_session: "session-two"
      }
    ]);
    second.stop();

    let releaseMembership!: () => void;
    const membershipInstalled = new Promise<void>((resolve) => {
      releaseMembership = resolve;
    });
    let installationStarted = false;
    const stopping = new AssetJoinService({
      radio: assetRadio,
      clock,
      assetID: "asset-alpha",
      radioNodeID: 101,
      serviceSession: "session-stopping",
      authentication,
      installMembership: async () => {
        installationStarted = true;
        await membershipInstalled;
      },
      random: () => 0.5,
      onError: (error) => joinErrors.push(error.message)
    });
    stopping.start();
    for (let attempt = 0; attempt < 100 && !installationStarted; attempt++) {
      await clock.advanceBy(500);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    expect(installationStarted).toBe(true);
    let closeResolved = false;
    const close = stopping.close().then(() => {
      closeResolved = true;
    });
    await Promise.resolve();
    expect(closeResolved).toBe(false);
    releaseMembership();
    await close;
    expect(stopping.status()).toEqual({ state: "stopped" });
    await gateway.close();
  });

  it("drains an active durable admission before Gateway shutdown completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-link-join-close-"));
    const store = new GatewayMembershipStore(join(directory, "membership.json"));
    await store.initialize({
      gateway_node_id: "gateway",
      channel_index: 1,
      channel_name: "ATLAS",
      channel_key_base64: Buffer.alloc(32, 9).toString("base64")
    });
    let releaseAdmission!: () => void;
    const admissionReleased = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let admissionStarted = false;
    const admitAsset = store.admitAsset.bind(store);
    store.admitAsset = async (assetID) => {
      admissionStarted = true;
      await admissionReleased;
      return admitAsset(assetID);
    };
    const authentication: GatewayAuthenticationPolicy = {
      challenge: async () => "challenge",
      prove: async () => "proof",
      verify: async () => true
    };
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 55, clock });
    const radio = network.addRadio("gateway", 201);
    const errors: string[] = [];
    const gateway = new GatewayJoinService(radio, 0, store, authentication, (error) => errors.push(error.message));
    const beacon: DiscoveryBeacon = {
      type: "discovery",
      join_attempt_id: "closing-join",
      radio_node_id: 101,
      asset_id: "asset-alpha",
      service_session: "asset-session",
      link_revision: LINK_PROTOCOL_REVISION,
      radio_contract_revision: RADIO_CONTRACT_REVISION,
      capabilities: ["json", "fragmentation", "confirmation"]
    };

    radio.receive({
      payload: encodeJoinMessage(beacon),
      received_at: 0,
      radio_source: 101,
      channel: 0,
      public_key_encrypted: false
    });
    for (let attempt = 0; attempt < 5; attempt++) await Promise.resolve();
    radio.receive({
      payload: encodeJoinMessage({ type: "response", join_attempt_id: beacon.join_attempt_id, response: "response" }),
      received_at: 1,
      radio_source: 101,
      channel: 0,
      public_key_encrypted: true
    });
    for (let attempt = 0; attempt < 5 && !admissionStarted; attempt++) await Promise.resolve();
    expect(admissionStarted).toBe(true);
    const closing = gateway.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseAdmission();
    await closing;

    expect((await store.load()).asset_generations).toEqual({ "asset-alpha": 1 });
    expect(errors).toEqual([]);
  });

  it("expires abandoned join challenges before they exhaust admission capacity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-link-join-expiry-"));
    const store = new GatewayMembershipStore(join(directory, "membership.json"));
    await store.initialize({
      gateway_node_id: "gateway",
      channel_index: 1,
      channel_name: "ATLAS",
      channel_key_base64: Buffer.alloc(32, 9).toString("base64")
    });
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 83, clock });
    const radio = network.addRadio("gateway", 201);
    const gateway = new GatewayJoinService(radio, 0, store, new PreSharedKeyAuthenticationPolicy("j".repeat(32)));
    const discovery = (attempt: number): DiscoveryBeacon => ({
      type: "discovery",
      join_attempt_id: `abandoned-${attempt}`,
      radio_node_id: 101,
      asset_id: `asset-${attempt}`,
      service_session: `session-${attempt}`,
      link_revision: LINK_PROTOCOL_REVISION,
      radio_contract_revision: RADIO_CONTRACT_REVISION,
      capabilities: ["json", "fragmentation", "confirmation"]
    });
    for (let attempt = 0; attempt < 256; attempt++) {
      radio.receive({
        payload: encodeJoinMessage(discovery(attempt)),
        received_at: 0,
        radio_source: 101,
        channel: 0,
        public_key_encrypted: false
      });
    }
    for (let attempt = 0; attempt < 10; attempt++) await Promise.resolve();
    expect(network.metrics().radio_submissions).toBe(256);

    radio.receive({
      payload: encodeJoinMessage(discovery(256)),
      received_at: 1,
      radio_source: 101,
      channel: 0,
      public_key_encrypted: false
    });
    for (let attempt = 0; attempt < 10; attempt++) await Promise.resolve();
    expect(network.metrics().radio_submissions).toBe(256);

    radio.receive({
      payload: encodeJoinMessage(discovery(256)),
      received_at: 2 * 60_000 + 1,
      radio_source: 101,
      channel: 0,
      public_key_encrypted: false
    });
    for (let attempt = 0; attempt < 10; attempt++) await Promise.resolve();

    expect(network.metrics().radio_submissions).toBe(257);
    await gateway.close();
  });

  it("applies only owned profile differences and verifies the readback", async () => {
    const profile = createUSShortFastProfile(20, "2.7.15");
    const adapter = new FakeConfigurationAdapter(profile);
    adapter.configuration.hop_limit = 2;
    adapter.configuration.public_channel.key_base64 = "";
    const manager = new RadioProfileManager(profile, adapter);
    const evidence = await manager.apply();
    expect(adapter.applied.map((difference) => difference.path).sort()).toEqual([
      "hop_limit",
      "public_channel.key_base64"
    ]);
    expect(adapter.applied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "hop_limit", desired: 3, actual: 2 }),
        expect.objectContaining({ path: "public_channel.key_base64", desired: "AQ==", actual: "" })
      ])
    );
    expect(evidence.verified).toBe(true);
  });

  it("retains profile evidence when a radio rejects a configuration write", async () => {
    const profile = createUSShortFastProfile(20, "2.7.15");
    const adapter = new FakeConfigurationAdapter(profile);
    adapter.configuration.hop_limit = 2;
    adapter.applyError = new Error("radio rejected LoRa configuration");
    const manager = new RadioProfileManager(profile, adapter);
    await expect(manager.apply()).rejects.toThrow("radio rejected LoRa configuration");
    expect(manager.evidence()).toMatchObject({
      verified: false,
      error: "radio rejected LoRa configuration",
      requested_changes: [expect.objectContaining({ path: "hop_limit", desired: 3, actual: 2 })]
    });
  });

  it("requires a restart before changing the live private-channel slot", () => {
    const profile = createUSShortFastProfile(20, "2.7.15");
    const manager = new RadioProfileManager(profile, new FakeConfigurationAdapter(profile));
    const replacement = structuredClone(profile);
    replacement.private_channel.index = 2;

    expect(() => manager.replaceProfile(replacement)).toThrow(
      "changing the private-channel slot requires a Link service restart"
    );
    expect(manager.profile().private_channel.index).toBe(1);
  });

  it("converges the static profile before dynamic private membership exists", async () => {
    const profile = createUSShortFastProfile(20, "2.7.15");
    const adapter = new FakeConfigurationAdapter(profile);
    adapter.configuration.private_channel = { index: -1, name: "" };

    const evidence = await new RadioProfileManager(profile, adapter).apply();

    expect(evidence.requested_changes.map((difference) => difference.path)).not.toContain("private_channel.index");
    expect(evidence.verified).toBe(true);
  });

  it("verifies private membership installation and removal through radio readback", async () => {
    const profile = createUSShortFastProfile(20, "2.7.15");
    const adapter = new FakeConfigurationAdapter(profile);
    const manager = new RadioProfileManager(profile, adapter);
    const membership = {
      channel_index: 1,
      channel_name: "ATLAS",
      channel_key_base64: Buffer.alloc(32, 3).toString("base64")
    } as const;
    await manager.prepareGateway(membership);
    expect(await adapter.readPrivateMembership(1)).toEqual(membership);
    await manager.prepareAssetForJoin();
    expect(await adapter.readPrivateMembership(1)).toBeUndefined();
  });

  it("clears Atlas memberships from every secondary channel before joining", async () => {
    const profile = createUSShortFastProfile(20, "2.7.15");
    const adapter = new FakeConfigurationAdapter(profile);
    adapter.privateMembership.set(2, {
      channel_index: 2,
      channel_name: "ATLAS",
      channel_key_base64: Buffer.alloc(32, 4).toString("base64")
    });
    await new RadioProfileManager(profile, adapter).prepareAssetForJoin();
    expect(adapter.privateMembership.size).toBe(0);
  });
});

describe("deterministic baseline", () => {
  it("repeats the first no-cheating vertical slice exactly", async () => {
    const first = await runFirstVerticalSlice(42);
    const second = await runFirstVerticalSlice(42);
    expect(first).toEqual(second);
    expect(first).toEqual(
      JSON.parse(await readFile(new URL("../baselines/first-position-v1-seed-42.json", import.meta.url), "utf8"))
    );
    expect(first.semantic_result).toMatchObject({ gateway_received: true, peer_asset_received: true });
  });

  it("runs the documented five-radio normal scenario through production transport", async () => {
    const result = await runCanonicalBaseline(42);
    expect(result).toEqual(
      JSON.parse(await readFile(new URL("../baselines/canonical-json-v1-seed-42.json", import.meta.url), "utf8"))
    );
    expect(result.semantic_result).toMatchObject({
      aggregate_subscription_feeds: 1,
      task_delivery_order: [],
      data_request_completed: false,
      task_reports_received: 0
    });
    expect(result.picture_metrics.at_30_seconds.total_records).toBeGreaterThan(0);
    expect(result.picture_metrics.at_60_seconds.total_records).toBeGreaterThan(0);
    expect(result.network_metrics.radio_submissions).toBeGreaterThan(0);
  });

  it("records the 32 KiB stress cost while cancellation preempts Object chunks", async () => {
    const result = await runStressBaseline(42);
    expect(result).toEqual(
      JSON.parse(await readFile(new URL("../baselines/canonical-json-stress-v1-seed-42.json", import.meta.url), "utf8"))
    );
    expect(result.semantic_result).toMatchObject({
      object_completed: false,
      cancellation_received: false,
      priority_preempted_object: true
    });
    expect(result.transport_metrics.retry_exhausted).toBe(3);
  });
});

class FakeConfigurationAdapter implements RadioConfigurationAdapter {
  configuration: ActualRadioConfiguration;
  applied: ConfigurationDifference[] = [];
  privateMembership = new Map<number, PrivateChannelMembership>();
  applyError: Error | undefined;

  constructor(profile: RadioProfile) {
    this.configuration = {
      ...structuredClone(profile),
      hardware_model: "fake",
      firmware_version: profile.firmware.tested
    };
  }

  async readConfiguration(): Promise<ActualRadioConfiguration> {
    return structuredClone(this.configuration);
  }

  async readPrivateMembership(privateChannelIndex: number): Promise<PrivateChannelMembership | undefined> {
    const membership = this.privateMembership.get(privateChannelIndex);
    return membership === undefined ? undefined : structuredClone(membership);
  }

  async applyConfiguration(profile: RadioProfile, differences: readonly ConfigurationDifference[]): Promise<void> {
    this.applied = [...differences];
    if (this.applyError) throw this.applyError;
    this.configuration = {
      ...structuredClone(profile),
      hardware_model: this.configuration.hardware_model,
      firmware_version: this.configuration.firmware_version
    };
  }

  async clearPrivateMembership(privateChannelIndex: number): Promise<void> {
    this.privateMembership.delete(privateChannelIndex);
  }

  async installPrivateMembership(membership: PrivateChannelMembership): Promise<void> {
    this.privateMembership.set(membership.channel_index, structuredClone(membership));
  }
}

async function advanceUntilJoined(
  clock: VirtualClock,
  status: () => ReturnType<AssetJoinService["status"]> | undefined,
  errors: readonly string[]
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await clock.advanceBy(500);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    if (status()?.state === "joined") return;
  }
  throw new Error(`simulated Asset did not join: ${errors.join("; ")}`);
}
