import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { ModuleConfig as FirmwareProtobuf } from "@meshtastic/protobufs-firmware";
import type {
  ActualRadioConfiguration,
  ConfigurationDifference,
  PrivateChannelMembership,
  RadioConfigurationAdapter,
  RadioProfile
} from "./profile.js";
import { PUBLIC_RENDEZVOUS_CHANNEL_NAME } from "./profile.js";
import { openSerialTransport } from "./serial.js";
import type { MessagePriority } from "./types.js";

export const MESHTASTIC_NATIVE_PLAINTEXT_PAYLOAD_BYTES = 231;
export const MESHTASTIC_NATIVE_PKI_PAYLOAD_BYTES = 219;
const MESHTASTIC_NATIVE_REQUEST_ID_BYTES = 5;

// Preserve Atlas scheduling when a packet moves from the host into the radio queue.
const RADIO_PRIORITIES: Record<MessagePriority, Protobuf.Mesh.MeshPacket_Priority> = {
  safety: Protobuf.Mesh.MeshPacket_Priority.ACK,
  task: Protobuf.Mesh.MeshPacket_Priority.HIGH,
  request: Protobuf.Mesh.MeshPacket_Priority.RELIABLE,
  live_state: Protobuf.Mesh.MeshPacket_Priority.DEFAULT,
  resource: Protobuf.Mesh.MeshPacket_Priority.BACKGROUND,
  object_content: Protobuf.Mesh.MeshPacket_Priority.BACKGROUND
};

type PendingRadioSend = {
  resolve: () => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Bounded observations of the local device queue-status stream. */
export type MeshtasticQueueMetrics = {
  statuses_observed: number;
  matched_local_admissions: number;
  matched_local_rejections: number;
  minimum_free: number | null;
  latest_free: number | null;
  latest_maxlen: number | null;
  full_queue_observations: number;
  zero_id_capacity_notifications: number;
};

type DeviceConnection = {
  device: MeshDevice;
  writePacket: (data: Uint8Array, shouldWrite?: () => boolean) => Promise<void>;
  disconnect: () => Promise<void>;
};

export type RadioPacket = {
  payload: Uint8Array;
  received_at: number;
  radio_source?: number;
  radio_packet_id?: number;
  channel: number;
  public_key_encrypted: boolean;
};

export type RadioSendOptions = {
  channel: number;
  priority?: MessagePriority;
  destination_radio_node?: number;
  require_public_key?: boolean;
  request_id?: number;
};

type NativePayloadOptions = Pick<RadioSendOptions, "destination_radio_node" | "require_public_key" | "request_id">;

export function meshtasticMaxPayloadBytes(options: NativePayloadOptions): number {
  const requestID = validateRequestID(options.request_id);
  const usesPki = options.require_public_key === true || options.destination_radio_node !== undefined;
  const nativeBudget = usesPki ? MESHTASTIC_NATIVE_PKI_PAYLOAD_BYTES : MESHTASTIC_NATIVE_PLAINTEXT_PAYLOAD_BYTES;
  return requestID === undefined ? nativeBudget : nativeBudget - MESHTASTIC_NATIVE_REQUEST_ID_BYTES;
}

export class RadioUnavailableError extends Error {
  constructor(message = "Meshtastic radio is unavailable") {
    super(message);
    this.name = "RadioUnavailableError";
  }
}

export interface LinkRadio {
  readonly max_payload_bytes: number;
  maxPayloadBytes?(options: RadioSendOptions): number;
  pacingDelayMs?(payload: Uint8Array): number;
  send(payload: Uint8Array, options: RadioSendOptions): Promise<void>;
  onPacket(handler: (packet: RadioPacket) => void): () => void;
  onDisconnect?(handler: (reason: Error) => void): () => void;
  close(): Promise<void>;
}

export interface LinkRadioTransmissionGate {
  suspend(): Promise<void>;
  resume(): void;
  abort(reason?: Error): void;
}

export class RadioTransmissionSuspendedError extends Error {
  constructor() {
    super("radio transmission is suspended");
    this.name = "RadioTransmissionSuspendedError";
  }
}

export class LinkRadioGate implements LinkRadio, LinkRadioTransmissionGate {
  readonly max_payload_bytes: number;
  private paused = false;
  private abortedReason: Error | undefined;
  private activeSends = 0;
  private drainPromise: Promise<void> | undefined;
  private resolveDrain: (() => void) | undefined;

  constructor(private readonly radio: LinkRadio) {
    this.max_payload_bytes = radio.max_payload_bytes;
  }

  pacingDelayMs(payload: Uint8Array): number {
    return this.radio.pacingDelayMs?.(payload) ?? 0;
  }

  maxPayloadBytes(options: RadioSendOptions): number {
    return this.radio.maxPayloadBytes?.(options) ?? this.max_payload_bytes;
  }

  async send(payload: Uint8Array, options: RadioSendOptions): Promise<void> {
    this.throwIfAborted();
    if (this.paused) throw new RadioTransmissionSuspendedError();
    this.throwIfAborted();
    this.activeSends++;
    try {
      await this.radio.send(payload, options);
    } finally {
      this.activeSends--;
      if (this.activeSends === 0) this.resolveDrain?.();
    }
  }

  onPacket(handler: (packet: RadioPacket) => void): () => void {
    return this.radio.onPacket(handler);
  }

  onDisconnect(handler: (reason: Error) => void): () => void {
    return this.radio.onDisconnect?.(handler) ?? (() => undefined);
  }

  async close(): Promise<void> {
    this.abort(new Error("radio is closed"));
    await this.radio.close();
  }

  async suspend(): Promise<void> {
    this.throwIfAborted();
    this.paused = true;
    if (this.activeSends === 0) return;
    if (!this.drainPromise) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.resolveDrain = resolve;
      });
    }
    await this.drainPromise;
    this.drainPromise = undefined;
    this.resolveDrain = undefined;
  }

  resume(): void {
    if (this.abortedReason) return;
    this.paused = false;
  }

  abort(reason = new Error("radio transmission is unavailable")): void {
    if (this.abortedReason) return;
    this.abortedReason = reason;
    this.paused = true;
    if (this.activeSends === 0) this.resolveDrain?.();
  }

  private throwIfAborted(): void {
    if (this.abortedReason) throw this.abortedReason;
  }
}

export class MeshtasticSerialRadio implements LinkRadio, RadioConfigurationAdapter {
  private static readonly sendStatusTimeoutMs = 15_000;
  readonly max_payload_bytes = MESHTASTIC_NATIVE_PLAINTEXT_PAYLOAD_BYTES;
  private readonly handlers = new Set<(packet: RadioPacket) => void>();
  private readonly disconnectHandlers = new Set<(reason: Error) => void>();
  private readonly knownPublicKeys = new Set<number>();
  private readonly configs = new Map<string, Protobuf.Config.Config>();
  private readonly moduleConfigs = new Map<string, Protobuf.ModuleConfig.ModuleConfig>();
  private readonly channels = new Map<number, Protobuf.Channel.Channel>();
  private metadata: Protobuf.Mesh.DeviceMetadata | undefined;
  private localRadioNodeNumber: number | undefined;
  private recoveringConfiguration = false;
  private closed = false;
  private available = true;
  private readonly pendingSends = new Map<number, PendingRadioSend>();
  private readonly mutableQueueMetrics: MeshtasticQueueMetrics = {
    statuses_observed: 0,
    matched_local_admissions: 0,
    matched_local_rejections: 0,
    minimum_free: null,
    latest_free: null,
    latest_maxlen: null,
    full_queue_observations: 0,
    zero_id_capacity_notifications: 0
  };
  private writePacket: (data: Uint8Array, shouldWrite?: () => boolean) => Promise<void>;

  private constructor(
    private readonly createTransport: () => Promise<Types.Transport>,
    private device: MeshDevice,
    writePacket: (data: Uint8Array, shouldWrite?: () => boolean) => Promise<void>,
    private disconnectTransport: () => Promise<void>
  ) {
    this.writePacket = writePacket;
    this.bindDevice(device);
  }

  private bindDevice(device: MeshDevice): void {
    const current = (): boolean => this.device === device;
    device.events.onMyNodeInfo.subscribe((node: Protobuf.Mesh.MyNodeInfo) => {
      if (!current()) return;
      this.localRadioNodeNumber = node.myNodeNum;
    });
    device.events.onConfigPacket.subscribe((config: Protobuf.Config.Config) => {
      if (!current()) return;
      if (config.payloadVariant.case) this.configs.set(config.payloadVariant.case, config);
    });
    device.events.onModuleConfigPacket.subscribe((config: Protobuf.ModuleConfig.ModuleConfig) => {
      if (!current()) return;
      if (config.payloadVariant.case) this.moduleConfigs.set(config.payloadVariant.case, config);
    });
    device.events.onChannelPacket.subscribe((channel: Protobuf.Channel.Channel) => {
      if (!current()) return;
      this.channels.set(channel.index, channel);
    });
    device.events.onDeviceMetadataPacket.subscribe((packet: { data: Protobuf.Mesh.DeviceMetadata }) => {
      if (!current()) return;
      this.metadata = packet.data;
    });
    device.events.onNodeInfoPacket.subscribe((node: Protobuf.Mesh.NodeInfo) => {
      if (!current()) return;
      if (node.user?.publicKey && node.user.publicKey.byteLength > 0) this.knownPublicKeys.add(node.num);
    });
    device.events.onMeshPacket.subscribe((packet: Protobuf.Mesh.MeshPacket) => {
      if (!current()) return;
      const decoded = packet.payloadVariant;
      if (
        decoded.case !== "decoded" ||
        decoded.value.portnum !== Protobuf.Portnums.PortNum.PRIVATE_APP ||
        decoded.value.payload.byteLength === 0
      ) {
        return;
      }
      const received: RadioPacket = {
        payload: decoded.value.payload,
        received_at: Date.now(),
        radio_source: packet.from,
        ...(packet.id === 0 ? {} : { radio_packet_id: packet.id }),
        channel: packet.channel,
        public_key_encrypted: packet.pkiEncrypted
      };
      for (const handler of this.handlers) handler(received);
    });
    device.events.onQueueStatus.subscribe((status: Protobuf.Mesh.QueueStatus) => {
      if (!current()) return;
      this.recordQueueStatus(status);
      if (status.meshPacketId === 0) return;
      const pending = this.pendingSends.get(status.meshPacketId);
      if (!pending) return;
      if (status.res === 0) {
        this.mutableQueueMetrics.matched_local_admissions++;
        this.settleSend(status.meshPacketId);
      } else {
        this.mutableQueueMetrics.matched_local_rejections++;
        this.settleSend(
          status.meshPacketId,
          new Error(`Meshtastic radio rejected packet ${status.meshPacketId} (${status.res})`)
        );
      }
    });
    device.events.onDeviceStatus.subscribe((status: Types.DeviceStatusEnum) => {
      if (!current()) return;
      if (status === Types.DeviceStatusEnum.DeviceConfigured) {
        this.available = true;
        return;
      }
      if (status !== Types.DeviceStatusEnum.DeviceDisconnected) return;
      this.available = false;
      const reason = new Error("Meshtastic radio disconnected");
      this.rejectPendingSends(reason);
      if (this.recoveringConfiguration || this.closed) return;
      for (const handler of this.disconnectHandlers) handler(reason);
    });
  }

  static async open(path: string): Promise<MeshtasticSerialRadio> {
    if (!path.startsWith("/dev/cu.")) throw new TypeError("Meshtastic serial paths must be macOS /dev/cu.* devices");
    return MeshtasticSerialRadio.openTransport(() => openSerialTransport(path));
  }

  /** Share the production device protocol with laboratory stream transports. */
  static async openTransport(createTransport: () => Promise<Types.Transport>): Promise<MeshtasticSerialRadio> {
    const connection = await MeshtasticSerialRadio.createDevice(createTransport);
    const radio = new MeshtasticSerialRadio(
      createTransport,
      connection.device,
      connection.writePacket,
      connection.disconnect
    );
    const device = connection.device;
    device.setHeartbeatInterval(20_000);
    try {
      await radio.configureAndWait(() => device.configure(), device);
      return radio;
    } catch (error) {
      try {
        await connection.disconnect();
      } catch {
        // Preserve the configuration failure that prevented the radio from opening.
      }
      try {
        await device.disconnect();
      } catch {
        // Preserve the configuration failure that prevented the radio from opening.
      }
      throw error;
    }
  }

  async send(payload: Uint8Array, options: RadioSendOptions): Promise<void> {
    if (this.closed) throw new Error("Meshtastic radio is closed");
    if (!this.available) throw new RadioUnavailableError();
    const requestID = validateRequestID(options.request_id);
    const maxPayloadBytes = this.maxPayloadBytes(options);
    if (payload.byteLength > maxPayloadBytes) {
      throw new RangeError(`Meshtastic application payload exceeds ${maxPayloadBytes} bytes for this send`);
    }
    const destination = options.destination_radio_node ?? "broadcast";
    if (options.require_public_key === true) {
      if (typeof destination !== "number" || !this.knownPublicKeys.has(destination)) {
        throw new Error("public-key-only send requires a destination with a known public key");
      }
    }
    const lora = this.configs.get("lora")?.payloadVariant;
    const packetId = this.nextPacketId();
    const packet = create(Protobuf.Mesh.MeshPacketSchema, {
      from: this.localRadioNodeNumber ?? 0,
      to: destination === "broadcast" ? 0xffffffff : destination,
      id: packetId,
      wantAck: false,
      priority:
        options.priority === undefined ? Protobuf.Mesh.MeshPacket_Priority.UNSET : RADIO_PRIORITIES[options.priority],
      hopLimit: lora?.case === "lora" ? lora.value.hopLimit : 0,
      channel: channelNumber(options.channel),
      payloadVariant: {
        case: "decoded",
        value: {
          payload,
          portnum: Protobuf.Portnums.PortNum.PRIVATE_APP,
          wantResponse: false,
          ...(requestID === undefined ? {} : { requestId: requestID })
        }
      }
    });
    const toRadio = toBinary(
      Protobuf.Mesh.ToRadioSchema,
      create(Protobuf.Mesh.ToRadioSchema, { payloadVariant: { case: "packet", value: packet } })
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settleSend(packetId, new Error(`Meshtastic radio did not accept packet ${packetId}`));
      }, MeshtasticSerialRadio.sendStatusTimeoutMs);
      this.pendingSends.set(packetId, { reject, resolve, timer });
      const writing = this.writePacket(
        toRadio,
        () => this.pendingSends.has(packetId) && this.available && !this.closed
      );
      void writing.then(
        () => undefined,
        (error: unknown) => this.settleSend(packetId, asError(error))
      );
    });
  }

  maxPayloadBytes(options: RadioSendOptions): number {
    return meshtasticMaxPayloadBytes(options);
  }

  /** Return a copy of queue diagnostics; these counters never imply RF completion. */
  queueMetrics(): MeshtasticQueueMetrics {
    return { ...this.mutableQueueMetrics };
  }

  onPacket(handler: (packet: RadioPacket) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onDisconnect(handler: (reason: Error) => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  nodeNumber(): number {
    this.throwIfUnavailable();
    if (this.localRadioNodeNumber === undefined) throw new Error("Meshtastic radio did not report its node number");
    return this.localRadioNodeNumber;
  }

  async readConfiguration(): Promise<ActualRadioConfiguration> {
    this.throwIfUnavailable();
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
      use_preset: lora.value.usePreset,
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
      override_frequency: lora.value.overrideFrequency,
      tx_power: lora.value.txPower,
      power_saving: power.value.isPowerSaving,
      remote_administration: security.value.adminChannelEnabled || security.value.adminKey.length > 0,
      managed_mode: device.value.isManaged || security.value.isManaged,
      native_position: [...this.channels.values()].some(
        (channel) => (channel.settings?.moduleSettings?.positionPrecision ?? 0) > 0
      ),
      native_telemetry: nativeTelemetryEnabled(telemetry.value),
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
    this.throwIfUnavailable();
    if (differences.length === 0) return;
    const publicChannelChanged = hasDifference(differences, ["public_channel"]);
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
    if (
      hasDifference(differences, [
        "region",
        "use_preset",
        "modem_preset",
        "hop_limit",
        "frequency_slot",
        "override_frequency",
        "tx_power"
      ])
    ) {
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
            channelNum: profile.frequency_slot,
            overrideFrequency: 0
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
      for (const channel of this.channels.values()) {
        if (channel.index === 0 && publicChannelChanged) continue;
        if ((channel.settings?.moduleSettings?.positionPrecision ?? 0) > 0) {
          await this.device.setChannel(disableChannelPosition(channel));
        }
      }
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
            ...disableDeviceTelemetry(current.payloadVariant.value),
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
    if (publicChannelChanged) {
      await this.device.setChannel(
        updateChannel(this.requireChannel(0), PUBLIC_RENDEZVOUS_CHANNEL_NAME, Uint8Array.of(1), true)
      );
    }
    await this.commitAndRefresh();
  }

  async readPrivateMembership(privateChannelIndex: number): Promise<PrivateChannelMembership | undefined> {
    this.throwIfUnavailable();
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
    this.throwIfUnavailable();
    await this.device.clearChannel(privateChannelIndex);
    await this.commitAndRefresh();
  }

  async installPrivateMembership(membership: PrivateChannelMembership): Promise<void> {
    this.throwIfUnavailable();
    const key = Uint8Array.from(Buffer.from(membership.channel_key_base64, "base64"));
    if (key.byteLength !== 16 && key.byteLength !== 32)
      throw new TypeError("private channel key must be 16 or 32 bytes");
    await this.device.setChannel(
      updateChannel(this.requireChannel(membership.channel_index), membership.channel_name, key, false)
    );
    await this.commitAndRefresh();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectPendingSends(new Error("Meshtastic radio is closed"));
    this.handlers.clear();
    this.disconnectHandlers.clear();
    await this.disconnectTransport();
    try {
      await this.device.disconnect();
    } catch (error) {
      if (!isClosedStreamError(error)) throw error;
    }
  }

  private requireConfig(kind: string): Protobuf.Config.Config {
    const config = this.configs.get(kind);
    if (!config) throw new Error(`Meshtastic ${kind} configuration was not reported by the radio`);
    return config;
  }

  private throwIfUnavailable(): void {
    if (this.closed || !this.available) throw new RadioUnavailableError();
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
    this.recoveringConfiguration = true;
    const device = this.device;
    const configured = this.waitForConfigured(device);
    const commit = device.commitEditSettings();
    void commit.catch(() => undefined);
    try {
      const first = await Promise.race([
        commit.then(() => "commit" as const),
        configured.promise.then(() => "configured" as const)
      ]);
      if (first === "configured") await commit;
      else await configured.promise;
    } catch (error) {
      configured.cancel();
      if (!configured.disconnected() && !isDisconnectError(error)) throw error;
      await this.reconnectAndConfigure();
    } finally {
      this.recoveringConfiguration = false;
    }
  }

  private async reconnectAndConfigure(timeoutMs = 45_000): Promise<void> {
    this.available = false;
    this.rejectPendingSends(new Error("Meshtastic radio connection is restarting"));
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = new Error("Meshtastic radio did not reconnect");
    while (Date.now() < deadline) {
      let device: MeshDevice | undefined;
      let connection: DeviceConnection | undefined;
      try {
        connection = await MeshtasticSerialRadio.createDevice(this.createTransport);
        device = connection.device;
        this.device = device;
        this.writePacket = connection.writePacket;
        this.disconnectTransport = connection.disconnect;
        this.available = false;
        this.resetSnapshot();
        this.bindDevice(device);
        device.setHeartbeatInterval(20_000);
        const connectedDevice = device;
        await this.configureAndWait(
          () => connectedDevice.configure(),
          connectedDevice,
          Math.max(1, deadline - Date.now())
        );
        return;
      } catch (error) {
        lastError = error;
        if (device !== undefined) {
          try {
            await connection?.disconnect();
          } catch {
            // Preserve the reconnect failure.
          }
          try {
            await device.disconnect();
          } catch {
            // Preserve the reconnect failure.
          }
          if (!isDisconnectError(error)) throw error;
        }
        const remaining = deadline - Date.now();
        if (remaining > 0) await delay(Math.min(250, remaining));
      }
    }
    throw new Error(`Meshtastic radio did not reconnect after configuration: ${errorMessage(lastError)}`);
  }

  private resetSnapshot(): void {
    this.knownPublicKeys.clear();
    this.configs.clear();
    this.moduleConfigs.clear();
    this.channels.clear();
    this.metadata = undefined;
    this.localRadioNodeNumber = undefined;
  }

  private static async createDevice(createTransport: () => Promise<Types.Transport>): Promise<DeviceConnection> {
    const transport = await createTransport();
    let writes: Promise<void> = Promise.resolve();
    let outputClosed = false;
    const writePacket = (chunk: Uint8Array, shouldWrite = (): boolean => true): Promise<void> => {
      const operation = writes.then(() =>
        outputClosed || !shouldWrite() ? undefined : writeToWritable(transport.toDevice, chunk)
      );
      writes = operation.catch(() => undefined);
      return operation;
    };
    const toDevice = new WritableStream<Uint8Array>({
      write: (chunk) => writePacket(chunk),
      close: async () => {
        outputClosed = true;
        await transport.disconnect();
        void transport.toDevice.abort(new Error("Meshtastic radio output is closed")).catch(() => undefined);
      },
      abort: async (reason) => {
        outputClosed = true;
        await transport.toDevice.abort(reason);
      }
    });
    return {
      device: new MeshDevice({
        fromDevice: transport.fromDevice,
        toDevice,
        disconnect: () => transport.disconnect()
      }),
      writePacket,
      disconnect: async () => {
        outputClosed = true;
        await transport.disconnect();
        void transport.toDevice.abort(new Error("Meshtastic radio output is closed")).catch(() => undefined);
      }
    };
  }

  private async configureAndWait(
    operation: () => Promise<unknown>,
    device: MeshDevice,
    timeoutMs = 45_000
  ): Promise<void> {
    const configured = this.waitForConfigured(device, timeoutMs);
    const operationPromise = operation();
    void operationPromise.catch(() => undefined);
    try {
      await Promise.race([configured.promise, operationPromise.then(() => configured.promise)]);
    } catch (error) {
      configured.cancel();
      throw error;
    }
  }

  private nextPacketId(): number {
    let packetId = randomPacketId();
    while (this.pendingSends.has(packetId)) packetId = randomPacketId();
    return packetId;
  }

  private recordQueueStatus(status: Protobuf.Mesh.QueueStatus): void {
    this.mutableQueueMetrics.statuses_observed++;
    const free = status.free;
    const maxlen = status.maxlen;
    // A zero maxlen is the protobuf default, not a usable queue-capacity report.
    if (!Number.isInteger(free) || !Number.isInteger(maxlen) || maxlen <= 0 || free < 0 || free > maxlen) return;

    this.mutableQueueMetrics.minimum_free =
      this.mutableQueueMetrics.minimum_free === null ? free : Math.min(this.mutableQueueMetrics.minimum_free, free);
    this.mutableQueueMetrics.latest_free = free;
    this.mutableQueueMetrics.latest_maxlen = maxlen;
    if (free === 0) this.mutableQueueMetrics.full_queue_observations++;
    if (status.meshPacketId === 0) this.mutableQueueMetrics.zero_id_capacity_notifications++;
  }

  private settleSend(packetId: number, error?: Error): void {
    const pending = this.pendingSends.get(packetId);
    if (!pending) return;
    this.pendingSends.delete(packetId);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private rejectPendingSends(reason: Error): void {
    for (const packetId of this.pendingSends.keys()) this.settleSend(packetId, reason);
  }

  private waitForConfigured(
    device: MeshDevice,
    timeoutMs = 45_000
  ): { promise: Promise<void>; cancel: () => void; disconnected: () => boolean } {
    let cancel = (): void => undefined;
    let disconnected = false;
    const promise = new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        device.events.onDeviceStatus.unsubscribe(onStatus);
        if (error) reject(error);
        else resolve();
      };
      const onStatus = (status: Types.DeviceStatusEnum): void => {
        if (status === Types.DeviceStatusEnum.DeviceConfigured) finish();
        else if (status === Types.DeviceStatusEnum.DeviceDisconnected) {
          disconnected = true;
          finish(new Error("Meshtastic radio disconnected"));
        }
      };
      const timeout = setTimeout(() => finish(new Error("timed out waiting for Meshtastic configuration")), timeoutMs);
      device.events.onDeviceStatus.subscribe(onStatus);
      cancel = () => finish();
    });
    return { promise, cancel, disconnected: () => disconnected };
  }
}

function isDisconnectError(error: unknown): boolean {
  return /disconnect|connection lost|port.+clos/i.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function randomPacketId(): number {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  if (seed === 0) throw new Error("Cannot generate Meshtastic packet identifier");
  return seed;
}

function validateRequestID(requestID: number | undefined): number | undefined {
  if (requestID === undefined) return undefined;
  if (!Number.isInteger(requestID) || requestID < 1 || requestID > 0xffffffff) {
    throw new RangeError("Meshtastic request_id must be a nonzero uint32");
  }
  return requestID;
}

function isClosedStreamError(error: unknown): boolean {
  return /stream is locked|stream is closed|invalid state/i.test(errorMessage(error));
}

async function writeToWritable(output: WritableStream<Uint8Array>, data: Uint8Array): Promise<void> {
  const writer = output.getWriter();
  try {
    await writer.write(data);
  } finally {
    writer.releaseLock();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
      downlinkEnabled: false,
      moduleSettings: create(Protobuf.Channel.ModuleSettingsSchema, {
        ...current.settings.moduleSettings,
        positionPrecision: 0
      })
    }
  };
}

function disableChannelPosition(current: Protobuf.Channel.Channel): Protobuf.Channel.Channel {
  if (!current.settings) throw new Error(`Meshtastic channel ${current.index} has no settings`);
  return {
    ...current,
    settings: {
      ...current.settings,
      moduleSettings: create(Protobuf.Channel.ModuleSettingsSchema, {
        ...current.settings.moduleSettings,
        positionPrecision: 0
      })
    }
  };
}

function hasDifference(differences: readonly ConfigurationDifference[], prefixes: readonly string[]): boolean {
  return differences.some((difference) => prefixes.some((prefix) => difference.path.startsWith(prefix)));
}

function nativeTelemetryEnabled(config: Protobuf.ModuleConfig.ModuleConfig_TelemetryConfig): boolean {
  const current = fromBinary(
    FirmwareProtobuf.ModuleConfig_TelemetryConfigSchema,
    toBinary(Protobuf.ModuleConfig.ModuleConfig_TelemetryConfigSchema, config)
  );
  return (
    current.deviceTelemetryEnabled ||
    current.environmentMeasurementEnabled ||
    current.airQualityEnabled ||
    current.powerMeasurementEnabled ||
    current.healthMeasurementEnabled
  );
}

function disableDeviceTelemetry(
  current: Protobuf.ModuleConfig.ModuleConfig_TelemetryConfig
): Protobuf.ModuleConfig.ModuleConfig_TelemetryConfig {
  const firmwareCurrent = fromBinary(
    FirmwareProtobuf.ModuleConfig_TelemetryConfigSchema,
    toBinary(Protobuf.ModuleConfig.ModuleConfig_TelemetryConfigSchema, current)
  );
  return fromBinary(
    Protobuf.ModuleConfig.ModuleConfig_TelemetryConfigSchema,
    toBinary(FirmwareProtobuf.ModuleConfig_TelemetryConfigSchema, {
      ...firmwareCurrent,
      deviceTelemetryEnabled: false
    })
  );
}
