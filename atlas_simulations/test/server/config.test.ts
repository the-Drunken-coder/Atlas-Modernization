import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { createTargetRegistry, targetForRun } from "../../src/server/targets.js";

describe("loadConfig", () => {
  it("offers only the local target by default", () => {
    const packageRoot = tempPackageRoot();

    const config = loadConfig({ env: {}, packageRoot });

    expect(config.defaultAtlasTargetId).toBe("local");
    expect(config.atlasTargets).toEqual([{ id: "local", label: "Local Core", baseUrl: "http://localhost:8000" }]);
    expect(config.cleanupLedgerDirectory).toBe(path.join(packageRoot, ".atlas-simulations", "runs"));
  });

  it("ignores removed single-target environment aliases", () => {
    const packageRoot = tempPackageRoot();

    const config = loadConfig({
      env: { ATLAS_BASE_URL: "http://127.0.0.2:8000", ATLAS_API_KEY: "legacy-key" },
      packageRoot
    });

    expect(config.atlasTargets).toEqual([{ id: "local", label: "Local Core", baseUrl: "http://localhost:8000" }]);
  });

  it.each(["true", "1", "yes", "on"])("uses the launcher-generated Core key for truthy auth value %s", (enabled) => {
    const packageRoot = tempWorkspacePackageRoot(`ENABLE_API_AUTH=${enabled}\nAPI_AUTH_KEY=launcher-local-key\n`);

    const config = loadConfig({
      env: {
        ATLAS_SIM_ENABLE_DEPLOYED: "true",
        ATLAS_DEPLOYED_BASE_URL: "https://atlas.example.test"
      },
      packageRoot
    });

    expect(config.atlasTargets[0]?.apiKey).toBe("launcher-local-key");
    expect(config.atlasTargets).toEqual([
      { id: "local", label: "Local Core", baseUrl: "http://localhost:8000", apiKey: "launcher-local-key" },
      { id: "deployed", label: "Deployed Core", baseUrl: "https://atlas.example.test" }
    ]);
  });

  it("prefers an explicit simulation key and ignores disabled Core auth", () => {
    const packageRoot = tempWorkspacePackageRoot("ENABLE_API_AUTH=false\nAPI_AUTH_KEY=stale-core-key\n");

    expect(loadConfig({ env: {}, packageRoot }).atlasTargets[0]?.apiKey).toBeUndefined();
    expect(loadConfig({ env: { ATLAS_LOCAL_API_KEY: "explicit-key" }, packageRoot }).atlasTargets[0]?.apiKey).toBe(
      "explicit-key"
    );
  });

  it("does not load public-mode credentials from the Compose env file", () => {
    const packageRoot = tempWorkspacePackageRoot("ENABLE_API_AUTH=true\nAPI_AUTH_KEY=public-mode-key\n", ".env");

    expect(loadConfig({ env: {}, packageRoot }).atlasTargets[0]?.apiKey).toBeUndefined();
  });

  it("uses the default port when ATLAS_SIM_PORT is blank", () => {
    const packageRoot = tempPackageRoot();
    expect(loadConfig({ env: { ATLAS_SIM_PORT: " " }, packageRoot }).port).toBe(5180);
  });

  it("rejects non-numeric ATLAS_SIM_PORT values", () => {
    const packageRoot = tempPackageRoot();
    expect(() => loadConfig({ env: { ATLAS_SIM_PORT: "abc" }, packageRoot })).toThrow(
      "ATLAS_SIM_PORT must be a valid TCP port"
    );
    expect(() => loadConfig({ env: { ATLAS_SIM_PORT: "0x143c" }, packageRoot })).toThrow(
      "ATLAS_SIM_PORT must be a valid TCP port"
    );
  });

  it("rejects invalid ATLAS_LOCAL_BASE_URL values", () => {
    const packageRoot = tempPackageRoot();
    expect(() => loadConfig({ env: { ATLAS_LOCAL_BASE_URL: "localhost:8000" }, packageRoot })).toThrow(
      "ATLAS_LOCAL_BASE_URL must be a valid HTTP(S) URL"
    );
    expect(() => loadConfig({ env: { ATLAS_LOCAL_BASE_URL: "ftp://atlas.test" }, packageRoot })).toThrow(
      "ATLAS_LOCAL_BASE_URL must be a valid HTTP(S) URL"
    );
    expect(() => loadConfig({ env: { ATLAS_LOCAL_BASE_URL: "http://atlas.test" }, packageRoot })).toThrow(
      "ATLAS_LOCAL_BASE_URL must use HTTPS unless it targets loopback"
    );
    expect(() => loadConfig({ env: { ATLAS_LOCAL_BASE_URL: "https://user:pass@atlas.test" }, packageRoot })).toThrow(
      "ATLAS_LOCAL_BASE_URL must not include embedded credentials"
    );
    expect(() => loadConfig({ env: { ATLAS_LOCAL_BASE_URL: "https://atlas.test?bad=true" }, packageRoot })).toThrow(
      "ATLAS_LOCAL_BASE_URL must not include a query string or fragment"
    );
    expect(() => loadConfig({ env: { ATLAS_LOCAL_BASE_URL: "https://atlas.test/#bad" }, packageRoot })).toThrow(
      "ATLAS_LOCAL_BASE_URL must not include a query string or fragment"
    );
  });

  it("allows HTTP Atlas URLs only for loopback development targets", () => {
    const packageRoot = tempPackageRoot();

    expect(
      loadConfig({ env: { ATLAS_LOCAL_BASE_URL: "http://localhost:8000" }, packageRoot }).atlasTargets[0]?.baseUrl
    ).toBe("http://localhost:8000");
    expect(
      loadConfig({ env: { ATLAS_LOCAL_BASE_URL: "http://127.0.0.1:8000/" }, packageRoot }).atlasTargets[0]?.baseUrl
    ).toBe("http://127.0.0.1:8000");
    expect(
      loadConfig({ env: { ATLAS_LOCAL_BASE_URL: "http://127.0.0.2:8000/" }, packageRoot }).atlasTargets[0]?.baseUrl
    ).toBe("http://127.0.0.2:8000");
    expect(
      loadConfig({ env: { ATLAS_LOCAL_BASE_URL: "http://[::1]:8000" }, packageRoot }).atlasTargets[0]?.baseUrl
    ).toBe("http://[::1]:8000");
  });

  it("rejects non-loopback URLs for the local target", () => {
    const packageRoot = tempPackageRoot();

    expect(() => loadConfig({ env: { ATLAS_LOCAL_BASE_URL: "https://atlascommandapi.org/" }, packageRoot })).toThrow(
      "ATLAS_LOCAL_BASE_URL must target loopback"
    );
  });

  it("builds a deployed target only when explicitly enabled with a URL", () => {
    const packageRoot = tempPackageRoot();

    const config = loadConfig({
      env: {
        ATLAS_LOCAL_BASE_URL: "http://127.0.0.1:8000/",
        ATLAS_LOCAL_API_KEY: "local-key",
        ATLAS_SIM_ENABLE_DEPLOYED: "true",
        ATLAS_DEPLOYED_BASE_URL: "https://atlascommandapi.org/",
        ATLAS_DEPLOYED_API_KEY: "deployed-key",
        ATLAS_SIM_TARGET: "deployed"
      },
      packageRoot
    });

    expect(config.defaultAtlasTargetId).toBe("deployed");
    expect(config.atlasTargets).toEqual([
      { id: "local", label: "Local Core", baseUrl: "http://127.0.0.1:8000", apiKey: "local-key" },
      { id: "deployed", label: "Deployed Core", baseUrl: "https://atlascommandapi.org", apiKey: "deployed-key" }
    ]);
  });

  it("requires a deployed URL when deployed support is enabled", () => {
    const packageRoot = tempPackageRoot();

    expect(() => loadConfig({ env: { ATLAS_SIM_ENABLE_DEPLOYED: "true" }, packageRoot })).toThrow(
      "ATLAS_DEPLOYED_BASE_URL is required when ATLAS_SIM_ENABLE_DEPLOYED=true"
    );
  });

  it("rejects deployed configuration unless deployed support is enabled", () => {
    const packageRoot = tempPackageRoot();

    expect(() => loadConfig({ env: { ATLAS_DEPLOYED_BASE_URL: "https://atlascommandapi.org" }, packageRoot })).toThrow(
      "Set ATLAS_SIM_ENABLE_DEPLOYED=true"
    );
    expect(() => loadConfig({ env: { ATLAS_SIM_TARGET: "deployed" }, packageRoot })).toThrow(
      "Set ATLAS_SIM_ENABLE_DEPLOYED=true"
    );
  });

  it("rejects invalid deployed enable flags", () => {
    const packageRoot = tempPackageRoot();

    expect(() => loadConfig({ env: { ATLAS_SIM_ENABLE_DEPLOYED: "yes" }, packageRoot })).toThrow(
      "ATLAS_SIM_ENABLE_DEPLOYED must be true or false"
    );
  });

  it("allows the default simulation target to be selected explicitly", () => {
    const packageRoot = tempPackageRoot();

    expect(
      loadConfig({
        env: {
          ATLAS_SIM_ENABLE_DEPLOYED: "true",
          ATLAS_DEPLOYED_BASE_URL: "https://atlascommandapi.org",
          ATLAS_SIM_TARGET: "deployed"
        },
        packageRoot
      }).defaultAtlasTargetId
    ).toBe("deployed");
    expect(() => loadConfig({ env: { ATLAS_SIM_TARGET: "staging" }, packageRoot })).toThrow(
      "ATLAS_SIM_TARGET must be local or deployed"
    );
  });

  it("binds an explicit recovery key to the recorded URL instead of a changed configured target", () => {
    const registry = createTargetRegistry({
      atlasTargets: [{ id: "deployed", label: "Current deployed Core", baseUrl: "https://new-atlas.example.test" }],
      defaultAtlasTargetId: "deployed",
      port: 5180,
      packageRoot: tempPackageRoot()
    });
    const recorded = { id: "deployed", baseUrl: "https://recorded-atlas.example.test" };

    expect(() => targetForRun(recorded, registry, undefined)).toThrow("no longer matches");
    expect(targetForRun(recorded, registry, "recovery-key")).toEqual({
      id: "deployed",
      label: "Recovered deployed Core",
      baseUrl: "https://recorded-atlas.example.test",
      apiKey: "recovery-key"
    });
  });

  it("rejects a target registry whose declared default is not configured", () => {
    expect(() =>
      createTargetRegistry({
        atlasTargets: [{ id: "local", label: "Local Core", baseUrl: "http://127.0.0.1:8000" }],
        defaultAtlasTargetId: "missing",
        port: 5180,
        packageRoot: tempPackageRoot()
      })
    ).toThrow("Default Atlas target missing is not configured");
  });

  it("does not let undefined env overrides erase .env values", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), "ATLAS_SIM_PORT=5192\n");

    expect(loadConfig({ env: { ATLAS_SIM_PORT: undefined }, packageRoot }).port).toBe(5192);
  });

  it("treats blank env overrides as unset", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(
      path.join(packageRoot, ".env"),
      "ATLAS_LOCAL_API_KEY=file-key\nATLAS_LOCAL_BASE_URL=http://127.0.0.1:8000/api\n"
    );

    const config = loadConfig({ env: { ATLAS_LOCAL_API_KEY: "", ATLAS_LOCAL_BASE_URL: " " }, packageRoot });
    expect(config.atlasTargets[0]?.apiKey).toBe("file-key");
    expect(config.atlasTargets[0]?.baseUrl).toBe("http://127.0.0.1:8000/api");
  });

  it("strips inline comments from unquoted .env values only", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(
      path.join(packageRoot, ".env"),
      [
        "ATLAS_SIM_PORT = 5190 # local override",
        "ATLAS_LOCAL_BASE_URL=http://127.0.0.1:8000/api/",
        'ATLAS_LOCAL_API_KEY="abc # not a comment" # trailing comment'
      ].join("\n")
    );

    const config = loadConfig({ env: {}, packageRoot });
    expect(config.port).toBe(5190);
    expect(config.atlasTargets[0]?.baseUrl).toBe("http://127.0.0.1:8000/api");
    expect(config.atlasTargets[0]?.apiKey).toBe("abc # not a comment");
  });

  it("treats comment-only .env values as blank", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), "ATLAS_LOCAL_API_KEY=# replace locally\n");

    expect(loadConfig({ env: {}, packageRoot }).atlasTargets[0]?.apiKey).toBeUndefined();
  });

  it("keeps single quoted .env values literal", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), String.raw`ATLAS_LOCAL_API_KEY='abc \ literal # key'`);

    expect(loadConfig({ env: {}, packageRoot }).atlasTargets[0]?.apiKey).toBe(String.raw`abc \ literal # key`);
  });

  it("unescapes standard double quoted .env values", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), String.raw`ATLAS_LOCAL_API_KEY="abc \"quoted\" \\ key\nnext"`);

    expect(loadConfig({ env: {}, packageRoot }).atlasTargets[0]?.apiKey).toBe('abc "quoted" \\ key\nnext');
  });

  it("closes quoted .env values after even-length backslash runs", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), String.raw`ATLAS_LOCAL_API_KEY="abc\\" # trailing comment`);

    expect(loadConfig({ env: {}, packageRoot }).atlasTargets[0]?.apiKey).toBe("abc\\");
  });

  it("rejects malformed quoted .env values", () => {
    const packageRoot = tempPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), 'ATLAS_LOCAL_BASE_URL="https://atlascommandapi.org"junk\n');

    expect(() => loadConfig({ env: {}, packageRoot })).toThrow("Invalid quoted value in .env");
  });
});

function tempPackageRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atlas-simulations-config-"));
}

function tempWorkspacePackageRoot(coreEnv: string, envFilename = ".env.local"): string {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "atlas-simulations-workspace-"));
  const packageRoot = path.join(workspaceRoot, "atlas_simulations");
  const coreDockerRoot = path.join(workspaceRoot, "atlas_core", "docker");
  mkdirSync(packageRoot);
  mkdirSync(coreDockerRoot, { recursive: true });
  writeFileSync(path.join(coreDockerRoot, envFilename), coreEnv);
  return packageRoot;
}
