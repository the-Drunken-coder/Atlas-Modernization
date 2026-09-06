import { once } from "node:events";
import { Readable } from "node:stream";
import { Types } from "@meshtastic/core";
import { SerialPort } from "serialport";
import { deviceFrameStream } from "./device-framing.js";

/** Keep binary payloads opaque and close USB without aborting a Node stream pipeline. */
export async function openSerialTransport(path: string): Promise<Types.Transport> {
  const port = new SerialPort({ path, baudRate: 115_200, autoOpen: false });
  const opened = once(port, "open");
  port.open();
  await opened;
  let closed = false;
  const reader = Readable.toWeb(port).pipeThrough(deviceFrameStream(true)).getReader();
  const fromDevice = new ReadableStream<Types.DeviceOutput>({
    async start(controller) {
      controller.enqueue({ type: "status", data: { status: Types.DeviceStatusEnum.DeviceConnected } });
      try {
        while (!closed) {
          const next = await reader.read();
          if (next.done) break;
          controller.enqueue(next.value);
        }
      } catch {
        // The disconnected event rejects pending sends and configuration reads.
      } finally {
        controller.enqueue({ type: "status", data: { status: Types.DeviceStatusEnum.DeviceDisconnected } });
        controller.close();
        reader.releaseLock();
      }
    }
  });
  const toDevice = new WritableStream<Uint8Array>({
    async write(packet) {
      if (closed) throw new Error("Meshtastic serial connection is closed");
      if (packet.length > 65_535) throw new RangeError("Meshtastic serial frame exceeds uint16 length");
      const frame = Buffer.allocUnsafe(packet.length + 4);
      frame[0] = 0x94;
      frame[1] = 0xc3;
      frame.writeUInt16BE(packet.length, 2);
      frame.set(packet, 4);
      await new Promise<void>((resolve, reject) => port.write(frame, (error) => (error ? reject(error) : resolve())));
    }
  });
  return {
    fromDevice,
    toDevice,
    async disconnect() {
      if (closed) return;
      closed = true;
      if (port.isOpen)
        await new Promise<void>((resolve, reject) => port.close((error) => (error ? reject(error) : resolve())));
      await reader.cancel().catch(() => undefined);
    }
  };
}
