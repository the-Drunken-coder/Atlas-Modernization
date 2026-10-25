import { Duplex, PassThrough } from "node:stream";
import { minimal } from "node-mavlink";
import { describe, expect, it } from "vitest";
import { MavLink } from "./mavlink-link.js";

describe("MavLink transport lifecycle", () => {
  it("records an EPIPE write failure and rejects later sends without an unhandled error event", async () => {
    const link = new MavLink(new EpipeDuplex(), 255, 190, "test link");

    await expect(link.send(new minimal.Heartbeat())).rejects.toThrow("MAVLink test link transport failed: broken pipe");
    expect(link.status()).toMatchObject({
      state: "failed",
      error: { message: "MAVLink test link transport failed: broken pipe" }
    });
    await expect(link.send(new minimal.Heartbeat())).rejects.toThrow("MAVLink test link transport failed: broken pipe");
  });

  it("rejects sends after a deliberate close", async () => {
    const stream = new PassThrough();
    const link = new MavLink(stream, 255, 190, "test link");

    await link.close();

    expect(stream.destroyed).toBe(true);
    expect(link.status()).toEqual({ state: "closed" });
    await expect(link.send(new minimal.Heartbeat())).rejects.toThrow("MAVLink test link is closed");
  });
});

class EpipeDuplex extends Duplex {
  override _read(): void {}

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  }
}
