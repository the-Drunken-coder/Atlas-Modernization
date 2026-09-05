import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.js";
import {
  type ActualRadioConfiguration,
  type ConfigurationDifference,
  createUSShortFastProfile,
  type PrivateChannelMembership,
  type RadioConfigurationAdapter,
  type RadioProfile,
  RadioProfileManager
} from "./profile.js";
import {
  type LinkRadio,
  LinkRadioGate,
  type RadioPacket,
  RadioTransmissionSuspendedError,
  RadioUnavailableError
} from "./radio.js";
import { LinkService } from "./service.js";
import { SUBSCRIPTION_RENEWAL_MS } from "./subscriptions.js";
import { positionPublication } from "./test-fixtures.js";
import { LinkTransport } from "./transport.js";

class FakeRadio implements LinkRadio {
  readonly max_payload_bytes = 233;
  readonly sent: Uint8Array[] = [];
  private sendRelease: (() => void) | undefined;
  private disconnectHandler: ((reason: Error) => void) | undefined;

  async send(payload: Uint8Array): Promise<void> {
    this.sent.push(payload);
    if (!this.sendRelease) return;
    await new Promise<void>((resolve) => {
      this.sendRelease = resolve;
    });
  }

  onPacket(_handler: (packet: RadioPacket) => void): () => void {
    return () => undefined;
  }

  onDisconnect(handler: (reason: Error) => void): () => void {
    this.disconnectHandler = handler;
    return () => {
      if (this.disconnectHandler === handler) this.disconnectHandler = undefined;
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  blockNextSend(): void {
    this.sendRelease = () => undefined;
  }

  releaseSend(): void {
    const release = this.sendRelease;
    this.sendRelease = undefined;
    release?.();
  }

  disconnect(reason: Error): void {
    this.disconnectHandler?.(reason);
  }
}

class FakeConfigurationAdapter implements RadioConfigurationAdapter {
  configuration: ActualRadioConfiguration;
  applyStarted = false;
  private applyRelease: (() => void) | undefined;
  ignoreWrites = false;
  blockWrites = false;
  readError: Error | undefined;

  constructor(profile: RadioProfile) {
    this.configuration = actualConfiguration(profile);
  }

  async readConfiguration(): Promise<ActualRadioConfiguration> {
    if (this.readError) throw this.readError;
    return structuredClone(this.configuration);
  }

  async applyConfiguration(profile: RadioProfile, _differences: readonly ConfigurationDifference[]): Promise<void> {
    this.applyStarted = true;
    if (this.blockWrites) {
      await new Promise<void>((resolve) => {
        this.applyRelease = () => {
          this.configuration = actualConfiguration(profile);
          resolve();
        };
      });
      return;
    }
    if (!this.ignoreWrites) this.configuration = actualConfiguration(profile);
  }

  releaseWrites(): void {
    const release = this.applyRelease;
    this.applyRelease = undefined;
    release?.();
  }

  readPrivateMembership(_privateChannelIndex: number): Promise<PrivateChannelMembership | undefined> {
    return Promise.resolve(undefined);
  }

  clearPrivateMembership(_privateChannelIndex: number): Promise<void> {
    return Promise.resolve();
  }

  installPrivateMembership(_membership: PrivateChannelMembership): Promise<void> {
    return Promise.resolve();
  }
}

function actualConfiguration(profile: RadioProfile, frequencySlot = profile.frequency_slot): ActualRadioConfiguration {
  return {
    hardware_model: "test-radio",
    firmware_version: profile.firmware.tested,
    firmware: { minimum: profile.firmware.minimum, tested: profile.firmware.tested },
    region: profile.region,
    modem_preset: profile.modem_preset,
    use_preset: true,
    override_frequency: 0,
    hop_limit: profile.hop_limit,
    device_role: profile.device_role,
    rebroadcast_mode: profile.rebroadcast_mode,
    frequency_slot: frequencySlot,
    tx_power: profile.tx_power,
    power_saving: profile.power_saving,
    remote_administration: profile.remote_administration,
    managed_mode: profile.managed_mode,
    native_position: profile.native_position,
    native_telemetry: profile.native_telemetry,
    mqtt: profile.mqtt,
    public_channel: structuredClone(profile.public_channel),
    private_channel: structuredClone(profile.private_channel)
  };
}

async function waitForApply(adapter: FakeConfigurationAdapter): Promise<void> {
  for (let attempt = 0; attempt < 20 && !adapter.applyStarted; attempt++) await Promise.resolve();
  expect(adapter.applyStarted).toBe(true);
}

function setup() {
  const profile = createUSShortFastProfile(20, "2.7.15");
  const adapter = new FakeConfigurationAdapter(profile);
  const manager = new RadioProfileManager(profile, adapter);
  const rawRadio = new FakeRadio();
  const radio = new LinkRadioGate(rawRadio);
  const clock = new VirtualClock();
  const service = new LinkService({
    mode: "asset",
    nodeID: "asset-alpha",
    clock,
    profileManager: manager,
    radioGate: radio,
    gatewayNode: { role: "gateway", id: "gateway" }
  });
  const transport = new LinkTransport({
    node: service.node,
    sourceGeneration: 1,
    serviceSession: service.serviceSession,
    radio,
    clock,
    retryIntervalMs: 60_000
  });
  service.attachTransport(transport, { role: "gateway", id: "gateway" });
  return { adapter, manager, radio, rawRadio, service, clock };
}

describe("Link service radio profile apply", () => {
  it("reports an unavailable radio when cached profile reads lose the connection", async () => {
    const { adapter, service } = setup();
    adapter.readError = new RadioUnavailableError();

    await expect(service.radioStatus()).resolves.toEqual({ available: false });
    service.stop();
  });

  it("preserves non-radio profile inspection failures", async () => {
    const { adapter, service } = setup();
    adapter.readError = new Error("profile read failed");

    await expect(service.radioStatus()).rejects.toThrow("profile read failed");
    service.stop();
  });

  it("suspends radio sends and restores the active lifecycle after verified apply", async () => {
    const { adapter, radio, rawRadio, service, clock } = setup();
    const desired = service.profile();
    if (!desired) throw new Error("profile was not configured");
    desired.frequency_slot = 21;
    service.replaceProfile(desired);
    adapter.blockWrites = true;

    const apply = service.applyRadioProfile();
    await waitForApply(adapter);
    await expect(radio.send(new Uint8Array([1]), { channel: 0 })).rejects.toBeInstanceOf(
      RadioTransmissionSuspendedError
    );
    expect(service.status().lifecycle).toBe("configuring");

    adapter.releaseWrites();
    await expect(apply).resolves.toMatchObject({ verified: true });
    expect(service.status().lifecycle).toBe("active");
    service.submit(positionPublication(1));
    await clock.advanceBy(0);
    expect(rawRadio.sent.length).toBeGreaterThan(0);
    service.stop();
  });

  it("keeps the gate closed and reports an unverified profile until a later apply succeeds", async () => {
    const { adapter, radio, service } = setup();
    const desired = service.profile();
    if (!desired) throw new Error("profile was not configured");
    desired.frequency_slot = 21;
    service.replaceProfile(desired);
    adapter.ignoreWrites = true;

    await expect(service.applyRadioProfile()).rejects.toThrow("radio configuration did not converge");
    expect(service.status()).toMatchObject({
      lifecycle: "error",
      detail: "radio configuration did not converge: frequency_slot"
    });
    await expect(radio.send(new Uint8Array([1]), { channel: 0 })).rejects.toBeInstanceOf(
      RadioTransmissionSuspendedError
    );
    expect(service.submit(positionPublication(1))).toMatchObject({
      status: "failed",
      reason: "Link service is not transmitting"
    });

    const corrected = service.profile();
    if (!corrected) throw new Error("profile was not configured");
    corrected.frequency_slot = 20;
    service.replaceProfile(corrected);
    adapter.ignoreWrites = false;
    await expect(service.applyRadioProfile()).resolves.toMatchObject({ verified: true });
    expect(service.status().lifecycle).toBe("active");
    service.stop();
  });

  it("holds queued transport work through a failed apply and resumes it after retry", async () => {
    const { adapter, clock, rawRadio, service } = setup();
    const desired = service.profile();
    if (!desired) throw new Error("profile was not configured");
    desired.frequency_slot = 21;
    service.replaceProfile(desired);
    adapter.ignoreWrites = true;
    rawRadio.blockNextSend();

    expect(service.submit(positionPublication(1))).toMatchObject({ status: "queued", operation_id: "position-1" });
    const pumping = clock.advanceBy(0);
    await Promise.resolve();
    expect(rawRadio.sent).toHaveLength(1);

    const apply = service.applyRadioProfile();
    rawRadio.releaseSend();
    await pumping;
    await expect(apply).rejects.toThrow("radio configuration did not converge");
    expect(service.status().lifecycle).toBe("error");
    expect(service.operation("position-1")).toMatchObject({ status: "queued" });
    expect(service.submit(positionPublication(2))).toMatchObject({
      status: "failed",
      reason: "Link service is not transmitting"
    });
    expect(rawRadio.sent).toHaveLength(1);

    const corrected = service.profile();
    if (!corrected) throw new Error("profile was not configured");
    corrected.frequency_slot = 20;
    service.replaceProfile(corrected);
    adapter.ignoreWrites = false;
    await expect(service.applyRadioProfile()).resolves.toMatchObject({ verified: true });
    await clock.advanceBy(0);
    expect(rawRadio.sent.length).toBeGreaterThan(1);
    expect(service.operation("position-1")).toMatchObject({ status: "sent" });
    service.stop();
  });

  it("applies a desired-profile snapshot when replacement races the adapter", async () => {
    const { adapter, manager, service } = setup();
    const desired = service.profile();
    if (!desired) throw new Error("profile was not configured");
    desired.frequency_slot = 21;
    service.replaceProfile(desired);
    adapter.blockWrites = true;

    const apply = service.applyRadioProfile();
    await waitForApply(adapter);
    const next = service.profile();
    if (!next) throw new Error("profile was not configured");
    next.frequency_slot = 20;
    service.replaceProfile(next);
    adapter.releaseWrites();

    await expect(apply).resolves.toMatchObject({ verified: true, selected_profile: { frequency_slot: 21 } });
    expect(manager.profile().frequency_slot).toBe(20);
    service.stop();
  });

  it("restarts subscription renewal after a verified live apply", async () => {
    const { adapter, clock, rawRadio, service } = setup();
    const selector = { kind: "resource_type", resource_type: "entity" } as const;
    expect(service.updateLocalSubscription("client-a", "add", selector)).toMatchObject({ changed: true });
    await clock.advanceBy(0);
    const beforeApply = rawRadio.sent.length;
    const desired = service.profile();
    if (!desired) throw new Error("profile was not configured");
    desired.frequency_slot = 21;
    service.replaceProfile(desired);
    adapter.blockWrites = true;

    const apply = service.applyRadioProfile();
    await waitForApply(adapter);
    adapter.releaseWrites();
    await expect(apply).resolves.toMatchObject({ verified: true });
    const beforeRenewal = rawRadio.sent.length;
    await clock.advanceBy(SUBSCRIPTION_RENEWAL_MS - 1);
    expect(rawRadio.sent.length).toBe(beforeRenewal);
    await clock.advanceBy(1);
    expect(rawRadio.sent.length).toBeGreaterThan(beforeRenewal);
    expect(rawRadio.sent.length).toBeGreaterThan(beforeApply);
    service.stop();
  });

  it("does not resume transmission when stop wins a racing apply", async () => {
    const { adapter, radio, service } = setup();
    const desired = service.profile();
    if (!desired) throw new Error("profile was not configured");
    desired.frequency_slot = 21;
    service.replaceProfile(desired);
    adapter.blockWrites = true;

    const apply = service.applyRadioProfile();
    await waitForApply(adapter);
    service.stop();
    adapter.releaseWrites();

    await expect(apply).rejects.toThrow("Link service stopped");
    expect(service.status().lifecycle).toBe("stopped");
    await expect(radio.send(new Uint8Array([1]), { channel: 0 })).rejects.toThrow("Link service stopped");
  });

  it("checks invalidation after draining before writing configuration", async () => {
    const { adapter, rawRadio, radio, service } = setup();
    rawRadio.blockNextSend();
    const send = radio.send(new Uint8Array([1]), { channel: 0 });
    const apply = service.applyRadioProfile();
    await Promise.resolve();
    service.stop();
    rawRadio.releaseSend();
    await send;

    await expect(apply).rejects.toThrow("Link service stopped");
    expect(adapter.applyStarted).toBe(false);
  });

  it("keeps the gate closed when the radio disconnects during apply", async () => {
    const { adapter, rawRadio, radio, service } = setup();
    const desired = service.profile();
    if (!desired) throw new Error("profile was not configured");
    desired.frequency_slot = 21;
    service.replaceProfile(desired);
    adapter.blockWrites = true;

    const apply = service.applyRadioProfile();
    await waitForApply(adapter);
    rawRadio.disconnect(new Error("radio disconnected"));
    adapter.releaseWrites();

    await expect(apply).rejects.toThrow("Link service stopped during radio profile apply");
    expect(service.status()).toMatchObject({ lifecycle: "error", detail: "radio disconnected" });
    await expect(radio.send(new Uint8Array([1]), { channel: 0 })).rejects.toThrow("radio disconnected");
  });
});
