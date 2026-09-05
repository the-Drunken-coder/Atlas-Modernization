import { describe, expect, it } from "vitest";
import {
  type LinkRadio,
  LinkRadioGate,
  type RadioPacket,
  type RadioSendOptions,
  RadioTransmissionSuspendedError
} from "./radio.js";

class FakeRadio implements LinkRadio {
  readonly max_payload_bytes = 233;
  readonly sent: Uint8Array[] = [];
  private packetHandler: ((packet: RadioPacket) => void) | undefined;
  private sendRelease: (() => void) | undefined;

  pacingDelayMs(): number {
    return 0;
  }

  send(payload: Uint8Array, _options: RadioSendOptions): Promise<void> {
    this.sent.push(payload);
    if (!this.sendRelease) return Promise.resolve();
    const release = new Promise<void>((resolve) => {
      this.sendRelease = resolve;
    });
    return release;
  }

  onPacket(handler: (packet: RadioPacket) => void): () => void {
    this.packetHandler = handler;
    return () => {
      if (this.packetHandler === handler) this.packetHandler = undefined;
    };
  }

  close(): Promise<void> {
    this.packetHandler = undefined;
    return Promise.resolve();
  }

  blockNextSend(): void {
    this.sendRelease = () => undefined;
  }

  releaseSend(): void {
    const release = this.sendRelease;
    this.sendRelease = undefined;
    release?.();
  }
}

describe("LinkRadioGate", () => {
  it("drains an in-flight send and rejects sends while suspended", async () => {
    const raw = new FakeRadio();
    raw.blockNextSend();
    const gate = new LinkRadioGate(raw);
    const first = gate.send(new Uint8Array([1]), { channel: 0 });
    const suspended = gate.suspend();

    await Promise.resolve();
    expect(raw.sent).toHaveLength(1);
    await expect(gate.send(new Uint8Array([2]), { channel: 0 })).rejects.toBeInstanceOf(
      RadioTransmissionSuspendedError
    );

    raw.releaseSend();
    await first;
    await suspended;
    expect(raw.sent).toHaveLength(1);

    gate.resume();
    await expect(gate.send(new Uint8Array([3]), { channel: 0 })).resolves.toBeUndefined();
    expect(raw.sent).toHaveLength(2);
  });

  it("keeps transmission closed after abort", async () => {
    const raw = new FakeRadio();
    const gate = new LinkRadioGate(raw);
    await gate.suspend();
    gate.abort(new Error("service stopped"));

    await expect(gate.send(new Uint8Array([1]), { channel: 0 })).rejects.toThrow("service stopped");
    gate.resume();
    await expect(gate.send(new Uint8Array([2]), { channel: 0 })).rejects.toThrow("service stopped");
    expect(raw.sent).toHaveLength(0);
  });
});
