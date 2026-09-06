import { writeFile } from "node:fs/promises";
import { createGatewayFleetExperiment } from "../src/experiments/fleet.js";
import { runSimulatedExperiment } from "../src/experiments/simulated.js";
import { experimentSourceIdentity } from "../src/experiments/source.js";

const [output, seeds = "10"] = process.argv.slice(2);
const seedCount = Number(seeds);
if (!output || process.argv.length > 4 || !Number.isInteger(seedCount) || seedCount < 1 || seedCount > 100)
  throw new Error("Usage: tsx scripts/compare-fleet.ts <new-output.json> [seed-count: 1–100]");

const source = await experimentSourceIdentity();
const results = [];
for (const preset of ["SHORT_FAST", "SHORT_TURBO"] as const) {
  for (let seed = 1; seed <= seedCount; seed++) {
    for (const frame_encoding of ["deflate-v2", "deflate-v3"] as const) {
      const result = await runSimulatedExperiment({ ...createGatewayFleetExperiment(), preset, frame_encoding }, seed);
      results.push(result);
      console.log(
        JSON.stringify({
          preset,
          seed,
          frame_encoding,
          exchanges: result.outcomes.exchanges.filter((exchange) => exchange.completed_within_deadline).length,
          confirmed: result.outcomes.summary.confirmed_messages,
          delivered: result.outcomes.summary.delivered_messages,
          transmissions: result.network.mesh_transmissions,
          airtime_ms: result.network.modeled_airtime_ms
        })
      );
    }
  }
}
await writeFile(
  output,
  `${JSON.stringify(
    {
      source,
      scope:
        "Same current implementation and seeded identities; only transmission encoding changes. Modeled RF, not physical radios.",
      results
    },
    null,
    2
  )}\n`,
  { flag: "wx", mode: 0o600 }
);
