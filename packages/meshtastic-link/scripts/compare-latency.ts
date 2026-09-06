import { open } from "node:fs/promises";
import { createGatewayFleetExperiment } from "../src/experiments/fleet.js";
import { runSimulatedExperiment } from "../src/experiments/simulated.js";
import { experimentSourceIdentity } from "../src/experiments/source.js";

const [output, seeds = "10"] = process.argv.slice(2);
const count = Number(seeds);
if (!output || process.argv.length > 4 || !Number.isInteger(count) || count < 1 || count > 100)
  throw new Error("Usage: tsx scripts/compare-latency.ts <new-output.json> [seed-count: 1–100]");

const source = await experimentSourceIdentity();
const file = await open(output, "wx", 0o600);
const scope = "Same production transports, schedules and seeded identities. Modeled RF, not physical radios.";
await file.write(`{"source":${JSON.stringify(source)},"scope":${JSON.stringify(scope)},"results":[\n`);
let first = true;
const profiles = [
  { name: "previous", frame_encoding: "deflate-v3", adaptive_retries: false, state_deltas: false },
  { name: "binary", frame_encoding: "binary-v1", adaptive_retries: false, state_deltas: false },
  { name: "binary-retries", frame_encoding: "binary-v1", adaptive_retries: true, state_deltas: false },
  { name: "binary-deltas", frame_encoding: "binary-v1", adaptive_retries: false, state_deltas: true },
  { name: "all", frame_encoding: "binary-v1", adaptive_retries: true, state_deltas: true }
] as const;
try {
  for (const commandsPerAsset of [false, true]) {
    for (const preset of ["SHORT_FAST", "SHORT_TURBO"] as const) {
      for (let seed = 1; seed <= count; seed++) {
        for (const profile of profiles) {
          const { name, ...options } = profile;
          const result = await runSimulatedExperiment(
            { ...createGatewayFleetExperiment({ commandsPerAsset }), ...options, preset },
            seed
          );
          // Stream each run so large comparisons never need one enormous JSON string.
          await file.write(
            `${first ? "" : ",\n"}${JSON.stringify({ profile: name, commands_per_asset: commandsPerAsset, ...result })}`
          );
          first = false;
          console.log(
            JSON.stringify({
              profile: name,
              commands_per_asset: commandsPerAsset,
              preset,
              seed,
              exchanges: result.outcomes.exchanges.filter((exchange) => exchange.completed_within_deadline).length,
              expected: result.outcomes.exchanges.length,
              confirmed: result.outcomes.summary.confirmed_messages,
              transmissions: result.network.mesh_transmissions,
              airtime_ms: result.network.modeled_airtime_ms
            })
          );
        }
      }
    }
  }
  await file.write("\n]}\n");
} finally {
  await file.close();
}
