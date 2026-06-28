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
    expect(() => loadConfig({ env: { ATLAS_BASE_URL: "http://atlas.test" }, packageRoot })).toThrow("ATLAS_BASE_URL must use HTTPS unless it targets loopback");
    expect(() => loadConfig({ env: { ATLAS_BASE_URL: "https://user:pass@atlas.test" }, packageRoot })).toThrow("ATLAS_BASE_URL must not include embedded credentials");
    expect(() => loadConfig({ env: { ATLAS_BASE_URL: "https://atlas.test?bad=true" }, packageRoot })).toThrow("ATLAS_BASE_URL must not include a query string or fragment");
    expect(() => loadConfig({ env: { ATLAS_BASE_URL: "https://atlas.test/#bad" }, packageRoot })).toThrow("ATLAS_BASE_URL must not include a query string or fragment");
  });

  it("allows HTTP Atlas URLs only for loopback development targets", () => {
    const packageRoot = tempPackageRoot();

    expect(loadConfig({ env: { ATLAS_BASE_URL: "http://localhost:8000" }, packageRoot }).atlasBaseUrl).toBe("http://localhost:8000");
    expect(loadConfig({ env: { ATLAS_BASE_URL: "http://127.0.0.1:8000/" }, packageRoot }).atlasBaseUrl).toBe("http://127.0.0.1:8000");
    expect(loadConfig({ env: { ATLAS_BASE_URL: "http://127.0.0.2:8000/" }, packageRoot }).atlasBaseUrl).toBe("http://127.0.0.2:8000");
    expect(loadConfig({ env: { ATLAS_BASE_URL: "http://[::1]:8000" }, packageRoot }).atlasBaseUrl).toBe("http://[::1]:8000");
  });

  it("allows HTTPS Atlas URLs for remote disposable targets", () => {
    const packageRoot = tempPackageRoot();

    expect(loadConfig({ env: { ATLAS_BASE_URL: "https://atlascommandapi.org/" }, packageRoot }).atlasBaseUrl).toBe("https://atlascommandapi.org");
  });

  it("does not let undefined env overrides erase .env values", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), "ATLAS_SIM_PORT=5192\n");

    expect(loadConfig({ env: { ATLAS_SIM_PORT: undefined }, packageRoot }).port).toBe(5192);
  });

  it("treats blank env overrides as unset", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), "ATLAS_API_KEY=file-key\nATLAS_BASE_URL=https://atlascommandapi.org/api\n");

    const config = loadConfig({ env: { ATLAS_API_KEY: "", ATLAS_BASE_URL: " " }, packageRoot });
    expect(config.atlasApiKey).toBe("file-key");
    expect(config.atlasBaseUrl).toBe("https://atlascommandapi.org/api");
  });

  it("strips inline comments from unquoted .env values only", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(
      path.join(packageRoot, ".env"),
      [
        "ATLAS_SIM_PORT = 5190 # local override",
        "ATLAS_BASE_URL=https://atlascommandapi.org/api/",
        'ATLAS_API_KEY="abc # not a comment" # trailing comment'
      ].join("\n")
    );

    const config = loadConfig({ env: {}, packageRoot });
    expect(config.port).toBe(5190);
    expect(config.atlasBaseUrl).toBe("https://atlascommandapi.org/api");
    expect(config.atlasApiKey).toBe("abc # not a comment");
  });

  it("treats comment-only .env values as blank", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), "ATLAS_API_KEY=# replace locally\n");

    expect(loadConfig({ env: {}, packageRoot }).atlasApiKey).toBeUndefined();
  });

  it("unescapes matching quotes inside quoted .env values", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), String.raw`ATLAS_API_KEY='abc \'quoted\' key'`);

    expect(loadConfig({ env: {}, packageRoot }).atlasApiKey).toBe("abc 'quoted' key");
  });

  it("closes quoted .env values after even-length backslash runs", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), String.raw`ATLAS_API_KEY="abc\\" # trailing comment`);

    expect(loadConfig({ env: {}, packageRoot }).atlasApiKey).toBe(String.raw`abc\\`);
  });

  it("rejects malformed quoted .env values", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), 'ATLAS_BASE_URL="https://atlascommandapi.org"junk\n');

    expect(() => loadConfig({ env: {}, packageRoot })).toThrow("Invalid quoted value in .env");
  });
});

function tempPackageRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atlas-simulations-config-"));
}
