export function encodeUnsignedVarint(value: number, errorMessage: string): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(errorMessage);
  const bytes: number[] = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return Uint8Array.from(bytes);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export class BinaryReader {
  private offset = 0;

  constructor(private readonly payload: Uint8Array) {}

  readByte(): number | undefined {
    if (this.offset >= this.payload.byteLength) return undefined;
    return this.payload[this.offset++];
  }

  readUnsignedVarint(): number | undefined {
    let value = 0n;
    for (let index = 0; index < 8; index++) {
      const byte = this.readByte();
      if (byte === undefined) return undefined;
      value |= BigInt(byte & 0x7f) << BigInt(index * 7);
      if ((byte & 0x80) === 0) {
        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
      }
    }
    return undefined;
  }

  readBytes(length: number): Uint8Array | undefined {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.payload.byteLength - this.offset) return undefined;
    const result = this.payload.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  readLengthPrefixedBytes(): Uint8Array | undefined {
    const length = this.readUnsignedVarint();
    return length === undefined ? undefined : this.readBytes(length);
  }

  readUTF8(): string | undefined {
    const bytes = this.readLengthPrefixedBytes();
    if (bytes === undefined) return undefined;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
  }

  readRemaining(): Uint8Array {
    return this.payload.slice(this.offset);
  }

  done(): boolean {
    return this.offset === this.payload.byteLength;
  }
}
