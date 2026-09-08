import { describe, expect, it, vi } from "vitest";
import { VirtualClock } from "./clock.js";
import { SharedPicture } from "./picture.js";
import { LinkTransport } from "./transport.js";

// Exercise the fixed admission boundary with a small trusted source roster.
vi.mock("./types.js", async (original) => ({
  ...(await original<typeof import("./types.js")>()),
  LINK_SOURCE_IDENTITY_LIMIT: 2
}));

function gateway(picture?: SharedPicture): LinkTransport {
  return new LinkTransport({
    node: { role: "gateway", id: "gateway" },
    sourceGeneration: 1,
    clock: new VirtualClock(),
    ...(picture === undefined ? {} : { picture }),
    radio: {
      max_payload_bytes: 233,
      send: async () => undefined,
      close: async () => undefined,
      onPacket: () => () => undefined
    }
  });
}

describe("source admission", () => {
  it("bounds source identities without evicting fences or blocking generation advancement", () => {
    const transport = gateway();
    const alpha = { role: "asset", id: "alpha" } as const;
    try {
      expect(transport.announceSourceActivation(alpha, 1, "a").status).toBe("queued");
      expect(transport.announceSourceActivation({ role: "asset", id: "beta" }, 1, "b").status).toBe("queued");
      expect(() => transport.announceSourceActivation({ role: "asset", id: "gamma" }, 1, "c")).toThrow("capacity");
      expect(transport.announceSourceActivation(alpha, 2, "next").status).toBe("queued");
      expect(() => transport.announceSourceActivation(alpha, 1, "a")).toThrow("stale_source");
    } finally {
      transport.stop();
    }
  });

  it("does not bind a transport source when picture admission refuses it", () => {
    const picture = new SharedPicture();
    const admission = vi.spyOn(picture, "activateSource").mockReturnValueOnce(false);
    const transport = gateway(picture);
    try {
      const source = { role: "asset", id: "alpha" } as const;
      expect(() => transport.announceSourceActivation(source, 2, "refused")).toThrow("picture_rejected");
      expect(transport.announceSourceActivation(source, 1, "accepted").status).toBe("queued");
      expect(admission).toHaveBeenCalledTimes(2);
    } finally {
      transport.stop();
    }
  });

  it("validates activation arguments before changing source state", () => {
    const transport = gateway();
    const source = { role: "asset", id: "alpha" } as const;
    try {
      expect(() => transport.announceSourceActivation(source, 3.5, "invalid")).toThrow();
      expect(() => transport.announceSourceActivation(source, 3, " ")).toThrow();
      expect(transport.announceSourceActivation(source, 1, "valid").status).toBe("queued");
    } finally {
      transport.stop();
    }
  });
});
