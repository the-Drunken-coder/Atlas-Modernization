import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { MeshDevice as MeshDeviceType } from "@meshtastic/core";
import { Protobuf, Types } from "@meshtastic/core";
import { Mesh as FirmwareMesh } from "@meshtastic/protobufs-firmware";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualClock } from "./clock.js";
import { AssetJoinService, PreSharedKeyAuthenticationPolicy } from "./joining.js";
import { type LinkRadio, LinkRadioGate, MeshtasticSerialRadio, type RadioSendOptions } from "./radio.js";

const serial = vi.hoisted(() => ({
  create: vi.fn()
}));
const sdk = vi.hoisted(() => ({
  device: undefined as MeshDeviceType | undefined
}));

vi.mock("./serial.js", () => ({
  openSerialTransport: serial.create
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

  it("forwards per-send payload budgets through the transmission gate", async () => {
    const raw: LinkRadio = {
      max_payload_bytes: 231,
      maxPayloadBytes: vi.fn((_options: RadioSendOptions) => 219),
      send: vi.fn(async (_payload: Uint8Array, _options: RadioSendOptions) => undefined),
      onPacket: (_handler) => () => undefined,
      close: async () => undefined
    };
    const gate = new LinkRadioGate(raw);

    expect(gate.maxPayloadBytes({ channel: 1, require_public_key: true })).toBe(219);
    expect(raw.maxPayloadBytes).toHaveBeenCalledWith({ channel: 1, require_public_key: true });
    await gate.close();
  });

  it("receives real SDK protobuf oneof packets through the Link adapter", async () => {
    const { radio, connection } = await openRadio();
    const received = vi.fn();
    radio.onPacket(received);
    try {
      connection.enqueueMeshPacket(
        create(Protobuf.Mesh.MeshPacketSchema, {
          from: 123,
          id: 77,
          to: 0xffffffff,
          channel: 1,
          pkiEncrypted: false,
          payloadVariant: {
            case: "decoded",
            value: { portnum: Protobuf.Portnums.PortNum.PRIVATE_APP, payload: Uint8Array.of(1, 2, 3) }
          }
        })
      );
      await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({
          radio_source: 123,
          radio_packet_id: 77,
          channel: 1,
          payload: Uint8Array.of(1, 2, 3)
        })
      );
    } finally {
      await radio.close();
    }
  });

  it("omits radio packet metadata when the native packet ID is zero", async () => {
    const { radio, connection } = await openRadio();
    const received = vi.fn();
    radio.onPacket(received);
    try {
      connection.enqueueMeshPacket(
        create(Protobuf.Mesh.MeshPacketSchema, {
          from: 123,
          to: 0xffffffff,
          channel: 1,
          payloadVariant: {
            case: "decoded",
            value: { portnum: Protobuf.Portnums.PortNum.PRIVATE_APP, payload: Uint8Array.of(1) }
          }
        })
      );
      await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
      expect(received.mock.calls[0]?.[0]).not.toHaveProperty("radio_packet_id");
    } finally {
      await radio.close();
    }
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
      expect(message.payloadVariant.value.hopLimit).toBe(3);
      expect(message.payloadVariant.value.payloadVariant.case).toBe("decoded");
      if (message.payloadVariant.value.payloadVariant.case !== "decoded") throw new Error("expected decoded payload");
      expect(message.payloadVariant.value.payloadVariant.value.portnum).toBe(Protobuf.Portnums.PortNum.PRIVATE_APP);
      expect(message.payloadVariant.value.payloadVariant.value.payload).toEqual(Uint8Array.of(1, 2, 3));
      await expect(sending).resolves.toBeUndefined();
    } finally {
      await radio.close();
    }
  });

  it("maps a native request ID while leaving native reliability disabled", async () => {
    const { radio, connection } = await openRadio();
    try {
      await radio.send(Uint8Array.of(4, 5, 6), { channel: 1, request_id: 0x01020304 });
      const packet = connection.writes.map(decodeToRadio).find((message) => message.payloadVariant.case === "packet");
      if (packet?.payloadVariant.case !== "packet") throw new Error("Missing packet");
      expect(packet.payloadVariant.value.wantAck).toBe(false);
      expect(packet.payloadVariant.value.payloadVariant.case).toBe("decoded");
      if (packet.payloadVariant.value.payloadVariant.case !== "decoded") throw new Error("Missing decoded data");
      expect(packet.payloadVariant.value.payloadVariant.value.wantResponse).toBe(false);
      expect(packet.payloadVariant.value.payloadVariant.value.requestId).toBe(0x01020304);
    } finally {
      await radio.close();
    }
  });

  it("calculates the native payload budget for plain, request, and PKI sends", async () => {
    const { radio } = await openRadio();
    try {
      expect(radio.max_payload_bytes).toBe(231);
      expect(radio.maxPayloadBytes?.({ channel: 1 })).toBe(231);
      expect(radio.maxPayloadBytes?.({ channel: 1, request_id: 1 })).toBe(226);
      expect(radio.maxPayloadBytes?.({ channel: 1, require_public_key: true })).toBe(219);
      expect(radio.maxPayloadBytes?.({ channel: 1, destination_radio_node: 123 })).toBe(219);
      expect(radio.maxPayloadBytes?.({ channel: 1, require_public_key: true, request_id: 1 })).toBe(214);
    } finally {
      await radio.close();
    }
  });

  it.each([
    [232, { channel: 1 }, 231],
    [227, { channel: 1, request_id: 1 }, 226],
    [220, { channel: 1, require_public_key: true }, 219],
    [215, { channel: 1, require_public_key: true, request_id: 1 }, 214]
  ] as const)("rejects a payload above the native %s-byte budget", async (payloadLength, options, budget) => {
    const { radio, connection } = await openRadio();
    const writesBeforeSend = connection.writes.length;
    try {
      await expect(radio.send(new Uint8Array(payloadLength), options)).rejects.toThrow(`exceeds ${budget} bytes`);
      expect(connection.writes).toHaveLength(writesBeforeSend);
    } finally {
      await radio.close();
    }
  });

  it.each([0, -1, 1.5, 0x1_0000_0000, Number.NaN])("rejects invalid native request ID %s", async (requestID) => {
    const { radio } = await openRadio();
    try {
      await expect(radio.send(Uint8Array.of(1), { channel: 1, request_id: requestID })).rejects.toThrow(
        "nonzero uint32"
      );
    } finally {
      await radio.close();
    }
  });

  it("reserves the firmware bitfield, header, PKI, and request ID bytes", () => {
    const encodedDataBytes = (payloadLength: number, requestID?: number): number =>
      toBinary(
        FirmwareMesh.DataSchema,
        create(FirmwareMesh.DataSchema, {
          portnum: 256,
          payload: new Uint8Array(payloadLength),
          bitfield: 0,
          ...(requestID === undefined ? {} : { requestId: requestID })
        })
      ).byteLength;
    const rfBytes = (payloadLength: number, requestID?: number, pki = false): number =>
      encodedDataBytes(payloadLength, requestID) + 16 + (pki ? 12 : 0);

    expect(encodedDataBytes(231)).toBe(239);
    expect(rfBytes(231)).toBe(255);
    expect(rfBytes(232)).toBe(256);
    expect(encodedDataBytes(226, 1)).toBe(239);
    expect(rfBytes(226, 1)).toBe(255);
    expect(rfBytes(227, 1)).toBe(256);
    expect(rfBytes(219, undefined, true)).toBe(255);
    expect(rfBytes(220, undefined, true)).toBe(256);
    expect(rfBytes(214, 1, true)).toBe(255);
    expect(rfBytes(215, 1, true)).toBe(256);
  });

  it.each([
    ["safety", Protobuf.Mesh.MeshPacket_Priority.ACK],
    ["task", Protobuf.Mesh.MeshPacket_Priority.HIGH],
    ["request", Protobuf.Mesh.MeshPacket_Priority.RELIABLE],
    ["live_state", Protobuf.Mesh.MeshPacket_Priority.DEFAULT],
    ["resource", Protobuf.Mesh.MeshPacket_Priority.BACKGROUND],
    ["object_content", Protobuf.Mesh.MeshPacket_Priority.BACKGROUND]
  ] as const)("preserves %s scheduling in the firmware queue", async (priority, expected) => {
    const { radio, connection } = await openRadio();
    try {
      await radio.send(Uint8Array.of(1), { channel: 1, priority });
      const packet = connection.writes.map(decodeToRadio).find((message) => message.payloadVariant.case === "packet");
      if (packet?.payloadVariant.case !== "packet") throw new Error("Missing packet");
      expect(packet.payloadVariant.value.priority).toBe(expected);
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

  it("records matched admissions and rejections separately from unmatched statuses", async () => {
    const { radio, connection } = await openRadio();
    connection.setAutomaticQueueStatus(false);
    const sending = radio.send(Uint8Array.of(6), { channel: 1 }).catch((error: unknown) => error);
    try {
      await waitForWrites(connection.writes, 2);
      const message = decodeToRadio(connection.writes[1]);
      if (message.payloadVariant.case !== "packet") throw new Error("expected packet");
      const id = message.payloadVariant.value.id;
      const unmatchedID = id === 0xffffffff ? id - 1 : id + 1;

      connection.enqueueQueueStatus(unmatchedID, 0, 12, 16);
      connection.enqueueQueueStatus(id, 0, 11, 16);
      await expect(sending).resolves.toBeUndefined();

      expect(radio.queueMetrics()).toEqual({
        statuses_observed: 2,
        matched_local_admissions: 1,
        matched_local_rejections: 0,
        minimum_free: 11,
        latest_free: 11,
        latest_maxlen: 16,
        full_queue_observations: 0,
        zero_id_capacity_notifications: 0
      });
    } finally {
      await radio.close();
    }
  });

  it("records valid zero-ID capacity notifications and ignores unavailable capacity", async () => {
    const { radio, connection } = await openRadio();
    try {
      connection.enqueueQueueStatus(0, 0, 4, 16);
      connection.enqueueQueueStatus(0, 0, 0, 16);
      connection.enqueueQueueStatus(0, 0, 0, 0);
      connection.enqueueQueueStatus(0, 0, 17, 16);
      await vi.waitFor(() => expect(radio.queueMetrics().statuses_observed).toBe(4));

      expect(radio.queueMetrics()).toEqual({
        statuses_observed: 4,
        matched_local_admissions: 0,
        matched_local_rejections: 0,
        minimum_free: 0,
        latest_free: 0,
        latest_maxlen: 16,
        full_queue_observations: 1,
        zero_id_capacity_notifications: 2
      });
    } finally {
      await radio.close();
    }
  });

  it("returns queue metric snapshots that cannot mutate the radio counters", async () => {
    const { radio, connection } = await openRadio();
    try {
      connection.enqueueQueueStatus(0, 0, 8, 16);
      await vi.waitFor(() => expect(radio.queueMetrics().statuses_observed).toBe(1));
      const snapshot = radio.queueMetrics();
      snapshot.statuses_observed = 99;
      snapshot.minimum_free = 0;

      expect(radio.queueMetrics()).toMatchObject({ statuses_observed: 1, minimum_free: 8 });
    } finally {
      await radio.close();
    }
  });

  it("records a matched queue-full rejection without treating it as RF completion", async () => {
    const { radio, connection } = await openRadio();
    connection.setAutomaticQueueStatus(false);
    const sending = radio.send(Uint8Array.of(7), { channel: 1 }).catch((error: unknown) => error);
    try {
      await waitForWrites(connection.writes, 2);
      const message = decodeToRadio(connection.writes[1]);
      if (message.payloadVariant.case !== "packet") throw new Error("expected packet");
      connection.enqueueQueueStatus(message.payloadVariant.value.id, 32, 0, 16);
      await expect(sending).resolves.toEqual(
        expect.objectContaining({ message: expect.stringContaining("rejected packet") })
      );

      expect(radio.queueMetrics()).toMatchObject({
        statuses_observed: 1,
        matched_local_admissions: 0,
        matched_local_rejections: 1,
        minimum_free: 0,
        latest_free: 0,
        latest_maxlen: 16,
        full_queue_observations: 1,
        zero_id_capacity_notifications: 0
      });
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
                payloadVariant: {
                  case: "config",
                  value: {
                    payloadVariant: { case: "lora", value: { hopLimit: 3 } }
                  }
                }
              })
            )
          });
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
    enqueueMeshPacket(packet: Protobuf.Mesh.MeshPacket) {
      enqueue({
        type: "packet",
        data: toBinary(
          Protobuf.Mesh.FromRadioSchema,
          create(Protobuf.Mesh.FromRadioSchema, { payloadVariant: { case: "packet", value: packet } })
        )
      });
    },
    enqueueQueueStatus(meshPacketId: number, res: number, free = 15, maxlen = 16) {
      enqueue({
        type: "packet",
        data: toBinary(
          Protobuf.Mesh.FromRadioSchema,
          create(Protobuf.Mesh.FromRadioSchema, {
            payloadVariant: { case: "queueStatus", value: { res, free, maxlen, meshPacketId } }
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
