import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const generatedPaths = [
  "node_modules",
  "atlas_sdk/dist",
  "atlas_sdk/node_modules",
  "atlas_command_interface/dist",
  "atlas_command_interface/node_modules",
  "atlas_simulations/dist",
  "atlas_simulations/node_modules"
];
const commands = [
  ["ci"],
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
