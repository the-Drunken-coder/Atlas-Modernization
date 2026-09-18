import { expect, it } from "vitest";
import { BinaryReader, encodeUnsignedVarint } from "./binary-io.js";

it.each([
  { value: 0, bytes: [0] },
  { value: 127, bytes: [127] },
  { value: 128, bytes: [128, 1] },
  { value: Number.MAX_SAFE_INTEGER, bytes: [255, 255, 255, 255, 255, 255, 255, 15] }
])("preserves the unsigned-varint wire encoding of $value", ({ value, bytes }) => {
  expect(encodeUnsignedVarint(value, "invalid integer")).toEqual(Uint8Array.from(bytes));
  const reader = new BinaryReader(Uint8Array.from(bytes));
  expect(reader.readUnsignedVarint()).toBe(value);
  expect(reader.done()).toBe(true);
});

it.each([[], [128], [255, 255, 255, 255, 255, 255, 255, 16], Array<number>(8).fill(128)].map((bytes) => ({ bytes })))(
  "rejects truncated, unsafe, and unterminated varints %#",
  ({ bytes }) => {
    expect(new BinaryReader(Uint8Array.from(bytes)).readUnsignedVarint()).toBeUndefined();
  }
);

it("rejects invalid lengths without consuming bytes and rejects malformed UTF-8", () => {
  const reader = new BinaryReader(Uint8Array.of(1, 255));
  for (const length of [-1, 0.5, 3]) expect(reader.readBytes(length)).toBeUndefined();
  expect(reader.readRemaining()).toEqual(Uint8Array.of(1, 255));
  expect(reader.readUTF8()).toBeUndefined();
  expect(reader.done()).toBe(true);
});
