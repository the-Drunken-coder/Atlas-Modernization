import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../atlas_sdk/", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result.stdout.trim();
}

const temporary = mkdtempSync(join(tmpdir(), "atlas-asset-runtime-"));
try {
  const sdkPack = JSON.parse(run(npm, ["pack", sdkRoot, "--pack-destination", temporary, "--json", "--silent"]));
  const sdkTarball = join(temporary, sdkPack[0].filename);
  const pack = JSON.parse(run(npm, ["pack", root, "--pack-destination", temporary, "--json", "--silent"]));
  const tarball = join(temporary, pack[0].filename);
  const project = join(temporary, "consumer");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ type: "module", private: true }));
  run(npm, ["install", sdkTarball, tarball, "--silent"], project);
  const installed = join(project, "node_modules/@the-drunken-coder/atlas-asset-runtime");
  for (const file of ["README.md", "LICENSE", "package.json", "dist/index.js", "dist/index.d.ts"]) {
    if (!existsSync(join(installed, file))) throw new Error(`packed runtime is missing ${file}`);
  }
  writeFileSync(
    join(project, "smoke.ts"),
    'import { AtlasAssetRuntime, type AtlasAssetRuntimeStatus } from "@the-drunken-coder/atlas-asset-runtime";\nconst status: AtlasAssetRuntimeStatus = "stopped";\nvoid AtlasAssetRuntime;\nvoid status;\n'
  );
  writeFileSync(
    join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, strict: true, target: "ES2022" },
      include: ["smoke.ts"]
    })
  );
  run(process.execPath, [tsc], project);
  writeFileSync(
    join(project, "smoke.mjs"),
    'import { AtlasAssetRuntime } from "@the-drunken-coder/atlas-asset-runtime";\nif (typeof AtlasAssetRuntime !== "function") throw new Error("missing export");\n'
  );
  run(process.execPath, ["smoke.mjs"], project);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
