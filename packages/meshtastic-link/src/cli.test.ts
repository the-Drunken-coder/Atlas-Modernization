import { describe, expect, it } from "vitest";
import { main } from "./cli.js";

describe("Meshtastic Link CLI", () => {
  it("rejects a Gateway ID that cannot be used as a Link node ID", async () => {
    await expect(
      main([
        "gateway-init",
        "--membership",
        "/tmp/atlas-invalid-gateway-membership.json",
        "--gateway-id",
        "invalid:gateway",
        "--channel-index",
        "1"
      ])
    ).rejects.toThrow("--gateway-id must not contain ':'");
  });
});
