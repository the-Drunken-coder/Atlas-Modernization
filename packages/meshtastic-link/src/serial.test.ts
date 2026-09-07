import { SerialPortMock } from "serialport";
import { describe, expect, it, vi } from "vitest";
import { openSerialTransport } from "./serial.js";

const observed = vi.hoisted(() => ({ port: undefined as SerialPortMock | undefined }));
vi.mock("serialport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("serialport")>();
  class TestPort extends actual.SerialPortMock {
    constructor(options: ConstructorParameters<typeof actual.SerialPortMock>[0]) {
      super(options);
      observed.port = this;
    }
  }
  return { ...actual, SerialPort: TestPort };
});

describe("serial transport", () => {
  it("frames binary writes, receives split binary packets, and closes idempotently", async () => {
    SerialPortMock.binding.createPort("/dev/cu.atlas-test", { record: true });
    const transport = await openSerialTransport("/dev/cu.atlas-test");
    const reader = transport.fromDevice.getReader();
    expect((await reader.read()).value?.type).toBe("status");
    const writer = transport.toDevice.getWriter();
    await writer.write(Uint8Array.of(0x94, 0xc3, 1));
    expect(observed.port?.port?.recording).toEqual(Buffer.from([0x94, 0xc3, 0, 3, 0x94, 0xc3, 1]));
    observed.port?.port?.emitData(Buffer.from([0x62, 0x6f, 0x6f, 0x74, 0x94]));
    observed.port?.port?.emitData(Buffer.from([0xc3, 0, 3, 0x94, 0xc3, 1]));
    expect((await reader.read()).value).toEqual({ type: "packet", data: Uint8Array.of(0x94, 0xc3, 1) });
    await transport.disconnect();
    await transport.disconnect();
    expect(observed.port?.isOpen).toBe(false);
    expect((await reader.read()).value?.type).toBe("status");
    expect((await reader.read()).done).toBe(true);
    await expect(writer.write(Uint8Array.of(1))).rejects.toThrow("closed");
    writer.releaseLock();
    reader.releaseLock();
  });

  it("cancels a pending read before disconnecting", async () => {
    SerialPortMock.binding.createPort("/dev/cu.atlas-cancel", { record: true });
    const transport = await openSerialTransport("/dev/cu.atlas-cancel");
    const reader = transport.fromDevice.getReader();
    await reader.read();
    const pending = reader.read();
    await reader.cancel();
    expect((await pending).done).toBe(true);
    reader.releaseLock();
    await transport.disconnect();
    expect(observed.port?.isOpen).toBe(false);
  });

  it("rejects opening a missing device", async () => {
    await expect(openSerialTransport("/dev/cu.missing")).rejects.toThrow();
  });
});
