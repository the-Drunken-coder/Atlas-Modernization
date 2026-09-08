import { writeFile } from "node:fs/promises";
import { runCanonicalBaseline, runFirstVerticalSlice, runStressBaseline } from "../src/benchmark.js";

const baselines = [
  ["first-position-v1-seed-42.json", await runFirstVerticalSlice(42)],
  ["canonical-json-v4-seed-42.json", await runCanonicalBaseline(42)],
  ["canonical-json-stress-v3-seed-42.json", await runStressBaseline(42)]
] as const;

await Promise.all(
  baselines.map(([name, result]) =>
    writeFile(new URL(`../baselines/${name}`, import.meta.url), `${JSON.stringify(result, null, 2)}\n`, "utf8")
  )
);
