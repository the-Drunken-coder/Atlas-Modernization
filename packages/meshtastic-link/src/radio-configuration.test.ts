import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Protobuf, Types } from "@meshtastic/core";
import { ModuleConfig as Firmware } from "@meshtastic/protobufs-firmware";
import { describe, expect, it, vi } from "vitest";
import { createUSShortFastProfile, RadioProfileManager } from "./profile.js";
import { MeshtasticSerialRadio } from "./radio.js";

const harness = vi.hoisted(() => ({ device: undefined as ReturnType<typeof configuredDevice> | undefined }));
vi.mock("@meshtastic/transport-node-serial", () => ({
  TransportNodeSerial: {
    create: vi.fn(async () => ({
      fromDevice: new ReadableStream(),
      toDevice: new WritableStream(),
      disconnect: vi.fn(async () => undefined)
    }))
  }
}));
vi.mock("@meshtastic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@meshtastic/core")>()),
  MeshDevice: vi.fn(function () {
    if (!harness.device) throw new Error("test device is not configured");
    return harness.device;
  })
}));

describe("radio configuration readback", () => {
  it("converges the firmware settings and keeps native broadcasts disabled after membership installation", async () => {
    const device = configuredDevice();
    harness.device = device;
    const radio = await MeshtasticSerialRadio.open("/dev/cu.test");
    const profile = createUSShortFastProfile(20, "2.7.15");
    const manager = new RadioProfileManager(profile, radio);
    try {
      expect(await radio.readConfiguration()).toMatchObject({
        use_preset: false,
        override_frequency: 915,
        native_position: true,
        native_telemetry: true
      });
      const applied = await manager.apply();
      expect(applied.verified).toBe(true);
      expect(applied.after).toMatchObject({
        use_preset: true,
        override_frequency: 0,
        native_position: false,
        native_telemetry: false,
        public_channel: { name: "ATLAS-RDV" }
      });
      expect(device.setConfig.mock.calls.map(([config]) => config.payloadVariant.case)).toEqual(["lora"]);
      expect(device.setChannel).toHaveBeenCalledTimes(2);
      const telemetry = device.modules.get("telemetry");
      if (telemetry?.payloadVariant.case !== "telemetry") throw new Error("missing telemetry readback");
      const firmwareReadback = fromBinary(
        Firmware.ModuleConfig_TelemetryConfigSchema,
        toBinary(Protobuf.ModuleConfig.ModuleConfig_TelemetryConfigSchema, telemetry.payloadVariant.value)
      );
      expect(firmwareReadback.deviceTelemetryEnabled).toBe(false);
      expect(
        [...device.channels.values()].map((channel) => channel.settings?.moduleSettings?.positionPrecision)
      ).toEqual([0, 0]);
      expect(device.configs.get("position")?.payloadVariant).toMatchObject({
        case: "position",
        value: { positionBroadcastSecs: 600, positionBroadcastSmartEnabled: true, positionFlags: 3 }
      });

      const writes = device.setChannel.mock.calls.length;
      await expect(manager.apply()).resolves.toMatchObject({ verified: true, requested_changes: [] });
      expect(device.setChannel).toHaveBeenCalledTimes(writes);
      expect(device.setConfig).toHaveBeenCalledTimes(1);
      expect(device.setModuleConfig).toHaveBeenCalledTimes(1);

      await manager.installAssetMembership({
        channel_index: 1,
        channel_name: "ATLAS",
        channel_key_base64: Buffer.alloc(32, 7).toString("base64")
      });
      expect(await radio.readConfiguration()).toMatchObject({ native_position: false, native_telemetry: false });
      await expect(manager.diff()).resolves.toEqual([]);
    } finally {
      await radio.close();
    }
  });
});

function event<T>() {
  const handlers = new Set<(value: T) => void>();
  return {
    subscribe: (handler: (value: T) => void) => handlers.add(handler),
    unsubscribe: (handler: (value: T) => void) => handlers.delete(handler),
    emit(value: T) {
      for (const handler of handlers) handler(value);
    }
  };
}

function configuredDevice() {
  const configs = new Map<string, Protobuf.Config.Config>([
    [
      "device",
      create(Protobuf.Config.ConfigSchema, {
        payloadVariant: {
          case: "device",
          value: {
            role: Protobuf.Config.Config_DeviceConfig_Role.CLIENT,
            rebroadcastMode: Protobuf.Config.Config_DeviceConfig_RebroadcastMode.LOCAL_ONLY
          }
        }
      })
    ],
    [
      "lora",
      create(Protobuf.Config.ConfigSchema, {
        payloadVariant: {
          case: "lora",
          value: {
            region: Protobuf.Config.Config_LoRaConfig_RegionCode.US,
            usePreset: false,
            modemPreset: Protobuf.Config.Config_LoRaConfig_ModemPreset.SHORT_FAST,
            channelNum: 20,
            overrideFrequency: 915,
            hopLimit: 3
          }
        }
      })
    ],
    ["power", create(Protobuf.Config.ConfigSchema, { payloadVariant: { case: "power", value: {} } })],
    ["security", create(Protobuf.Config.ConfigSchema, { payloadVariant: { case: "security", value: {} } })],
    [
      "position",
      create(Protobuf.Config.ConfigSchema, {
        payloadVariant: {
          case: "position",
          value: {
            positionBroadcastSecs: 600,
            positionBroadcastSmartEnabled: true,
            positionFlags: 3
          }
        }
      })
    ]
  ]);
  const telemetry = fromBinary(
    Protobuf.ModuleConfig.ModuleConfig_TelemetryConfigSchema,
    toBinary(
      Firmware.ModuleConfig_TelemetryConfigSchema,
      create(Firmware.ModuleConfig_TelemetryConfigSchema, {
        deviceTelemetryEnabled: true
      })
    )
  );
  const modules = new Map<string, Protobuf.ModuleConfig.ModuleConfig>([
    ["mqtt", create(Protobuf.ModuleConfig.ModuleConfigSchema, { payloadVariant: { case: "mqtt", value: {} } })],
    [
      "telemetry",
      create(Protobuf.ModuleConfig.ModuleConfigSchema, { payloadVariant: { case: "telemetry", value: telemetry } })
    ]
  ]);
  const channels = new Map(
    [0, 1].map((index) => [
      index,
      create(Protobuf.Channel.ChannelSchema, {
        index,
        role: index === 0 ? Protobuf.Channel.Channel_Role.PRIMARY : Protobuf.Channel.Channel_Role.DISABLED,
        settings: {
          name: "",
          psk: index === 0 ? Uint8Array.of(1) : new Uint8Array(),
          moduleSettings: { positionPrecision: 32 }
        }
      })
    ])
  );
  const events = {
    onMyNodeInfo: event<Protobuf.Mesh.MyNodeInfo>(),
    onConfigPacket: event<Protobuf.Config.Config>(),
    onModuleConfigPacket: event<Protobuf.ModuleConfig.ModuleConfig>(),
    onChannelPacket: event<Protobuf.Channel.Channel>(),
    onDeviceMetadataPacket: event<{ data: Protobuf.Mesh.DeviceMetadata }>(),
    onNodeInfoPacket: event<Protobuf.Mesh.NodeInfo>(),
    onMeshPacket: event<Protobuf.Mesh.MeshPacket>(),
    onQueueStatus: event<Protobuf.Mesh.QueueStatus>(),
    onDeviceStatus: event<Types.DeviceStatusEnum>()
  };
  async function configure() {
    for (const config of configs.values()) events.onConfigPacket.emit(config);
    for (const config of modules.values()) events.onModuleConfigPacket.emit(config);
    for (const channel of channels.values()) events.onChannelPacket.emit(channel);
    events.onDeviceMetadataPacket.emit({
      data: create(Protobuf.Mesh.DeviceMetadataSchema, { firmwareVersion: "2.7.15" })
    });
    events.onDeviceStatus.emit(Types.DeviceStatusEnum.DeviceConfigured);
    return 1;
  }
  return {
    configs,
    modules,
    channels,
    events,
    configure,
    setHeartbeatInterval: vi.fn(),
    disconnect: vi.fn(async () => undefined),
    commitEditSettings: vi.fn(configure),
    setConfig: vi.fn(async (config: Protobuf.Config.Config) => {
      const stored = fromBinary(Protobuf.Config.ConfigSchema, toBinary(Protobuf.Config.ConfigSchema, config));
      if (stored.payloadVariant.case) configs.set(stored.payloadVariant.case, stored);
      return 1;
    }),
    setModuleConfig: vi.fn(async (config: Protobuf.ModuleConfig.ModuleConfig) => {
      const stored = fromBinary(
        Protobuf.ModuleConfig.ModuleConfigSchema,
        toBinary(Protobuf.ModuleConfig.ModuleConfigSchema, config)
      );
      if (stored.payloadVariant.case) modules.set(stored.payloadVariant.case, stored);
      return 1;
    }),
    setChannel: vi.fn(async (channel: Protobuf.Channel.Channel) => {
      if (Buffer.byteLength(channel.settings?.name ?? "", "utf8") > 11)
        throw new Error("firmware channel name exceeds 11 bytes");
      channels.set(
        channel.index,
        fromBinary(Protobuf.Channel.ChannelSchema, toBinary(Protobuf.Channel.ChannelSchema, channel))
      );
      return 1;
    })
  };
}
