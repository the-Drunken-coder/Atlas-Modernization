import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";

describe("loadConfig", () => {
  it("uses the default port when ATLAS_SIM_PORT is blank", () => {
    const packageRoot = tempPackageRoot();
    expect(loadConfig({ env: { ATLAS_SIM_PORT: " " }, packageRoot }).port).toBe(5180);
  });

  it("rejects non-numeric ATLAS_SIM_PORT values", () => {
    const packageRoot = tempPackageRoot();
    expect(() => loadConfig({ env: { ATLAS_SIM_PORT: "abc" }, packageRoot })).toThrow("ATLAS_SIM_PORT must be a valid TCP port");
    expect(() => loadConfig({ env: { ATLAS_SIM_PORT: "0x143c" }, packageRoot })).toThrow("ATLAS_SIM_PORT must be a valid TCP port");
  });

  it("rejects invalid ATLAS_BASE_URL values", () => {
    const packageRoot = tempPackageRoot();
    expect(() => loadConfig({ env: { ATLAS_BASE_URL: "localhost:8000" }, packageRoot })).toThrow("ATLAS_BASE_URL must be a valid HTTP(S) URL");
    expect(() => loadConfig({ env: { ATLAS_BASE_URL: "ftp://atlas.test" }, packageRoot })).toThrow("ATLAS_BASE_URL must be a valid HTTP(S) URL");
  });

  it("does not let undefined env overrides erase .env values", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), "ATLAS_SIM_PORT=5192\n");

    expect(loadConfig({ env: { ATLAS_SIM_PORT: undefined }, packageRoot }).port).toBe(5192);
  });

  it("strips inline comments from unquoted .env values only", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(
      path.join(packageRoot, ".env"),
      [
        "ATLAS_SIM_PORT = 5190 # local override",
        "ATLAS_BASE_URL=https://atlascommandapi.org/#health",
        'ATLAS_API_KEY="abc # not a comment" # trailing comment'
      ].join("\n")
    );

    const config = loadConfig({ env: {}, packageRoot });
    expect(config.port).toBe(5190);
    expect(config.atlasBaseUrl).toBe("https://atlascommandapi.org/#health");
    expect(config.atlasApiKey).toBe("abc # not a comment");
  });
});

function tempPackageRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atlas-simulations-config-"));
}
