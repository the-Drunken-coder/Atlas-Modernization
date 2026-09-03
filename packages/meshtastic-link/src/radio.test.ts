import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configurationError: new Error("configuration failed"),
  disconnect: vi.fn(async () => undefined)
}));

vi.mock("@meshtastic/transport-node-serial", () => ({
  TransportNodeSerial: { create: vi.fn(async () => ({})) }
}));

vi.mock("@meshtastic/core", () => {
  const event = { subscribe: vi.fn(), unsubscribe: vi.fn() };
  return {
    MeshDevice: class {
      readonly events = {
        onMyNodeInfo: event,
        onConfigPacket: event,
        onModuleConfigPacket: event,
        onChannelPacket: event,
        onDeviceMetadataPacket: event,
        onNodeInfoPacket: event,
        onMeshPacket: event,
        onDeviceStatus: event
      };

      setHeartbeatInterval(): void {}

      async configure(): Promise<never> {
        throw mocks.configurationError;
      }

      disconnect = mocks.disconnect;
    },
    Protobuf: {},
    Types: {}
  };
});

describe("Meshtastic serial radio", () => {
  it("disconnects the device when initial configuration fails", async () => {
    const { MeshtasticSerialRadio } = await import("./radio.js");

    await expect(MeshtasticSerialRadio.open("/dev/cu.test")).rejects.toBe(mocks.configurationError);
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });
});
