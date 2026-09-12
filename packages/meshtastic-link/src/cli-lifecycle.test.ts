import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningLinkService, StartLinkServiceOptions } from "./lifecycle.js";
import type { MeshtasticSerialRadio } from "./radio.js";

const mocks = vi.hoisted(() => ({
  openRadio: vi.fn(),
  preflightGatewayAcceptance: vi.fn(),
  startLinkService: vi.fn()
}));

vi.mock("./lifecycle.js", () => ({
  preflightGatewayAcceptance: mocks.preflightGatewayAcceptance,
  startLinkService: mocks.startLinkService
}));

vi.mock("./radio.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./radio.js")>();
  return {
    ...original,
    MeshtasticSerialRadio: { open: mocks.openRadio }
  };
});

import { main } from "./cli.js";
import { createUSShortFastProfile } from "./profile.js";

describe("Meshtastic Link CLI lifecycle caller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes validated production defaults to the shared Gateway lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-link-cli-"));
    const profilePath = join(directory, "profile.json");
    const joinKeyPath = join(directory, "join.key");
    const membershipPath = join(directory, "membership.json");
    await writeFile(profilePath, JSON.stringify(createUSShortFastProfile(20, "2.7.15")));
    await writeFile(joinKeyPath, "k".repeat(32));
    await chmod(joinKeyPath, 0o600);
    const radio = {} as MeshtasticSerialRadio;
    mocks.openRadio.mockResolvedValue(radio);
    let received: StartLinkServiceOptions | undefined;
    const close = vi.fn(async () => undefined);
    mocks.startLinkService.mockImplementation(async (options: StartLinkServiceOptions): Promise<RunningLinkService> => {
      received = options;
      await options.openRadio();
      return { address: { host: "127.0.0.1", port: 7331 }, close };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      queueMicrotask(() => process.emit("SIGTERM"));
    });

    try {
      await main([
        "serve",
        "--mode",
        "gateway",
        "--node-id",
        "gateway-main",
        "--serial",
        "/dev/cu.test",
        "--profile",
        profilePath,
        "--join-key-file",
        joinKeyPath,
        "--membership",
        membershipPath
      ]);
      expect(received).toMatchObject({
        mode: "gateway",
        nodeID: "gateway-main",
        membershipPath,
        port: 7331,
        frameEncoding: "canonical-json",
        adaptiveRetries: false,
        stateDeltas: false
      });
      expect(mocks.openRadio).toHaveBeenCalledWith("/dev/cu.test");
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({ listening: "http://127.0.0.1:7331", mode: "gateway", node_id: "gateway-main" })
      );
      expect(close).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps serial validation in the production radio factory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-link-cli-"));
    const profilePath = join(directory, "profile.json");
    const joinKeyPath = join(directory, "join.key");
    await writeFile(profilePath, JSON.stringify(createUSShortFastProfile(20, "2.7.15")));
    await writeFile(joinKeyPath, "k".repeat(32));
    await chmod(joinKeyPath, 0o600);
    mocks.startLinkService.mockImplementation(async (options: StartLinkServiceOptions) => {
      await options.openRadio();
      throw new Error("radio factory unexpectedly resolved");
    });

    try {
      await expect(
        main([
          "serve",
          "--mode",
          "asset",
          "--node-id",
          "asset-alpha",
          "--profile",
          profilePath,
          "--join-key-file",
          joinKeyPath
        ])
      ).rejects.toThrow("--serial is required");
      expect(mocks.openRadio).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
