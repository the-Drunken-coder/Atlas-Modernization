import { createSimulationServer, loadConfig } from "@the-drunken-coder/atlas-simulations/server";

const packageRoot = process.env.ATLAS_ACCEPTANCE_SIMULATION_PACKAGE_ROOT;
if (!packageRoot) {
  throw new Error("ATLAS_ACCEPTANCE_SIMULATION_PACKAGE_ROOT is required for simulation acceptance");
}

const server = createSimulationServer({
  config: loadConfig({ env: process.env, packageRoot }),
});

server
  .listen()
  .then((url) => {
    console.log(`Atlas Simulations server listening on ${url}`);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
