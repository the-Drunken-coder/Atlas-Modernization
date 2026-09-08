import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GatewayMembershipStore } from "./membership.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});

const input = {
  gateway_node_id: "gateway",
  channel_index: 1,
  channel_name: "ATLAS",
  channel_key_base64: Buffer.alloc(32, 9).toString("base64")
};

describe("Gateway membership initialization", () => {
  it.each(["writeFile", "sync"] as const)(
    "removes its incomplete file after %s fails and permits retry",
    async (method) => {
      const directory = await mkdtemp(join(tmpdir(), "atlas-membership-init-"));
      const path = join(directory, "membership.json");
      const store = new GatewayMembershipStore(path);
      const failure = new Error("simulated storage failure");
      const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(open).mockImplementationOnce(async (file, flags, mode) => {
        const handle = await fs.open(file, flags, mode);
        vi.spyOn(handle, method).mockRejectedValueOnce(failure);
        return handle;
      });
      try {
        await expect(store.initialize(input)).rejects.toBe(failure);
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
        await store.initialize(input);
        expect(await store.load()).toMatchObject({ ...input, gateway_generation: 0, asset_generations: {} });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("preserves a membership file created by an earlier initialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-membership-existing-"));
    const path = join(directory, "membership.json");
    const store = new GatewayMembershipStore(path);
    try {
      await store.initialize(input);
      const original = await readFile(path, "utf8");
      await expect(store.initialize({ ...input, gateway_node_id: "other" })).rejects.toThrow("already exists");
      expect(await readFile(path, "utf8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
