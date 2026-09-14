import { createAtlasClientFactory } from "../../../../simulations/src/server/atlas.ts";
import { loadConfig } from "../../../../simulations/src/server/config.ts";
import { createSimulationServer } from "../../../../simulations/src/server/index.ts";

const packageRoot = process.env.ATLAS_ACCEPTANCE_SIMULATION_PACKAGE_ROOT;
if (!packageRoot) {
  throw new Error(
    "ATLAS_ACCEPTANCE_SIMULATION_PACKAGE_ROOT is required for simulation acceptance",
  );
}

const config = loadConfig({ env: process.env, packageRoot });
const localTarget = config.atlasTargets.find((target) => target.id === "local");
if (!localTarget)
  throw new Error("Late-assertion acceptance requires the local target");

const realClientFactory = createAtlasClientFactory(localTarget);
let clientCount = 0;
localTarget.clientFactory = (options) => {
  const client = realClientFactory(options);
  clientCount += 1;
  if (clientCount !== 2) return client;
  let firstRead = true;
  return {
    ...client,
    entities: {
      ...client.entities,
      get: async (...args) => {
        if (!firstRead) return client.entities.get(...args);
        firstRead = false;
        const pending = client.entities.get(...args).then(
          (value) => ({ kind: "value", value }),
          (error) => ({ kind: "error", error }),
        );
        await waitForStopAbort(options?.signal);
        const result = await pending;
        if (result.kind === "error") throw result.error;
        return result.value;
      },
    },
  };
};

const server = createSimulationServer({ config });

server
  .listen()
  .then((url) => {
    console.log(`Atlas Simulations server listening on ${url}`);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });

function waitForStopAbort(signal) {
  if (!signal)
    throw new Error("Late-assertion verifier client requires an AbortSignal");
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timeout;
    const finish = (settle) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => {
      finish(resolve);
    };
    timeout = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            "Late-assertion verifier read was not stopped within 3000ms",
          ),
        ),
      );
    }, 3_000);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
