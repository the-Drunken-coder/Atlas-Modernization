import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.js";
import type { LinkRadio, RadioPacket, RadioSendOptions } from "./radio.js";
import { positionPublication } from "./test-fixtures.js";
import { LinkTransport } from "./transport.js";

class BlockingRadio implements LinkRadio {
  readonly max_payload_bytes = 233;
  readonly sent: Uint8Array[] = [];
  private release: (() => void) | undefined;

  send(payload: Uint8Array, _options: RadioSendOptions): Promise<void> {
    this.sent.push(payload);
    if (this.sent.length !== 1) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  onPacket(_handler: (packet: RadioPacket) => void): () => void {
    return () => undefined;
  }

  releaseFirstSend(): void {
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function makeTransport(clock: VirtualClock, radio: LinkRadio): LinkTransport {
  return new LinkTransport({
    node: { role: "asset", id: "asset-alpha" },
    sourceGeneration: 1,
    serviceSession: "session-alpha",
    radio,
    clock
  });
}

describe("Link transport pause", () => {
  it("drains the current send and preserves queued work until resume", async () => {
    const clock = new VirtualClock();
    const radio = new BlockingRadio();
    const transport = makeTransport(clock, radio);
    const first = positionPublication(1);
    const second = positionPublication(2);
    second.resource.entity_id = "asset-bravo";

    expect(transport.submit(first, { operationID: "position-1" }).status).toBe("queued");
    expect(transport.submit(second, { operationID: "position-2" }).status).toBe("queued");
    const pumping = clock.advanceBy(0);
    await Promise.resolve();
    const paused = transport.pause();
    await Promise.resolve();
    expect(radio.sent).toHaveLength(1);

    radio.releaseFirstSend();
    await pumping;
    await paused;
    expect(radio.sent).toHaveLength(1);
    expect(transport.status("position-2")).toMatchObject({ status: "queued" });

    transport.resume();
    await clock.runUntilIdle();
    expect(radio.sent).toHaveLength(14);
    expect(transport.status("position-2")).toMatchObject({ status: "sent" });
    transport.stop();
  });

  it("cancels an unscheduled pump without dropping the queued operation", async () => {
    const clock = new VirtualClock();
    const radio = new BlockingRadio();
    const transport = makeTransport(clock, radio);
    expect(transport.submit(positionPublication(1), { operationID: "position-1" }).status).toBe("queued");

    await transport.pause();
    await clock.runUntilIdle();
    expect(radio.sent).toHaveLength(0);
    expect(transport.status("position-1")).toMatchObject({ status: "queued" });

    transport.resume();
    const pumping = clock.advanceBy(0);
    await Promise.resolve();
    radio.releaseFirstSend();
    await pumping;
    expect(transport.status("position-1")).toMatchObject({ status: "sent" });
    transport.stop();
  });
});
