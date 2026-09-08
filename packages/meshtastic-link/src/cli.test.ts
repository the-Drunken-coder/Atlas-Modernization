import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

describe("Meshtastic Link CLI", () => {
  it("preserves HTTP status when the local service returns a non-JSON error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503, statusText: "Service Unavailable" }))
    );
    try {
      await expect(main(["radio", "show"])).rejects.toThrow("Link service returned 503: Service Unavailable");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preflights actual join bytes before creating Gateway membership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-join-preflight-"));
    const membership = join(directory, "membership.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const initialize = (id: string) =>
      main(["gateway-init", "--membership", membership, "--gateway-id", id, "--channel-index", "1"]);
    try {
      await expect(initialize("é".repeat(1000))).rejects.toThrow("join message exceeds one Meshtastic packet");
      await expect(readFile(membership)).rejects.toMatchObject({ code: "ENOENT" });
      const id = 'gateway-"\\'.repeat(4);
      await initialize(id);
      expect(JSON.parse(await readFile(membership, "utf8"))).toMatchObject({
        gateway_node_id: id,
        gateway_generation: 0,
        asset_generations: {}
      });
    } finally {
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
