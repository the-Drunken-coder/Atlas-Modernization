import { describe, expect, it } from "vitest";
import {
  type ActualRadioConfiguration,
  type ConfigurationDifference,
  createUSShortFastProfile,
  type PrivateChannelMembership,
  profileDifferences,
  type RadioConfigurationAdapter,
  type RadioProfile,
  RadioProfileManager
} from "./profile.js";

describe("radio profile", () => {
  it("uses a rendezvous channel name within the firmware byte limit", () => {
    const profile = createUSShortFastProfile(20, "2.7.15");

    expect(profile.public_channel.name).toBe("ATLAS-RDV");
    expect(new TextEncoder().encode(profile.public_channel.name).byteLength).toBeLessThanOrEqual(11);
  });

  it("reports preset mode and frequency overrides as owned differences", () => {
    const profile = createUSShortFastProfile(20, "2.7.15");
    const actual = matchingConfiguration(profile, { use_preset: false, override_frequency: 915 });

    expect(profileDifferences(profile, actual)).toEqual(
      expect.arrayContaining([
        { path: "use_preset", desired: true, actual: false },
        { path: "override_frequency", desired: 0, actual: 915 }
      ])
    );
  });

  it("keeps apply evidence tied to the selected profile when the desired profile changes", async () => {
    const firstProfile = createUSShortFastProfile(20, "2.7.15");
    const secondProfile = createUSShortFastProfile(21, "2.7.15");
    const adapter = new DelayedConfigurationAdapter(matchingConfiguration(firstProfile, { frequency_slot: 19 }));
    const manager = new RadioProfileManager(firstProfile, adapter);

    const applying = manager.apply();
    await adapter.writeStarted;
    manager.replaceProfile(secondProfile);
    adapter.releaseWrite();

    const evidence = await applying;
    expect(evidence.selected_profile.frequency_slot).toBe(20);
    expect(evidence.after?.frequency_slot).toBe(20);
    expect(evidence.verified).toBe(true);
    expect(manager.profile().frequency_slot).toBe(21);
  });

  it("serializes concurrent applies against one adapter", async () => {
    const profile = createUSShortFastProfile(20, "2.7.15");
    const adapter = new DelayedConfigurationAdapter(matchingConfiguration(profile, { frequency_slot: 19 }));
    const manager = new RadioProfileManager(profile, adapter);

    const first = manager.apply();
    await adapter.writeStarted;
    const second = manager.apply();
    await Promise.resolve();
    expect(adapter.appliedProfiles).toHaveLength(1);

    adapter.releaseWrite();
    await expect(first).resolves.toMatchObject({ verified: true });
    await expect(second).resolves.toMatchObject({ verified: true });
    expect(adapter.appliedProfiles).toHaveLength(1);
  });
});

function matchingConfiguration(
  profile: RadioProfile,
  overrides: Partial<ActualRadioConfiguration> = {}
): ActualRadioConfiguration {
  return {
    ...structuredClone(profile),
    hardware_model: "heltec-v3",
    firmware_version: profile.firmware.tested,
    use_preset: true,
    override_frequency: 0,
    ...overrides
  };
}

class DelayedConfigurationAdapter implements RadioConfigurationAdapter {
  configuration: ActualRadioConfiguration;
  readonly appliedProfiles: RadioProfile[] = [];
  readonly writeStarted: Promise<void>;
  private release!: () => void;

  constructor(configuration: ActualRadioConfiguration) {
    this.configuration = configuration;
    this.writeStarted = new Promise((resolve) => {
      this.writeStartedResolve = resolve;
    });
  }

  private writeStartedResolve!: () => void;

  async readConfiguration(): Promise<ActualRadioConfiguration> {
    return structuredClone(this.configuration);
  }

  async applyConfiguration(profile: RadioProfile, _differences: readonly ConfigurationDifference[]): Promise<void> {
    this.appliedProfiles.push(structuredClone(profile));
    this.writeStartedResolve();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.configuration = matchingConfiguration(profile);
  }

  releaseWrite(): void {
    this.release();
  }

  async readPrivateMembership(_privateChannelIndex: number): Promise<PrivateChannelMembership | undefined> {
    return undefined;
  }

  async clearPrivateMembership(_privateChannelIndex: number): Promise<void> {}

  async installPrivateMembership(_membership: PrivateChannelMembership): Promise<void> {}
}
