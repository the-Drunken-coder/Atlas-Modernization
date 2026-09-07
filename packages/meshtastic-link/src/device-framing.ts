import type { Types } from "@meshtastic/core";

/** Client API frames use a two-byte marker and big-endian uint16 length. Payload bytes are opaque. */
export function deviceFrameStream(allowDebug = false) {
  let pending = new Uint8Array(0);
  return new TransformStream<Uint8Array, Types.DeviceOutput>({
    transform(chunk, controller) {
      const buffer = new Uint8Array(pending.length + chunk.length);
      buffer.set(pending);
      buffer.set(chunk, pending.length);
      let offset = 0;
      while (buffer.length - offset >= 2) {
        if (allowDebug && (buffer[offset] !== 0x94 || buffer[offset + 1] !== 0xc3)) {
          offset++;
          continue;
        }
        if (buffer.length - offset < 4) break;
        if (buffer[offset] !== 0x94 || buffer[offset + 1] !== 0xc3) {
          throw new Error("Invalid Meshtastic frame header");
        }
        const length = (buffer[offset + 2] ?? 0) * 256 + (buffer[offset + 3] ?? 0);
        const end = offset + 4 + length;
        if (buffer.length < end) break;
        controller.enqueue({ type: "packet", data: buffer.slice(offset + 4, end) });
        offset = end;
      }
      // The uint16 length bounds a retained partial frame to at most 65,538 bytes.
      pending = buffer.slice(offset);
      if (allowDebug && pending.length === 1 && pending[0] !== 0x94) pending = new Uint8Array(0);
    },
    flush() {
      if (pending.length) throw new Error("Truncated Meshtastic frame");
    }
  });
}
