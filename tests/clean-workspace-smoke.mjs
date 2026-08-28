import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const generatedPaths = [
  "node_modules",
  "packages/sdk/dist",
  "packages/sdk/node_modules",
  "packages/plugin-runtime/dist",
  "packages/plugin-runtime/node_modules",
  "plugins/reference/dist",
  "plugins/reference/node_modules",
  "packages/fieldlink/dist",
  "packages/fieldlink/node_modules",
  "surfaces/command-interface/dist",
  "surfaces/command-interface/node_modules",
  "simulations/dist",
  "simulations/node_modules"
];
const commands = [
  ["ci"],
  ["run", "check", "--workspace", "atlas-fieldlink"],
  ["test", "--workspace", "@the-drunken-coder/atlas-plugin-runtime"],
  ["run", "build", "--workspace", "@the-drunken-coder/atlas-plugin-runtime"],
  ["run", "build", "--workspace", "@the-drunken-coder/atlas-reference-plugin"],
  ["run", "typecheck", "--workspace", "@the-drunken-coder/atlas-command-interface"],
  ["test", "--workspace", "@the-drunken-coder/atlas-command-interface"],
  ["run", "build", "--workspace", "@the-drunken-coder/atlas-command-interface"],
  ["run", "typecheck", "--workspace", "@the-drunken-coder/atlas-simulations"],
  ["test", "--workspace", "@the-drunken-coder/atlas-simulations"],
  ["run", "build", "--workspace", "@the-drunken-coder/atlas-simulations"],
  ["run", "test:package", "--workspace", "@the-drunken-coder/atlas-sdk"]
];

for (const path of generatedPaths) rmSync(path, { recursive: true, force: true });
for (const args of commands) {
  const result = spawnSync(npm, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
