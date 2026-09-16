import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const patches = [
  {
    dependency: "@meshtastic/core",
    version: "2.6.7",
    file: "@meshtastic+core+2.6.7.patch"
  }
];

for (const patch of patches) {
  const packagePath = join(repositoryRoot, "node_modules", patch.dependency, "package.json");
  const installed = JSON.parse(readFileSync(packagePath, "utf8"));
  if (installed.version !== patch.version) {
    throw new Error(
      `Refusing to patch ${patch.dependency} ${installed.version}; expected ${patch.version}. Review whether the patch is still needed.`
    );
  }

  const patchPath = join(repositoryRoot, "patches", patch.file);
  const applyArguments = ["--ignore-space-change", "--unsafe-paths", patchPath];
  if (patchApplies(["--reverse", "--check", ...applyArguments])) continue;
  runGit(["apply", "--check", ...applyArguments]);
  runGit(["apply", ...applyArguments]);
  console.log(`Applied ${patch.file}`);
}

function patchApplies(args) {
  try {
    runGit(["apply", ...args]);
    return true;
  } catch {
    return false;
  }
}

function runGit(args) {
  execFileSync("git", args, { cwd: repositoryRoot, stdio: "pipe" });
}
