import { createHash } from "node:crypto";
import { canonicalJSON } from "./canonical-json.js";

export type RadioProfile = {
  firmware: {
    minimum: "2.7.15";
    tested: string;
  };
  region: "US";
  modem_preset: "SHORT_FAST" | "SHORT_TURBO";
  hop_limit: 3;
  device_role: "CLIENT";
  rebroadcast_mode: "LOCAL_ONLY";
  frequency_slot: number;
  tx_power: 0;
  power_saving: false;
  remote_administration: false;
  managed_mode: false;
  native_position: false;
  native_telemetry: false;
  mqtt: false;
  public_channel: {
    index: 0;
    name: "ATLAS-RENDEZVOUS";
    role: "PRIMARY";
    key_base64: "AQ==";
    uplink: false;
    downlink: false;
  };
  private_channel: {
    index: number;
    name: "ATLAS";
  };
};

export type ActualRadioConfiguration = {
  hardware_model: string;
  firmware_version: string;
  firmware: {
    minimum: string;
    tested: string;
  };
  region: string;
  modem_preset: string;
  hop_limit: number;
  device_role: string;
  rebroadcast_mode: string;
  frequency_slot: number;
  tx_power: number;
  power_saving: boolean;
  remote_administration: boolean;
  managed_mode: boolean;
  native_position: boolean;
  native_telemetry: boolean;
  mqtt: boolean;
  public_channel: {
    index: number;
    name: string;
    role: string;
    key_base64: string;
    uplink: boolean;
    downlink: boolean;
  };
  private_channel: {
    index: number;
    name: string;
  };
};

export type ConfigurationDifference = {
  path: string;
  desired: string | number | boolean;
  actual: string | number | boolean | undefined;
};

export type ConfigurationEvidence = {
  profile_fingerprint: string;
  selected_profile: RadioProfile;
  before: ActualRadioConfiguration;
  requested_changes: ConfigurationDifference[];
  after?: ActualRadioConfiguration;
  verified: boolean;
  applied_at: string;
  error?: string;
};

export type RadioProfileInspection = {
  profile: RadioProfile;
  actual: ActualRadioConfiguration;
  differences: ConfigurationDifference[];
  evidence?: ConfigurationEvidence;
};

export interface RadioConfigurationAdapter {
  readConfiguration(): Promise<ActualRadioConfiguration>;
  readPrivateMembership(privateChannelIndex: number): Promise<PrivateChannelMembership | undefined>;
  applyConfiguration(profile: RadioProfile, differences: readonly ConfigurationDifference[]): Promise<void>;
  clearPrivateMembership(privateChannelIndex: number): Promise<void>;
  installPrivateMembership(membership: PrivateChannelMembership): Promise<void>;
}

export type PrivateChannelMembership = {
  channel_index: number;
  channel_name: string;
  channel_key_base64: string;
};

export class RadioProfileManager {
  private desired: RadioProfile;
  private lastEvidence: ConfigurationEvidence | undefined;

  constructor(
    profile: RadioProfile,
    private readonly adapter: RadioConfigurationAdapter
  ) {
    validateRadioProfile(profile);
    this.desired = structuredClone(profile);
  }

  profile(): RadioProfile {
    return structuredClone(this.desired);
  }

  replaceProfile(profile: RadioProfile): void {
    validateRadioProfile(profile);
    if (profile.private_channel.index !== this.desired.private_channel.index) {
      throw new TypeError("changing the private-channel slot requires a Link service restart");
    }
    this.desired = structuredClone(profile);
  }

  async diff(): Promise<ConfigurationDifference[]> {
    return profileDifferences(this.desired, await this.adapter.readConfiguration());
  }

  async inspect(): Promise<RadioProfileInspection> {
    const actual = await this.adapter.readConfiguration();
    return {
      profile: this.profile(),
      actual,
      differences: profileDifferences(this.desired, actual),
      ...(this.lastEvidence === undefined ? {} : { evidence: structuredClone(this.lastEvidence) })
    };
  }

  async apply(): Promise<ConfigurationEvidence> {
    const before = await this.adapter.readConfiguration();
    const requestedChanges = profileDifferences(this.desired, before);
    let after: ActualRadioConfiguration | undefined;
    try {
      assertSupportedFirmware(before.firmware_version, this.desired.firmware.tested);
      if (requestedChanges.length > 0) await this.adapter.applyConfiguration(this.desired, requestedChanges);
      after = await this.adapter.readConfiguration();
    } catch (error) {
      try {
        after = await this.adapter.readConfiguration();
      } catch {
        // The original radio error is the useful failure. A missing after snapshot is explicit in the evidence.
      }
      const evidence: ConfigurationEvidence = {
        profile_fingerprint: profileFingerprint(this.desired),
        selected_profile: structuredClone(this.desired),
        before,
        requested_changes: requestedChanges,
        ...(after === undefined ? {} : { after }),
        verified: false,
        applied_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
      this.lastEvidence = evidence;
      throw error;
    }
    const remaining = profileDifferences(this.desired, after);
    const evidence: ConfigurationEvidence = {
      profile_fingerprint: profileFingerprint(this.desired),
      selected_profile: structuredClone(this.desired),
      before,
      requested_changes: requestedChanges,
      after,
      verified: remaining.length === 0,
      applied_at: new Date().toISOString()
    };
    this.lastEvidence = evidence;
    if (!evidence.verified) {
      const error = `radio configuration did not converge: ${remaining.map((item) => item.path).join(", ")}`;
      evidence.error = error;
      throw new Error(error);
    }
    return evidence;
  }

  async prepareAssetForJoin(): Promise<void> {
    await this.apply();
    for (let index = 1; index <= 7; index++) {
      if (await this.adapter.readPrivateMembership(index)) await this.adapter.clearPrivateMembership(index);
    }
    for (let index = 1; index <= 7; index++) {
      if (await this.adapter.readPrivateMembership(index)) {
        throw new Error(`Asset radio retained prior private-channel membership in slot ${index}`);
      }
    }
  }

  async prepareGateway(membership: PrivateChannelMembership): Promise<void> {
    await this.apply();
    await this.installMembership(membership);
  }

  async installAssetMembership(membership: PrivateChannelMembership): Promise<void> {
    await this.installMembership(membership);
  }

  private async installMembership(membership: PrivateChannelMembership): Promise<void> {
    if (membership.channel_index !== this.desired.private_channel.index || membership.channel_name !== "ATLAS") {
      throw new Error("membership does not match the selected Radio profile private channel slot");
    }
    await this.adapter.installPrivateMembership(membership);
    const installed = await this.adapter.readPrivateMembership(membership.channel_index);
    if (!installed || !sameMembership(installed, membership)) {
      throw new Error("private-channel membership did not match radio readback");
    }
  }

  evidence(): ConfigurationEvidence | undefined {
    return this.lastEvidence === undefined ? undefined : structuredClone(this.lastEvidence);
  }
}

export function createUSShortFastProfile(frequencySlot: number, testedFirmware: string): RadioProfile {
  const profile: RadioProfile = {
    firmware: { minimum: "2.7.15", tested: testedFirmware },
    region: "US",
    modem_preset: "SHORT_FAST",
    hop_limit: 3,
    device_role: "CLIENT",
    rebroadcast_mode: "LOCAL_ONLY",
    frequency_slot: frequencySlot,
    tx_power: 0,
    power_saving: false,
    remote_administration: false,
    managed_mode: false,
    native_position: false,
    native_telemetry: false,
    mqtt: false,
    public_channel: {
      index: 0,
      name: "ATLAS-RENDEZVOUS",
      role: "PRIMARY",
      key_base64: "AQ==",
      uplink: false,
      downlink: false
    },
    private_channel: { index: 1, name: "ATLAS" }
  };
  validateRadioProfile(profile);
  return profile;
}

export function validateRadioProfile(profile: unknown): asserts profile is RadioProfile {
  if (
    !isRecord(profile) ||
    !isRecord(profile.firmware) ||
    !isRecord(profile.public_channel) ||
    !isRecord(profile.private_channel)
  ) {
    throw new TypeError("Radio profile must contain firmware and channel settings");
  }
  if (profile.region !== "US") throw new TypeError("the accepted initial Radio profile region is US");
  if (profile.modem_preset !== "SHORT_FAST" && profile.modem_preset !== "SHORT_TURBO") {
    throw new TypeError("the accepted modem presets are SHORT_FAST and explicit SHORT_TURBO experiments");
  }
  if (profile.hop_limit !== 3 || profile.device_role !== "CLIENT" || profile.rebroadcast_mode !== "LOCAL_ONLY") {
    throw new TypeError("the common profile requires hop limit 3, CLIENT, and LOCAL_ONLY");
  }
  if (
    typeof profile.frequency_slot !== "number" ||
    !Number.isSafeInteger(profile.frequency_slot) ||
    profile.frequency_slot <= 0
  ) {
    throw new TypeError("the US frequency slot must be selected explicitly");
  }
  if (
    profile.tx_power !== 0 ||
    profile.power_saving ||
    profile.remote_administration ||
    profile.managed_mode ||
    profile.native_position ||
    profile.native_telemetry ||
    profile.mqtt
  ) {
    throw new TypeError("Radio profile enables behavior excluded by the accepted architecture");
  }
  if (
    profile.public_channel.index !== 0 ||
    profile.public_channel.name !== "ATLAS-RENDEZVOUS" ||
    profile.public_channel.role !== "PRIMARY" ||
    profile.public_channel.key_base64 !== "AQ==" ||
    profile.public_channel.uplink ||
    profile.public_channel.downlink ||
    typeof profile.private_channel.index !== "number" ||
    profile.private_channel.index <= 0 ||
    profile.private_channel.index > 7 ||
    profile.private_channel.name !== "ATLAS"
  ) {
    throw new TypeError("Radio profile channel layout is invalid");
  }
  if (profile.firmware.minimum !== "2.7.15" || typeof profile.firmware.tested !== "string") {
    throw new TypeError("Radio profile firmware gate is invalid");
  }
  assertSupportedFirmware(profile.firmware.tested, profile.firmware.tested);
}

export function profileFingerprint(profile: RadioProfile): string {
  return `sha256:${createHash("sha256").update(canonicalJSON(profile)).digest("hex")}`;
}

export function profileDifferences(desired: RadioProfile, actual: ActualRadioConfiguration): ConfigurationDifference[] {
  const differences: ConfigurationDifference[] = [];
  compareOwned(differences, "region", desired.region, actual.region);
  compareOwned(differences, "modem_preset", desired.modem_preset, actual.modem_preset);
  compareOwned(differences, "hop_limit", desired.hop_limit, actual.hop_limit);
  compareOwned(differences, "device_role", desired.device_role, actual.device_role);
  compareOwned(differences, "rebroadcast_mode", desired.rebroadcast_mode, actual.rebroadcast_mode);
  compareOwned(differences, "frequency_slot", desired.frequency_slot, actual.frequency_slot);
  compareOwned(differences, "tx_power", desired.tx_power, actual.tx_power);
  compareOwned(differences, "power_saving", desired.power_saving, actual.power_saving);
  compareOwned(differences, "remote_administration", desired.remote_administration, actual.remote_administration);
  compareOwned(differences, "managed_mode", desired.managed_mode, actual.managed_mode);
  compareOwned(differences, "native_position", desired.native_position, actual.native_position);
  compareOwned(differences, "native_telemetry", desired.native_telemetry, actual.native_telemetry);
  compareOwned(differences, "mqtt", desired.mqtt, actual.mqtt);
  compareOwned(differences, "public_channel.index", desired.public_channel.index, actual.public_channel.index);
  compareOwned(differences, "public_channel.name", desired.public_channel.name, actual.public_channel.name);
  compareOwned(differences, "public_channel.role", desired.public_channel.role, actual.public_channel.role);
  compareOwned(
    differences,
    "public_channel.key_base64",
    desired.public_channel.key_base64,
    actual.public_channel.key_base64
  );
  compareOwned(differences, "public_channel.uplink", desired.public_channel.uplink, actual.public_channel.uplink);
  compareOwned(differences, "public_channel.downlink", desired.public_channel.downlink, actual.public_channel.downlink);
  compareOwned(differences, "private_channel.index", desired.private_channel.index, actual.private_channel.index);
  compareOwned(differences, "private_channel.name", desired.private_channel.name, actual.private_channel.name);
  return differences;
}

function compareOwned(
  differences: ConfigurationDifference[],
  path: string,
  desired: string | number | boolean,
  actual: string | number | boolean | undefined
): void {
  if (desired !== actual) differences.push({ path, desired, actual });
}

function sameMembership(left: PrivateChannelMembership, right: PrivateChannelMembership): boolean {
  return (
    left.channel_index === right.channel_index &&
    left.channel_name === right.channel_name &&
    left.channel_key_base64 === right.channel_key_base64
  );
}

function assertSupportedFirmware(actual: string, tested: string): void {
  if (compareVersions(actual, "2.7.15") < 0)
    throw new Error(`Meshtastic firmware ${actual} is older than required 2.7.15`);
  if (actual !== tested)
    throw new Error(`Meshtastic firmware ${actual} is not the tested deployment release ${tested}`);
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[.-].*)?$/.exec(value);
    if (!match) throw new TypeError(`invalid Meshtastic firmware version ${value}`);
    return match.slice(1).map(Number);
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
