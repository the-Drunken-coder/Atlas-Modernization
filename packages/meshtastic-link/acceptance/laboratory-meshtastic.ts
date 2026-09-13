import { create, type DescMessage, fromBinary, type MessageShape, toBinary } from "@bufbuild/protobuf";
import { Protobuf, Types } from "@meshtastic/core";
import { ModuleConfig as Firmware } from "@meshtastic/protobufs-firmware";

export type LaboratoryControllerMessage =
  | { type: "lab:peer"; nodeNumber: number; publicKeyBase64: string }
  | { type: "lab:radio"; packetBase64: string };

export type LaboratoryProcessMessage =
  | { type: "lab:register"; nodeNumber: number; publicKeyBase64: string }
  | { type: "lab:radio"; from: number; to: number; channel: number; packetBase64: string };

export type LaboratoryDeviceSummary = {
  node_id: string;
  node_number: number;
  connections_opened: number;
  connections_closed: number;
  active_connections: number;
  configure_requests: number;
  configuration_commits: number;
  configuration_writes: number;
  queue_statuses: number;
  radio_packets_sent: number;
  radio_packets_received: number;
  pending_writes: number;
};

type Connection = {
  readonly controller: ReadableStreamDefaultController<Types.DeviceOutput>;
  closed: boolean;
};

/** A single test-owned Meshtastic device, limited to the protocol exercised by Link startup and traffic. */
export class LaboratoryMeshtasticDevice {
  private readonly configs = initialConfigs();
  private readonly modules = initialModules();
  private readonly channels = initialChannels();
  private readonly peers = new Map<number, Uint8Array>();
  private readonly publicKey: Uint8Array;
  private connection: Connection | undefined;
  private nextMessageID = 1;
  private connectionsOpened = 0;
  private connectionsClosed = 0;
  private configureRequests = 0;
  private configurationCommits = 0;
  private configurationWrites = 0;
  private queueStatuses = 0;
  private radioPacketsSent = 0;
  private radioPacketsReceived = 0;
  private pendingWrites = 0;

  constructor(
    private readonly nodeID: string,
    private readonly nodeNumber: number,
    private readonly sendToController: (message: LaboratoryProcessMessage) => void
  ) {
    this.publicKey = Uint8Array.from({ length: 32 }, (_, index) => (nodeNumber + index) & 0xff);
  }

  async openTransport(): Promise<Types.Transport> {
    let connection: Connection | undefined;
    const fromDevice = new ReadableStream<Types.DeviceOutput>({
      start: (controller) => {
        connection = { controller, closed: false };
        this.connection = connection;
        this.connectionsOpened++;
      }
    });
    if (!connection) throw new Error("laboratory transport did not create its input stream");
    const activeConnection = connection;
    const toDevice = new WritableStream<Uint8Array>({
      write: async (bytes) => {
        this.pendingWrites++;
        try {
          await this.receiveFromClient(activeConnection, bytes);
        } finally {
          this.pendingWrites--;
        }
      },
      close: () => this.closeConnection(activeConnection),
      abort: () => this.closeConnection(activeConnection)
    });
    this.sendToController({
      type: "lab:register",
      nodeNumber: this.nodeNumber,
      publicKeyBase64: Buffer.from(this.publicKey).toString("base64")
    });
    return {
      fromDevice,
      toDevice,
      disconnect: async () => this.closeConnection(activeConnection)
    };
  }

  handleControllerMessage(message: LaboratoryControllerMessage): void {
    if (message.type === "lab:peer") {
      const publicKey = Uint8Array.from(Buffer.from(message.publicKeyBase64, "base64"));
      this.peers.set(message.nodeNumber, publicKey);
      if (this.connection) this.sendPeer(this.connection, message.nodeNumber, publicKey);
      return;
    }
    const packet = fromBinary(Protobuf.Mesh.MeshPacketSchema, Buffer.from(message.packetBase64, "base64"));
    if (!this.connection) return;
    this.radioPacketsReceived++;
    this.sendFromRadio(this.connection, { case: "packet", value: packet });
  }

  async close(): Promise<void> {
    if (this.connection) this.closeConnection(this.connection);
  }

  summary(): LaboratoryDeviceSummary {
    return {
      node_id: this.nodeID,
      node_number: this.nodeNumber,
      connections_opened: this.connectionsOpened,
      connections_closed: this.connectionsClosed,
      active_connections: this.connectionsOpened - this.connectionsClosed,
      configure_requests: this.configureRequests,
      configuration_commits: this.configurationCommits,
      configuration_writes: this.configurationWrites,
      queue_statuses: this.queueStatuses,
      radio_packets_sent: this.radioPacketsSent,
      radio_packets_received: this.radioPacketsReceived,
      pending_writes: this.pendingWrites
    };
  }

  private async receiveFromClient(connection: Connection, bytes: Uint8Array): Promise<void> {
    if (connection.closed) throw new Error("laboratory transport is closed");
    const message = fromBinary(Protobuf.Mesh.ToRadioSchema, bytes);
    if (message.payloadVariant.case === "wantConfigId") {
      this.configureRequests++;
      this.sendConfiguration(connection, message.payloadVariant.value);
      return;
    }
    if (message.payloadVariant.case === "heartbeat") return;
    if (message.payloadVariant.case !== "packet") return;
    const packet = message.payloadVariant.value;
    if (packet.payloadVariant.case !== "decoded") return;
    if (packet.payloadVariant.value.portnum === Protobuf.Portnums.PortNum.ADMIN_APP) {
      const admin = fromBinary(Protobuf.Admin.AdminMessageSchema, packet.payloadVariant.value.payload);
      this.applyAdminMessage(admin);
      this.sendRoutingAcknowledgement(connection, packet.id);
      if (admin.payloadVariant.case === "commitEditSettings") queueMicrotask(() => this.reboot(connection));
      return;
    }
    if (packet.payloadVariant.value.portnum !== Protobuf.Portnums.PortNum.PRIVATE_APP) return;
    this.queueStatuses++;
    this.sendFromRadio(connection, {
      case: "queueStatus",
      value: create(Protobuf.Mesh.QueueStatusSchema, { meshPacketId: packet.id, free: 8, maxlen: 8, res: 0 })
    });
    this.radioPacketsSent++;
    const transmitted = create(Protobuf.Mesh.MeshPacketSchema, {
      ...packet,
      pkiEncrypted: packet.to !== 0xffffffff
    });
    this.sendToController({
      type: "lab:radio",
      from: this.nodeNumber,
      to: packet.to,
      channel: packet.channel,
      packetBase64: Buffer.from(toBinary(Protobuf.Mesh.MeshPacketSchema, transmitted)).toString("base64")
    });
  }

  private sendConfiguration(connection: Connection, configID: number): void {
    this.sendFromRadio(connection, {
      case: "myInfo",
      value: create(Protobuf.Mesh.MyNodeInfoSchema, { myNodeNum: this.nodeNumber })
    });
    for (const config of this.configs.values()) this.sendFromRadio(connection, { case: "config", value: config });
    for (const module of this.modules.values()) {
      this.sendFromRadio(connection, { case: "moduleConfig", value: module });
    }
    for (const channel of this.channels.values()) this.sendFromRadio(connection, { case: "channel", value: channel });
    this.sendFromRadio(connection, {
      case: "metadata",
      value: create(Protobuf.Mesh.DeviceMetadataSchema, { firmwareVersion: "2.7.15" })
    });
    for (const [nodeNumber, publicKey] of this.peers) this.sendPeer(connection, nodeNumber, publicKey);
    this.sendFromRadio(connection, { case: "configCompleteId", value: configID });
  }

  private applyAdminMessage(message: Protobuf.Admin.AdminMessage): void {
    switch (message.payloadVariant.case) {
      case "setConfig": {
        const config = clone(Protobuf.Config.ConfigSchema, message.payloadVariant.value);
        if (config.payloadVariant.case) this.configs.set(config.payloadVariant.case, config);
        this.configurationWrites++;
        break;
      }
      case "setModuleConfig": {
        const module = clone(Protobuf.ModuleConfig.ModuleConfigSchema, message.payloadVariant.value);
        if (module.payloadVariant.case) this.modules.set(module.payloadVariant.case, module);
        this.configurationWrites++;
        break;
      }
      case "setChannel":
        this.channels.set(
          message.payloadVariant.value.index,
          clone(Protobuf.Channel.ChannelSchema, message.payloadVariant.value)
        );
        this.configurationWrites++;
        break;
      case "commitEditSettings":
        this.configurationCommits++;
        break;
      default:
        break;
    }
  }

  private sendRoutingAcknowledgement(connection: Connection, requestID: number): void {
    const routing = create(Protobuf.Mesh.RoutingSchema, {
      variant: { case: "errorReason", value: Protobuf.Mesh.Routing_Error.NONE }
    });
    const packet = create(Protobuf.Mesh.MeshPacketSchema, {
      from: this.nodeNumber,
      to: this.nodeNumber,
      id: this.nextMessageID++,
      payloadVariant: {
        case: "decoded",
        value: {
          portnum: Protobuf.Portnums.PortNum.ROUTING_APP,
          requestId: requestID,
          payload: toBinary(Protobuf.Mesh.RoutingSchema, routing)
        }
      }
    });
    this.sendFromRadio(connection, { case: "packet", value: packet });
  }

  private sendPeer(connection: Connection, nodeNumber: number, publicKey: Uint8Array): void {
    this.sendFromRadio(connection, {
      case: "nodeInfo",
      value: create(Protobuf.Mesh.NodeInfoSchema, {
        num: nodeNumber,
        user: { id: `!${nodeNumber.toString(16)}`, publicKey }
      })
    });
  }

  private sendFromRadio(connection: Connection, payloadVariant: Protobuf.Mesh.FromRadio["payloadVariant"]): void {
    if (connection.closed) return;
    const message = create(Protobuf.Mesh.FromRadioSchema, { id: this.nextMessageID++, payloadVariant });
    connection.controller.enqueue({ type: "packet", data: toBinary(Protobuf.Mesh.FromRadioSchema, message) });
  }

  private reboot(connection: Connection): void {
    if (connection.closed) return;
    connection.controller.enqueue({
      type: "status",
      data: { status: Types.DeviceStatusEnum.DeviceDisconnected, reason: "laboratory configuration reboot" }
    });
    this.closeConnection(connection);
  }

  private closeConnection(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.connectionsClosed++;
    if (this.connection === connection) this.connection = undefined;
    try {
      connection.controller.close();
    } catch {
      // The client may already have cancelled its readable side.
    }
  }
}

function initialConfigs(): Map<string, Protobuf.Config.Config> {
  return new Map([
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
    ["position", create(Protobuf.Config.ConfigSchema, { payloadVariant: { case: "position", value: {} } })]
  ]);
}

function initialModules(): Map<string, Protobuf.ModuleConfig.ModuleConfig> {
  const telemetry = fromBinary(
    Protobuf.ModuleConfig.ModuleConfig_TelemetryConfigSchema,
    toBinary(
      Firmware.ModuleConfig_TelemetryConfigSchema,
      create(Firmware.ModuleConfig_TelemetryConfigSchema, { deviceTelemetryEnabled: true })
    )
  );
  return new Map([
    ["mqtt", create(Protobuf.ModuleConfig.ModuleConfigSchema, { payloadVariant: { case: "mqtt", value: {} } })],
    [
      "telemetry",
      create(Protobuf.ModuleConfig.ModuleConfigSchema, { payloadVariant: { case: "telemetry", value: telemetry } })
    ]
  ]);
}

function initialChannels(): Map<number, Protobuf.Channel.Channel> {
  return new Map(
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
}

function clone<Descriptor extends DescMessage>(
  schema: Descriptor,
  value: MessageShape<Descriptor>
): MessageShape<Descriptor> {
  return fromBinary(schema, toBinary(schema, value));
}
