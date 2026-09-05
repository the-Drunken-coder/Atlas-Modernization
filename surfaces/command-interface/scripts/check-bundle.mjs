import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const packageName = "@the-drunken-coder/atlas-command-interface";
const defaultOutputDir = resolve(packageRoot, "dist/client");
const args = new Set(process.argv.slice(2));
const outputArgIndex = process.argv.indexOf("--output-dir");
const outputDir = resolve(packageRoot, outputArgIndex === -1 ? defaultOutputDir : process.argv[outputArgIndex + 1]);

const budgets = {
  // Blueprint Core is a deliberate shell dependency. These limits include its
  // shared component styles and icon-path chunks. Map budgets remain scoped separately.
  // SDK point-read generations and local-delete guards add 3.54 kB raw to the
  // initial graph. Keep enough gzip margin for Node's platform zlib variance.
  initialJavaScript: { raw: 418_000, gzip: 128_000 },
  initialCss: { raw: 510_000, gzip: 55_000 },
  // MapWindowWorkspace coordinates four ordered edge rails for the map shell.
  shellJavaScript: { raw: 142_500, gzip: 47_500 },
  // Vertex keyboard controls, focus restoration, and heartbeat-qualified symbols
  // add 2.14 kB raw / 0.79 kB gzip compared with the 0cb16dcb build.
  mapViewJavaScript: { raw: 73_250, gzip: 22_250 },
  mapLibreJavaScript: { raw: 1_100_000, gzip: 300_000 },
  mapLibreWorkerJavaScript: { raw: 500_000, gzip: 140_000 },
  milsymbolJavaScript: { raw: 900_000, gzip: 240_000 },
  mapLibreCss: { raw: 85_000, gzip: 11_000 },
  mapRoute: { raw: 2_100_000, gzip: 550_000 },
  // Command and geometry fixes add 2.99 kB raw JS and 0.59 kB raw CSS
  // compared with 0cb16dcb. Keep the existing aggregate JS gzip ceiling.
  allJavaScript: { raw: 3_620_000, gzip: 1_000_000 },
  allCss: { raw: 601_000, gzip: 66_250 }
};

if (!args.has("--skip-build")) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const build = spawnSync(npmCommand, ["run", "build", "--workspace", packageName], {
    cwd: repositoryRoot,
    stdio: "inherit"
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const manifestPath = [resolve(outputDir, "..", "bundle-manifest.json")].find((path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
});
if (!manifestPath) fail(`Missing bundle analysis manifest beside ${outputDir}`);

const publicManifest = [join(outputDir, "manifest.json"), join(outputDir, ".vite", "manifest.json")].find((path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
});
if (publicManifest) fail(`Vite manifest must not be deployed from ${publicManifest}`);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const manifestFiles = new Set();
for (const entry of Object.values(manifest)) collectManifestFiles(entry, manifestFiles);

const emittedFiles = walk(outputDir).map((path) => relative(outputDir, path));
const assetFiles = emittedFiles.filter((file) => file.startsWith("assets/") && /\.(?:js|css)$/.test(file));
const mapLibreWorkerFiles = new Set(assetFiles.filter((file) => /^assets\/maplibre-gl-worker-[^/]+\.js$/.test(file)));
if (mapLibreWorkerFiles.size !== 1) fail(`Expected one MapLibre worker asset, found ${mapLibreWorkerFiles.size}`);
const unbudgetedFiles = assetFiles.filter((file) => !manifestFiles.has(file) && !mapLibreWorkerFiles.has(file));
if (unbudgetedFiles.length > 0) fail(`Unbudgeted emitted JS/CSS assets: ${unbudgetedFiles.join(", ")}`);

const records = new Map(assetFiles.map((file) => [file, measure(resolve(outputDir, file))]));
const entry = manifest["index.html"];
const shell = manifest["src/features/MapConsole.tsx"];
const mapView = manifest["src/ui/map/view/MapView.tsx"];
if (!entry || !shell || !mapView) fail("Manifest is missing the index, MapConsole, or MapView entry");

const initialFiles = uniqueFiles(entry, manifest);
const shellFiles = uniqueFiles(shell, manifest).difference(initialFiles);
const mapRouteFiles = uniqueFiles(mapView, manifest)
  .union(mapLibreWorkerFiles)
  .difference(initialFiles)
  .difference(shellFiles);
const allJavaScript = selectByExtension(records, ".js");
const allCss = selectByExtension(records, ".css");
const failures = [];

const checks = [
  checkGroup("initialJavaScript", selectByExtension(selectRecords(records, initialFiles), ".js")),
  checkGroup("initialCss", selectByExtension(selectRecords(records, initialFiles), ".css")),
  checkGroup("shellJavaScript", selectByExtension(selectRecords(records, shellFiles), ".js")),
  checkGroup("mapViewJavaScript", selectByExtension(selectRecords(records, new Set([mapView.file])), ".js")),
  checkGroup("mapLibreJavaScript", excludeFiles(findByName(records, "maplibre-gl", ".js"), mapLibreWorkerFiles)),
  checkGroup("mapLibreWorkerJavaScript", selectRecords(records, mapLibreWorkerFiles)),
  checkGroup("milsymbolJavaScript", findByName(records, "milsymbol", ".js")),
  checkGroup("mapLibreCss", findByName(records, "maplibre-gl", ".css")),
  checkGroup("mapRoute", selectRecords(records, mapRouteFiles)),
  checkGroup("allJavaScript", allJavaScript),
  checkGroup("allCss", allCss)
];

console.log("Bundle asset inventory (all emitted JS/CSS assets)");
for (const file of [...records.keys()].sort()) {
  const record = records.get(file);
  console.log(`  ${file.padEnd(52)} ${format(record.raw).padStart(10)} raw  ${format(record.gzip).padStart(10)} gzip`);
}
console.log("Bundle budget results");
for (const check of checks) {
  const budget = budgets[check.name];
  const rawHeadroom = budget.raw - check.raw;
  const gzipHeadroom = budget.gzip - check.gzip;
  console.log(
    `  ${check.name.padEnd(22)} ${format(check.raw)} / ${format(budget.raw)} raw (${formatHeadroom(rawHeadroom)})  ${format(check.gzip)} / ${format(budget.gzip)} gzip (${formatHeadroom(gzipHeadroom)})`
  );
  if (rawHeadroom < 0 || gzipHeadroom < 0) {
    failures.push(`${check.name} exceeded budget`);
  }
}

if (failures.length > 0) fail(failures.join("; "));

function collectManifestFiles(value, files) {
  if (!value || typeof value !== "object") return;
  if (typeof value.file === "string") files.add(value.file);
  for (const key of ["css", "assets"]) {
    if (Array.isArray(value[key])) for (const file of value[key]) if (typeof file === "string") files.add(file);
  }
}

function uniqueFiles(entry, entries) {
  const files = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || files.has(current.file)) continue;
    files.add(current.file);
    for (const css of current.css ?? []) files.add(css);
    for (const asset of current.assets ?? []) files.add(asset);
    for (const imported of current.imports ?? []) pending.push(entries[imported]);
  }
  return files;
}

function selectRecords(records, files) {
  return new Map([...files].flatMap((file) => (records.has(file) ? [[file, records.get(file)]] : [])));
}

function selectByExtension(records, extension) {
  return new Map([...records].filter(([file]) => file.endsWith(extension)));
}

function excludeFiles(records, excluded) {
  return new Map([...records].filter(([file]) => !excluded.has(file)));
}

function findByName(records, name, extension) {
  return new Map([...records].filter(([file]) => file.includes(name) && file.endsWith(extension)));
}

function checkGroup(name, selected) {
  return {
    name,
    raw: sum(selected, "raw"),
    gzip: sum(selected, "gzip")
  };
}

function sum(records, field) {
  return [...records.values()].reduce((total, record) => total + record[field], 0);
}

function measure(path) {
  const content = readFileSync(path);
  return { raw: content.byteLength, gzip: gzipSync(content, { level: 9, mtime: 0 }).byteLength };
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function format(value) {
  return `${(value / 1000).toFixed(2)} kB`;
}

function formatHeadroom(value) {
  return `${value >= 0 ? "+" : ""}${format(value)}`;
}

function fail(message) {
  console.error(`Bundle budget failed: ${message}`);
  process.exit(1);
}
