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
  });

  it("strips inline comments from unquoted .env values only", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(
      path.join(packageRoot, ".env"),
      [
        "ATLAS_SIM_PORT=5190 # local override",
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
