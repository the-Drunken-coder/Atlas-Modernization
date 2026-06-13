import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptDir, "..");
const packageJSON = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (typeof packageJSON.bin?.atlas !== "string" || packageJSON.bin.atlas.trim() === "") {
  console.error("::error::package.json is missing bin.atlas");
  process.exit(1);
}
const cliModuleURL = pathToFileURL(join(packageRoot, packageJSON.bin.atlas)).href;
let cliModule;
try {
  cliModule = await import(cliModuleURL);
} catch (error) {
  console.error(`::error::Failed to import CLI module from ${packageJSON.bin.atlas} (${cliModuleURL}): ${errorMessage(error)}`);
  process.exit(1);
}

if (typeof cliModule.PACKAGE_NAME !== "string") {
  console.error("::error::CLI module does not export PACKAGE_NAME as a string");
  process.exit(1);
}
if (typeof cliModule.PACKAGE_BIN !== "object" || cliModule.PACKAGE_BIN === null) {
  console.error("::error::CLI module does not export PACKAGE_BIN as an object");
  process.exit(1);
}
if (typeof cliModule.PACKAGE_BIN.atlas !== "string") {
  console.error("::error::CLI module does not export PACKAGE_BIN.atlas as a string");
  process.exit(1);
}

const expected = new Map([
  ["name", "@the-drunken-coder/atlas-sdk"],
  ["main", "./dist/atlas_sdk/src/index.js"],
  ["types", "./dist/atlas_sdk/src/index.d.ts"],
  ['exports["."].import', "./dist/atlas_sdk/src/index.js"],
  ['exports["."].types', "./dist/atlas_sdk/src/index.d.ts"],
  ['bin["atlas"]', "./dist/atlas_sdk/src/cli.js"],
  ["cli PACKAGE_NAME", packageJSON.name],
  ["cli PACKAGE_BIN.atlas", packageJSON.bin?.atlas]
]);

const actual = new Map([
  ["name", packageJSON.name],
  ["main", packageJSON.main],
  ["types", packageJSON.types],
  ['exports["."].import', packageJSON.exports?.["."]?.import],
  ['exports["."].types', packageJSON.exports?.["."]?.types],
  ['bin["atlas"]', packageJSON.bin?.atlas],
  ["cli PACKAGE_NAME", cliModule.PACKAGE_NAME],
  ["cli PACKAGE_BIN.atlas", cliModule.PACKAGE_BIN?.atlas]
]);

let failed = false;
for (const [field, want] of expected) {
  const got = actual.get(field);
  if (got !== want) {
    console.error(`::error::${field} expected ${want} but found ${String(got)}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
