import { describe, expect, it } from "vitest";
import { deviceFrameStream } from "./device-framing.js";

async function decode(chunks: Uint8Array[], allowDebug = false) {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
  const output = [];
  for await (const packet of input.pipeThrough(deviceFrameStream(allowDebug))) output.push(packet);
  return output;
}

describe("device binary framing", () => {
  it.each([1, 2, 3, 7, 100])("preserves embedded markers with %i-byte stream chunks", async (chunkSize) => {
    const bytes = Uint8Array.of(0x94, 0xc3, 0, 4, 1, 0x94, 0xc3, 2, 0x94, 0xc3, 0, 1, 3);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.slice(i, i + chunkSize));
    expect(await decode(chunks)).toEqual([
      { type: "packet", data: Uint8Array.of(1, 0x94, 0xc3, 2) },
      { type: "packet", data: Uint8Array.of(3) }
    ]);
  });
  it("fails closed on a truncated frame or invalid header", async () => {
    await expect(decode([Uint8Array.of(0x94, 0xc3, 0, 4, 1)])).rejects.toThrow("Truncated");
    await expect(decode([Uint8Array.of(1, 2, 3, 4)])).rejects.toThrow("Invalid");
  });
});

it("discards serial boot text while preserving split markers and opaque payloads", async () => {
  expect(
    await decode(
      [
        new TextEncoder().encode("boot log\n"),
        Uint8Array.of(0x94),
        Uint8Array.of(0xc3, 0, 3, 0x94),
        Uint8Array.of(0xc3, 1, 10)
      ],
      true
    )
  ).toEqual([{ type: "packet", data: Uint8Array.of(0x94, 0xc3, 1) }]);
});
