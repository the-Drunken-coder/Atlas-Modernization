import { createServer as createViteServer, type ViteDevServer } from "vite";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSimulationServer, type SimulationServer } from "../../src/server/index.js";
import { RunStore } from "../../src/server/run-store.js";
import { createFakeAtlasCore } from "../support/fake-atlas.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let app: SimulationServer | undefined;
let vite: ViteDevServer | undefined;
let previousSimPort: string | undefined;
let previousEnableDeployed: string | undefined;
let previousDeployedBaseUrl: string | undefined;

afterEach(async () => {
  await vite?.close();
  await app?.close();
  vite = undefined;
  app = undefined;
  if (previousSimPort === undefined) {
    delete process.env.ATLAS_SIM_PORT;
  } else {
    process.env.ATLAS_SIM_PORT = previousSimPort;
  }
  previousSimPort = undefined;
  restoreEnv("ATLAS_SIM_ENABLE_DEPLOYED", previousEnableDeployed);
  restoreEnv("ATLAS_DEPLOYED_BASE_URL", previousDeployedBaseUrl);
  previousEnableDeployed = undefined;
  previousDeployedBaseUrl = undefined;
});

describe("Vite dev proxy", () => {
  it("forwards /api requests to the simulation HTTP server", async () => {
    app = createSimulationServer({
      config: { atlasBaseUrl: "http://127.0.0.1:8000", port: 0, packageRoot },
      store: new RunStore(createFakeAtlasCore().factory)
    });
    const simulationBaseUrl = await app.listen();
    previousSimPort = process.env.ATLAS_SIM_PORT;
    previousEnableDeployed = process.env.ATLAS_SIM_ENABLE_DEPLOYED;
    previousDeployedBaseUrl = process.env.ATLAS_DEPLOYED_BASE_URL;
    process.env.ATLAS_SIM_PORT = new URL(simulationBaseUrl).port;
    process.env.ATLAS_SIM_ENABLE_DEPLOYED = "true";
    process.env.ATLAS_DEPLOYED_BASE_URL = "https://atlas.example.test";

    vite = await createViteServer({
      root: packageRoot,
      configFile: path.join(packageRoot, "vite.config.ts"),
      server: { host: "127.0.0.1", port: 0, strictPort: false }
    });
    await vite.listen();
    const address = vite.httpServer?.address() as AddressInfo | null | undefined;
    expect(address?.port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${address!.port}/api/scenarios`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scenarios: expect.arrayContaining([expect.objectContaining({ id: "moving-assets" })])
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
