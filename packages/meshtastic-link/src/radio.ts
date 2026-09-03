import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";
import type {
  ActualRadioConfiguration,
  ConfigurationDifference,
  PrivateChannelMembership,
  RadioConfigurationAdapter,
  RadioProfile
} from "./profile.js";

export type RadioPacket = {
  payload: Uint8Array;
  received_at: number;
  radio_source?: number;
  channel: number;
  public_key_encrypted: boolean;
};

export type RadioSendOptions = {
  channel: number;
  destination_radio_node?: number;
  require_public_key?: boolean;
};

export interface LinkRadio {
  readonly max_payload_bytes: number;
  pacingDelayMs?(payload: Uint8Array): number;
  send(payload: Uint8Array, options: RadioSendOptions): Promise<void>;
  onPacket(handler: (packet: RadioPacket) => void): () => void;
  close(): Promise<void>;
}

export class MeshtasticSerialRadio implements LinkRadio, RadioConfigurationAdapter {
  readonly max_payload_bytes = 233;
  private readonly handlers = new Set<(packet: RadioPacket) => void>();
  private readonly knownPublicKeys = new Set<number>();
  private readonly configs = new Map<string, Protobuf.Config.Config>();
  private readonly moduleConfigs = new Map<string, Protobuf.ModuleConfig.ModuleConfig>();
  private readonly channels = new Map<number, Protobuf.Channel.Channel>();
  private metadata: Protobuf.Mesh.DeviceMetadata | undefined;
  private localRadioNodeNumber: number | undefined;
  private constructor(private readonly device: MeshDevice) {
    device.events.onMyNodeInfo.subscribe((node: Protobuf.Mesh.MyNodeInfo) => {
      this.localRadioNodeNumber = node.myNodeNum;
    });
    device.events.onConfigPacket.subscribe((config: Protobuf.Config.Config) => {
      if (config.payloadVariant.case) this.configs.set(config.payloadVariant.case, config);
    });
    device.events.onModuleConfigPacket.subscribe((config: Protobuf.ModuleConfig.ModuleConfig) => {
      if (config.payloadVariant.case) this.moduleConfigs.set(config.payloadVariant.case, config);
    });
    device.events.onChannelPacket.subscribe((channel: Protobuf.Channel.Channel) => {
      this.channels.set(channel.index, channel);
    });
    device.events.onDeviceMetadataPacket.subscribe((packet: { data: Protobuf.Mesh.DeviceMetadata }) => {
      this.metadata = packet.data;
    });
    device.events.onNodeInfoPacket.subscribe((node: Protobuf.Mesh.NodeInfo) => {
      if (node.user?.publicKey && node.user.publicKey.byteLength > 0) this.knownPublicKeys.add(node.num);
    });
    device.events.onMeshPacket.subscribe((packet: Protobuf.Mesh.MeshPacket) => {
      if (
        packet.decoded?.portnum !== Protobuf.Portnums.PortNum.PRIVATE_APP ||
        packet.decoded.payload.byteLength === 0
      ) {
        return;
      }
      const received: RadioPacket = {
        payload: packet.decoded.payload,
        received_at: Date.now(),
        radio_source: packet.from,
        channel: packet.channel,
        public_key_encrypted: packet.pkiEncrypted
      };
      for (const handler of this.handlers) handler(received);
    });
  }

  static async open(path: string): Promise<MeshtasticSerialRadio> {
    if (!path.startsWith("/dev/cu.")) throw new TypeError("Meshtastic serial paths must be macOS /dev/cu.* devices");
    const transport = await TransportNodeSerial.create(path, 115_200);
    const device = new MeshDevice(transport);
    const radio = new MeshtasticSerialRadio(device);
    device.setHeartbeatInterval(20_000);
    const configured = radio.waitForConfigured();
    await device.configure();
    await configured;
    return radio;
  }

  async send(payload: Uint8Array, options: RadioSendOptions): Promise<void> {
    if (payload.byteLength > this.max_payload_bytes)
      throw new RangeError("Meshtastic application payload exceeds 233 bytes");
    const destination = options.destination_radio_node ?? "broadcast";
    if (options.require_public_key === true) {
      if (typeof destination !== "number" || !this.knownPublicKeys.has(destination)) {
        throw new Error("public-key-only send requires a destination with a known public key");
      }
    }
    await this.device.sendPacket(
      payload,
      Protobuf.Portnums.PortNum.PRIVATE_APP,
      destination,
      channelNumber(options.channel),
      false,
      false
    );
  }

  onPacket(handler: (packet: RadioPacket) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  nodeNumber(): number {
    if (this.localRadioNodeNumber === undefined) throw new Error("Meshtastic radio did not report its node number");
    return this.localRadioNodeNumber;
  }

  async readConfiguration(): Promise<ActualRadioConfiguration> {
    const device = this.requireConfig("device").payloadVariant;
    const lora = this.requireConfig("lora").payloadVariant;
    const power = this.requireConfig("power").payloadVariant;
    const position = this.requireConfig("position").payloadVariant;
    const security = this.requireConfig("security").payloadVariant;
    const mqtt = this.requireModuleConfig("mqtt").payloadVariant;
    const telemetry = this.requireModuleConfig("telemetry").payloadVariant;
    if (
      device.case !== "device" ||
      lora.case !== "lora" ||
      power.case !== "power" ||
      position.case !== "position" ||
      security.case !== "security" ||
      mqtt.case !== "mqtt" ||
      telemetry.case !== "telemetry" ||
      !this.metadata
    ) {
      throw new Error("Meshtastic configuration snapshot is incomplete");
    }
    const publicChannel = this.channels.get(0);
    const privateChannel = [...this.channels.values()].find(
      (channel) => channel.index > 0 && channel.settings?.name === "ATLAS"
    );
    return {
      hardware_model: String(this.metadata.hwModel),
      firmware_version: this.metadata.firmwareVersion,
      firmware: { minimum: "2.7.15", tested: this.metadata.firmwareVersion },
      region:
        lora.value.region === Protobuf.Config.Config_LoRaConfig_RegionCode.US ? "US" : `enum:${lora.value.region}`,
      modem_preset:
        lora.value.modemPreset === Protobuf.Config.Config_LoRaConfig_ModemPreset.SHORT_FAST
          ? "SHORT_FAST"
          : lora.value.modemPreset === Protobuf.Config.Config_LoRaConfig_ModemPreset.SHORT_TURBO
            ? "SHORT_TURBO"
            : `enum:${lora.value.modemPreset}`,
      hop_limit: lora.value.hopLimit,
      device_role:
        device.value.role === Protobuf.Config.Config_DeviceConfig_Role.CLIENT ? "CLIENT" : `enum:${device.value.role}`,
      rebroadcast_mode:
        device.value.rebroadcastMode === Protobuf.Config.Config_DeviceConfig_RebroadcastMode.LOCAL_ONLY
          ? "LOCAL_ONLY"
          : `enum:${device.value.rebroadcastMode}`,
      frequency_slot: lora.value.channelNum,
      tx_power: lora.value.txPower,
      power_saving: power.value.isPowerSaving,
      remote_administration: security.value.adminChannelEnabled || security.value.adminKey.length > 0,
      managed_mode: device.value.isManaged || security.value.isManaged,
      native_position: position.value.positionBroadcastSecs > 0 || position.value.positionBroadcastSmartEnabled,
      native_telemetry: telemetryEnabled(telemetry.value),
      mqtt: mqtt.value.enabled || mqtt.value.proxyToClientEnabled || mqtt.value.mapReportingEnabled,
      public_channel: {
        index: 0,
        name: publicChannel?.settings?.name ?? "",
        role:
          publicChannel?.role === Protobuf.Channel.Channel_Role.PRIMARY
            ? "PRIMARY"
            : `enum:${publicChannel?.role ?? -1}`,
        key_base64: Buffer.from(publicChannel?.settings?.psk ?? []).toString("base64"),
        uplink: publicChannel?.settings?.uplinkEnabled ?? false,
        downlink: publicChannel?.settings?.downlinkEnabled ?? false
      },
      private_channel: {
        index: privateChannel?.index ?? -1,
        name: privateChannel?.settings?.name ?? ""
      }
    };
  }

  async applyConfiguration(profile: RadioProfile, differences: readonly ConfigurationDifference[]): Promise<void> {
    if (differences.length === 0) return;
    if (hasDifference(differences, ["device_role", "rebroadcast_mode", "managed_mode"])) {
      const current = this.requireConfig("device");
      if (current.payloadVariant.case !== "device") throw new Error("Meshtastic device configuration is unavailable");
      await this.device.setConfig({
        ...current,
        payloadVariant: {
          case: "device",
          value: {
            ...current.payloadVariant.value,
            role: Protobuf.Config.Config_DeviceConfig_Role.CLIENT,
            rebroadcastMode: Protobuf.Config.Config_DeviceConfig_RebroadcastMode.LOCAL_ONLY,
            isManaged: false
          }
        }
      });
    }
    if (hasDifference(differences, ["region", "modem_preset", "hop_limit", "frequency_slot", "tx_power"])) {
      const current = this.requireConfig("lora");
      if (current.payloadVariant.case !== "lora") throw new Error("Meshtastic LoRa configuration is unavailable");
      await this.device.setConfig({
        ...current,
        payloadVariant: {
          case: "lora",
          value: {
            ...current.payloadVariant.value,
            usePreset: true,
            modemPreset:
              profile.modem_preset === "SHORT_FAST"
                ? Protobuf.Config.Config_LoRaConfig_ModemPreset.SHORT_FAST
                : Protobuf.Config.Config_LoRaConfig_ModemPreset.SHORT_TURBO,
            region: Protobuf.Config.Config_LoRaConfig_RegionCode.US,
            hopLimit: 3,
            txPower: 0,
            channelNum: profile.frequency_slot
          }
        }
      });
    }
    if (hasDifference(differences, ["power_saving"])) {
      const current = this.requireConfig("power");
      if (current.payloadVariant.case !== "power") throw new Error("Meshtastic power configuration is unavailable");
      await this.device.setConfig({
        ...current,
        payloadVariant: {
          case: "power",
          value: { ...current.payloadVariant.value, isPowerSaving: false }
        }
      });
    }
    if (hasDifference(differences, ["native_position"])) {
      const current = this.requireConfig("position");
      if (current.payloadVariant.case !== "position")
        throw new Error("Meshtastic position configuration is unavailable");
      await this.device.setConfig({
        ...current,
        payloadVariant: {
          case: "position",
          value: {
            ...current.payloadVariant.value,
            positionBroadcastSecs: 0,
            positionBroadcastSmartEnabled: false,
            positionFlags: 0
          }
        }
      });
    }
    if (hasDifference(differences, ["remote_administration", "managed_mode"])) {
      const current = this.requireConfig("security");
      if (current.payloadVariant.case !== "security")
        throw new Error("Meshtastic security configuration is unavailable");
      await this.device.setConfig({
        ...current,
        payloadVariant: {
          case: "security",
          value: {
            ...current.payloadVariant.value,
            adminKey: [],
            adminChannelEnabled: false,
            isManaged: false
          }
        }
      });
    }
    if (hasDifference(differences, ["mqtt"])) {
      const current = this.requireModuleConfig("mqtt");
      if (current.payloadVariant.case !== "mqtt") throw new Error("Meshtastic MQTT configuration is unavailable");
      await this.device.setModuleConfig({
        ...current,
        payloadVariant: {
          case: "mqtt",
          value: {
            ...current.payloadVariant.value,
            enabled: false,
            proxyToClientEnabled: false,
            mapReportingEnabled: false
          }
        }
      });
    }
    if (hasDifference(differences, ["native_telemetry"])) {
      const current = this.requireModuleConfig("telemetry");
      if (current.payloadVariant.case !== "telemetry") {
        throw new Error("Meshtastic telemetry configuration is unavailable");
      }
      await this.device.setModuleConfig({
        ...current,
        payloadVariant: {
          case: "telemetry",
          value: {
            ...current.payloadVariant.value,
            deviceUpdateInterval: 0,
            environmentUpdateInterval: 0,
            environmentMeasurementEnabled: false,
            airQualityEnabled: false,
            airQualityInterval: 0,
            powerMeasurementEnabled: false,
            powerUpdateInterval: 0,
            healthMeasurementEnabled: false,
            healthUpdateInterval: 0
          }
        }
      });
    }
    if (hasDifference(differences, ["public_channel"])) {
      await this.device.setChannel(updateChannel(this.requireChannel(0), "ATLAS-RENDEZVOUS", Uint8Array.of(1), true));
    }
    await this.commitAndRefresh();
  }

  async readPrivateMembership(privateChannelIndex: number): Promise<PrivateChannelMembership | undefined> {
    const channel = this.channels.get(privateChannelIndex);
    if (channel?.role !== Protobuf.Channel.Channel_Role.SECONDARY || !channel.settings) return undefined;
    const key = Buffer.from(channel.settings.psk);
    if ((key.byteLength !== 16 && key.byteLength !== 32) || channel.settings.name !== "ATLAS") return undefined;
    return {
      channel_index: privateChannelIndex,
      channel_name: channel.settings.name,
      channel_key_base64: key.toString("base64")
    };
  }

  async clearPrivateMembership(privateChannelIndex: number): Promise<void> {
    await this.device.clearChannel(privateChannelIndex);
    await this.commitAndRefresh();
  }

  async installPrivateMembership(membership: PrivateChannelMembership): Promise<void> {
    const key = Uint8Array.from(Buffer.from(membership.channel_key_base64, "base64"));
    if (key.byteLength !== 16 && key.byteLength !== 32)
      throw new TypeError("private channel key must be 16 or 32 bytes");
    await this.device.setChannel(
      updateChannel(this.requireChannel(membership.channel_index), membership.channel_name, key, false)
    );
    await this.commitAndRefresh();
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await this.device.disconnect();
  }

  private requireConfig(kind: string): Protobuf.Config.Config {
    const config = this.configs.get(kind);
    if (!config) throw new Error(`Meshtastic ${kind} configuration was not reported by the radio`);
    return config;
  }

  private requireModuleConfig(kind: string): Protobuf.ModuleConfig.ModuleConfig {
    const config = this.moduleConfigs.get(kind);
    if (!config) throw new Error(`Meshtastic ${kind} module configuration was not reported by the radio`);
    return config;
  }

  private requireChannel(index: number): Protobuf.Channel.Channel {
    const channel = this.channels.get(index);
    if (!channel?.settings) throw new Error(`Meshtastic channel ${index} was not reported by the radio`);
    return channel;
  }

  private async commitAndRefresh(): Promise<void> {
    const configured = this.waitForConfigured();
    await this.device.commitEditSettings();
    await configured;
  }

  private waitForConfigured(timeoutMs = 45_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        this.device.events.onDeviceStatus.unsubscribe(onStatus);
        if (error) reject(error);
        else resolve();
      };
      const onStatus = (status: Types.DeviceStatusEnum): void => {
        if (status === Types.DeviceStatusEnum.DeviceConfigured) finish();
        else if (status === Types.DeviceStatusEnum.DeviceDisconnected)
          finish(new Error("Meshtastic radio disconnected"));
      };
      const timeout = setTimeout(() => finish(new Error("timed out waiting for Meshtastic configuration")), timeoutMs);
      this.device.events.onDeviceStatus.subscribe(onStatus);
    });
  }
}

function channelNumber(index: number): Types.ChannelNumber {
  if (!Number.isInteger(index) || index < Types.ChannelNumber.Primary || index > Types.ChannelNumber.Admin) {
    throw new RangeError("Meshtastic channel index must be between 0 and 7");
  }
  return index;
}

function updateChannel(
  current: Protobuf.Channel.Channel,
  name: string,
  psk: Uint8Array,
  primary: boolean
): Protobuf.Channel.Channel {
  if (!current.settings) throw new Error(`Meshtastic channel ${current.index} has no settings`);
  return {
    ...current,
    role: primary ? Protobuf.Channel.Channel_Role.PRIMARY : Protobuf.Channel.Channel_Role.SECONDARY,
    settings: {
      ...current.settings,
      name,
      psk,
      uplinkEnabled: false,
      downlinkEnabled: false
    }
  };
}

function hasDifference(differences: readonly ConfigurationDifference[], prefixes: readonly string[]): boolean {
  return differences.some((difference) => prefixes.some((prefix) => difference.path.startsWith(prefix)));
}

function telemetryEnabled(config: Protobuf.ModuleConfig.ModuleConfig_TelemetryConfig): boolean {
  return (
    config.deviceUpdateInterval > 0 ||
    config.environmentUpdateInterval > 0 ||
    config.environmentMeasurementEnabled ||
    config.airQualityEnabled ||
    config.powerMeasurementEnabled ||
    config.healthMeasurementEnabled
  );
}
