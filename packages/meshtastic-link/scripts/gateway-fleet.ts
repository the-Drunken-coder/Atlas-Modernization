import { writeFile } from "node:fs/promises";
import { createGatewayFleetExperiment } from "../src/experiments/fleet.js";
import { runSimulatedExperiment } from "../src/experiments/simulated.js";
import { experimentSourceIdentity } from "../src/experiments/source.js";

const [mode, output] = process.argv.slice(2);
if ((mode !== "config" && mode !== "simulate") || !output) {
  throw new Error("Usage: tsx scripts/gateway-fleet.ts <config|simulate> <new-output.json>");
}
const config = createGatewayFleetExperiment();
const result =
  mode === "config"
    ? config
    : {
        ...(await runSimulatedExperiment(config)),
        source: await experimentSourceIdentity()
      };
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });

if ("passed" in result && !result.passed) process.exitCode = 1;
