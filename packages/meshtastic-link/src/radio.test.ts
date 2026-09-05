import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeDispatcher {
    private readonly handlers = new Set<(value: unknown) => void>();

    subscribe(handler: (value: unknown) => void): void {
      this.handlers.add(handler);
    }

    unsubscribe(handler: (value: unknown) => void): void {
      this.handlers.delete(handler);
    }

    dispatch(value: unknown): void {
      for (const handler of [...this.handlers]) handler(value);
    }
  }

  const state = {
    configurationError: undefined as Error | undefined,
    rebootOnCommit: false,
    devices: [] as FakeMeshDevice[]
  };

  class FakeMeshDevice {
    readonly events = {
      onMyNodeInfo: new FakeDispatcher(),
      onConfigPacket: new FakeDispatcher(),
      onModuleConfigPacket: new FakeDispatcher(),
      onChannelPacket: new FakeDispatcher(),
      onDeviceMetadataPacket: new FakeDispatcher(),
      onNodeInfoPacket: new FakeDispatcher(),
      onMeshPacket: new FakeDispatcher(),
      onQueueStatus: new FakeDispatcher(),
      onDeviceStatus: new FakeDispatcher()
    };
    readonly index = state.devices.length;
    readonly disconnect = vi.fn(async () => undefined);
    readonly clearChannel = vi.fn(async () => 1);
    readonly commitEditSettings = vi.fn(async () => {
      if (state.rebootOnCommit && this.index === 0) this.events.onDeviceStatus.dispatch(2);
      return 1;
    });
    readonly configure = vi.fn(async () => {
      if (state.configurationError) throw state.configurationError;
      this.events.onDeviceStatus.dispatch(7);
      return 1;
    });

    constructor(_transport: unknown) {
      state.devices.push(this);
    }

    setHeartbeatInterval(): void {}
  }

  return {
    state,
    FakeMeshDevice,
    transportCreate: vi.fn(async () => ({
      fromDevice: new ReadableStream(),
      toDevice: new WritableStream(),
      disconnect: vi.fn(async () => undefined)
    }))
  };
});

vi.mock("@meshtastic/transport-node-serial", () => ({
  TransportNodeSerial: { create: mocks.transportCreate }
}));

vi.mock("@meshtastic/core", () => ({
  MeshDevice: mocks.FakeMeshDevice,
  Protobuf: {},
  Types: { DeviceStatusEnum: { DeviceDisconnected: 2, DeviceConfigured: 7 } }
}));

describe("Meshtastic serial radio", () => {
  beforeEach(() => {
    mocks.state.configurationError = undefined;
    mocks.state.rebootOnCommit = false;
    mocks.state.devices.length = 0;
    mocks.transportCreate.mockClear();
  });

  it("disconnects the device when initial configuration fails", async () => {
    const configurationError = new Error("configuration failed");
    mocks.state.configurationError = configurationError;
    const { MeshtasticSerialRadio } = await import("./radio.js");

    await expect(MeshtasticSerialRadio.open("/dev/cu.test")).rejects.toBe(configurationError);
    expect(mocks.state.devices[0]?.disconnect).toHaveBeenCalledOnce();
  });

  it("reopens and reconfigures the serial device after a configuration reboot", async () => {
    const { MeshtasticSerialRadio } = await import("./radio.js");
    const radio = await MeshtasticSerialRadio.open("/dev/cu.test");
    const disconnected = vi.fn();
    radio.onDisconnect(disconnected);
    mocks.state.rebootOnCommit = true;

    await radio.clearPrivateMembership(1);

    expect(mocks.transportCreate).toHaveBeenCalledTimes(2);
    expect(mocks.state.devices).toHaveLength(2);
    expect(mocks.state.devices[1]?.configure).toHaveBeenCalledOnce();
    expect(disconnected).not.toHaveBeenCalled();
    await radio.close();
  });
});
