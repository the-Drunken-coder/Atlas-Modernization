import { readFileSync } from "node:fs";

const expected = new Map([
  ["main", "./dist/atlas_sdk/src/index.js"],
  ["types", "./dist/atlas_sdk/src/index.d.ts"],
  ['exports["."].import', "./dist/atlas_sdk/src/index.js"],
  ['exports["."].types', "./dist/atlas_sdk/src/index.d.ts"]
]);

const packageJSON = JSON.parse(readFileSync("./package.json", "utf8"));
const actual = new Map([
  ["main", packageJSON.main],
  ["types", packageJSON.types],
  ['exports["."].import', packageJSON.exports?.["."]?.import],
  ['exports["."].types', packageJSON.exports?.["."]?.types]
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
