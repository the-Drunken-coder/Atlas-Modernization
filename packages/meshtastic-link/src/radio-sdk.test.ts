import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { MeshDevice as MeshDeviceType } from "@meshtastic/core";
import { Protobuf, Types } from "@meshtastic/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualClock } from "./clock.js";
import { AssetJoinService, PreSharedKeyAuthenticationPolicy } from "./joining.js";
import { MeshtasticSerialRadio } from "./radio.js";

const serial = vi.hoisted(() => ({
  create: vi.fn()
}));
const sdk = vi.hoisted(() => ({
  device: undefined as MeshDeviceType | undefined
}));

vi.mock("@meshtastic/transport-node-serial", () => ({
  TransportNodeSerial: { create: serial.create }
}));

vi.mock("@meshtastic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meshtastic/core")>();
  class ObservedMeshDevice extends actual.MeshDevice {
    constructor(...args: ConstructorParameters<typeof actual.MeshDevice>) {
      super(...args);
      sdk.device = this;
    }
  }
  return { ...actual, MeshDevice: ObservedMeshDevice };
});

describe("Meshtastic radio SDK adapter", () => {
  beforeEach(() => {
    serial.create.mockReset();
    sdk.device = undefined;
  });

  it("completes application sends from the firmware QueueStatus response", async () => {
    const { radio, connection } = await openRadio();
    try {
      const sending = radio.send(Uint8Array.of(1, 2, 3), { channel: 1 });
      await waitForWrites(connection.writes, 2);
      const message = connection.writes
        .map(decodeToRadio)
        .find(({ payloadVariant }) => payloadVariant.case === "packet");
      if (!message || message.payloadVariant.case !== "packet") throw new Error("expected application packet");
      expect(message.payloadVariant.value.wantAck).toBe(false);
      expect(message.payloadVariant.value.payloadVariant.case).toBe("decoded");
      if (message.payloadVariant.value.payloadVariant.case !== "decoded") throw new Error("expected decoded payload");
      expect(message.payloadVariant.value.payloadVariant.value.portnum).toBe(Protobuf.Portnums.PortNum.PRIVATE_APP);
      expect(message.payloadVariant.value.payloadVariant.value.payload).toEqual(Uint8Array.of(1, 2, 3));
      await expect(sending).resolves.toBeUndefined();
    } finally {
      await radio.close();
    }
  });

  it("serializes an application send behind an SDK packet write", async () => {
    const { radio, connection } = await openRadio();
    const device = sdk.device;
    if (!device) throw new Error("SDK device was not captured");
    connection.blockNextWrite();
    try {
      const heartbeat = device.heartbeat().catch(() => undefined);
      await waitForWrites(connection.writes, 2);
      const sending = radio.send(Uint8Array.of(9), { channel: 0 });
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      expect(connection.writes).toHaveLength(2);
      connection.releaseBlockedWrite();
      await waitForWrites(connection.writes, 3);
      const packets = connection.writes.map(decodeToRadio);
      expect(packets[1]?.payloadVariant.case).toBe("heartbeat");
      const applicationPacket = packets.find(({ payloadVariant }) => payloadVariant.case === "packet");
      if (!applicationPacket || applicationPacket.payloadVariant.case !== "packet")
        throw new Error("expected application packet");
      await expect(sending).resolves.toBeUndefined();
      for (const item of device.queue.getState()) device.queue.processAck(item.id);
      await heartbeat;
    } finally {
      connection.releaseBlockedWrite();
      await radio.close();
    }
  });

  it("rejects an active join and lets close finish after disconnect", async () => {
    const { radio, connection } = await openRadio();
    connection.setAutomaticQueueStatus(false);
    const join = new AssetJoinService({
      radio,
      clock: new VirtualClock(),
      assetID: "asset-alpha",
      radioNodeID: 101,
      serviceSession: "session-alpha",
      authentication: new PreSharedKeyAuthenticationPolicy("a".repeat(32)),
      installMembership: async () => undefined
    });
    try {
      join.start();
      await waitForWrites(connection.writes, 2);
      connection.enqueueDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
      await expect(join.close()).resolves.toBeUndefined();
      expect(join.status().state).toBe("stopped");
    } finally {
      await radio.close();
    }
  });

  it("ignores unrelated QueueStatus and rejects local device refusal", async () => {
    const { radio, connection } = await openRadio();
    connection.setAutomaticQueueStatus(false);
    let completed = false;
    const sending = radio.send(Uint8Array.of(5), { channel: 1 });
    const result = sending.then(
      () => {
        completed = true;
      },
      (error: unknown) => {
        completed = true;
        return error;
      }
    );
    try {
      await waitForWrites(connection.writes, 2);
      const message = decodeToRadio(connection.writes[1]);
      if (message.payloadVariant.case !== "packet") throw new Error("expected packet");
      const id = message.payloadVariant.value.id;
      connection.enqueueQueueStatus(id === 1 ? 2 : 1, 0);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      expect(completed).toBe(false);
      connection.enqueueQueueStatus(id, 1);
      expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining("rejected packet") }));
    } finally {
      await radio.close();
    }
  });

  it("expires queued sends without writing their bytes after the deadline", async () => {
    const { radio, connection } = await openRadio();
    connection.blockNextWrite();
    const first = radio.send(Uint8Array.of(1), { channel: 1 }).catch((error: unknown) => error);
    await waitForWrites(connection.writes, 2);
    vi.useFakeTimers();
    const queued = radio.send(Uint8Array.of(2), { channel: 1 }).catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await queued).toEqual(expect.objectContaining({ message: expect.stringContaining("did not accept") }));
      connection.releaseBlockedWrite();
      await vi.advanceTimersByTimeAsync(0);
      expect(connection.writes).toHaveLength(2);
      await radio.close();
      expect(await first).toEqual(expect.objectContaining({ message: expect.stringContaining("closed") }));
    } finally {
      connection.releaseBlockedWrite();
      await radio.close();
      vi.useRealTimers();
    }
  });

  it("closes when the SDK writer is still blocked", async () => {
    const { radio, connection } = await openRadio();
    const device = sdk.device;
    if (!device) throw new Error("SDK device was not captured");
    connection.blockNextWrite();
    void device.heartbeat().catch(() => undefined);
    try {
      await waitForWrites(connection.writes, 2);
      await expect(radio.close()).resolves.toBeUndefined();
    } finally {
      connection.releaseBlockedWrite();
    }
  });
});

async function openRadio() {
  const connection = openedTransport();
  serial.create.mockResolvedValue(connection);
  const radio = await MeshtasticSerialRadio.open("/dev/cu.test");
  return { radio, connection };
}

function openedTransport() {
  let controller: ReadableStreamDefaultController<Types.DeviceOutput> | undefined;
  let blockedWriteResolve: (() => void) | undefined;
  let blockNextWrite = false;
  let automaticQueueStatus = true;
  const writes: Uint8Array[] = [];
  const enqueue = (output: Types.DeviceOutput): void => controller?.enqueue(output);
  return {
    fromDevice: new ReadableStream<Types.DeviceOutput>({
      start: (streamController) => {
        controller = streamController;
      }
    }),
    writes,
    toDevice: new WritableStream<Uint8Array>({
      write: (chunk) => {
        writes.push(chunk);
        const decoded = decodeToRadio(chunk);
        if (blockNextWrite) {
          blockNextWrite = false;
          return new Promise<void>((resolve) => {
            blockedWriteResolve = resolve;
          });
        }
        if (decoded.payloadVariant.case === "wantConfigId") {
          enqueue({
            type: "packet",
            data: toBinary(
              Protobuf.Mesh.FromRadioSchema,
              create(Protobuf.Mesh.FromRadioSchema, {
                payloadVariant: { case: "configCompleteId", value: decoded.payloadVariant.value }
              })
            )
          });
        } else if (decoded.payloadVariant.case === "packet" && automaticQueueStatus) {
          enqueue({
            type: "packet",
            data: toBinary(
              Protobuf.Mesh.FromRadioSchema,
              create(Protobuf.Mesh.FromRadioSchema, {
                payloadVariant: {
                  case: "queueStatus",
                  value: { res: 0, free: 15, maxlen: 16, meshPacketId: decoded.payloadVariant.value.id }
                }
              })
            )
          });
        }
        return undefined;
      }
    }),
    disconnect: async () => {
      controller?.close();
      controller = undefined;
    },
    setAutomaticQueueStatus(enabled: boolean) {
      automaticQueueStatus = enabled;
    },
    enqueueQueueStatus(meshPacketId: number, res: number) {
      enqueue({
        type: "packet",
        data: toBinary(
          Protobuf.Mesh.FromRadioSchema,
          create(Protobuf.Mesh.FromRadioSchema, {
            payloadVariant: { case: "queueStatus", value: { res, free: 15, maxlen: 16, meshPacketId } }
          })
        )
      });
    },
    blockNextWrite() {
      blockNextWrite = true;
    },
    releaseBlockedWrite() {
      blockedWriteResolve?.();
      blockedWriteResolve = undefined;
    },
    enqueueDeviceStatus(status: Types.DeviceStatusEnum) {
      enqueue({ type: "status", data: { status } });
    }
  };
}

function decodeToRadio(bytes: Uint8Array | undefined): Protobuf.Mesh.ToRadio {
  if (!bytes) throw new Error("expected a serial write");
  return fromBinary(Protobuf.Mesh.ToRadioSchema, bytes);
}

async function waitForWrites(writes: readonly Uint8Array[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 500 && writes.length < count; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  expect(writes).toHaveLength(count);
}
