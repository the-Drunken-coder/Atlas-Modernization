import { once } from "node:events";
import { createConnection } from "node:net";
import { Readable, Writable } from "node:stream";
import { Types, Utils } from "@meshtastic/core";
import { deviceFrameStream } from "../device-framing.js";

/** Meshtastic's ordinary framed TCP Client API, restricted to local laboratory nodes. */
export async function openLabTCP(port: number): Promise<Types.Transport> {
  if (!Number.isInteger(port) || port < 45001 || port > 45010) {
    throw new RangeError("Lab node port must be between 45001 and 45010");
  }
  const socket = createConnection({ host: "127.0.0.1", port });
  try {
    await once(socket, "connect", { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    socket.destroy();
    throw error;
  }
  socket.setNoDelay(true);
  const incoming = Readable.toWeb(socket).pipeThrough(deviceFrameStream());
  const reader = incoming.getReader();
  const outgoing = Utils.toDeviceStream();
  let closed = false;
  const piping = outgoing.readable.pipeTo(Writable.toWeb(socket)).catch(() => socket.destroy());
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
        // DeviceDisconnected rejects the production adapter's pending sends.
      } finally {
        controller.enqueue({ type: "status", data: { status: Types.DeviceStatusEnum.DeviceDisconnected } });
        controller.close();
        reader.releaseLock();
      }
    }
  });
  return {
    fromDevice,
    toDevice: outgoing.writable,
    async disconnect() {
      if (closed) return;
      closed = true;
      socket.destroy();
      await piping;
    }
  };
}
