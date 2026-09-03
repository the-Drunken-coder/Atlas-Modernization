import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 60_000;
const PACKAGE_INSTALL_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 2_000;
const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(testDir);
const protocolRevision = readFileSync(join(testDir, "../../protocol/generated/revision.txt"), "utf8").trim();
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const staleDistSentinel = join(packageRoot, "dist/stale-package-output.txt");
const typeScriptCLI = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc");
let tmpdirPath;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: "pipe",
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS
  });
  if (result.status === null) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.error) process.stderr.write(`${result.error}\n`);
    throw new Error(`${command} ${args.join(" ")} failed to spawn`);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function runCombined(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: "pipe",
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === null) {
    process.stderr.write(output);
    if (result.error) process.stderr.write(`${result.error}\n`);
    throw new Error(`${command} ${args.join(" ")} failed to spawn`);
  }
  if (options.expectStatus !== undefined && result.status !== options.expectStatus) {
    process.stderr.write(output);
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status}, want ${options.expectStatus}`);
  }
  if (options.expectStatus === undefined && result.status !== 0) {
    process.stderr.write(output);
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status}`);
  }
  return output;
}

function runStep(description, callback) {
  try {
    return callback();
  } catch (error) {
    throw new Error(`${description}: ${errorMessage(error)}`);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runCombinedAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let killTimer;
    let timeout;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      callback();
    };
    timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`${command} ${args.join(" ")} timed out`));
    }, options.timeout ?? DEFAULT_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      finish(() => {
        process.stderr.write(output);
        reject(error);
      });
    });
    child.on("close", (code) => {
      if (settled) {
        clearTimeout(killTimer);
        return;
      }
      finish(() => {
        if (options.expectStatus !== undefined && code !== options.expectStatus) {
          process.stderr.write(output);
          reject(new Error(`${command} ${args.join(" ")} exited with code ${code}, want ${options.expectStatus}`));
          return;
        }
        if (options.expectStatus === undefined && code !== 0) {
          process.stderr.write(output);
          reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
          return;
        }
        resolve(output);
      });
    });
  });
}

function packedTarballName(packOutput) {
  try {
    const entries = JSON.parse(packOutput);
    const filename = entries.find((entry) => typeof entry?.filename === "string")?.filename;
    if (filename) return filename;
  } catch {
    const matches = [...packOutput.matchAll(/[^\s]+\.tgz/g)].map((match) => match[0]);
    if (matches.length > 0) return matches.at(-1);
  }
  throw new Error(`npm pack did not report a tarball name: ${JSON.stringify(packOutput)}`);
}

async function withFakeCore(callback) {
  const seenApiKeys = [];
  const seenIdempotencyKeys = [];
  const server = createServer(async (req, res) => {
    const apiKey = req.headers["x-api-key"];
    seenApiKeys.push(Array.isArray(apiKey) ? apiKey.join(",") : (apiKey ?? null));
    const idempotencyKey = req.headers["idempotency-key"];
    seenIdempotencyKeys.push(Array.isArray(idempotencyKey) ? idempotencyKey.join(",") : (idempotencyKey ?? null));
    if (req.method === "GET" && req.url === "/protocol/revision") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ protocol_revision: protocolRevision }));
      return;
    }
    if (req.method === "POST" && req.url === "/tasks") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let task;
      try {
        task = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: false, message: "Invalid JSON body", error_code: "INVALID_JSON" }));
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.setHeader("ETag", '"v1"');
      res.end(
        JSON.stringify({
          task_id: "smoke-task",
          asset_id: task.asset_id,
          command: task.command,
          input: task.input,
          status: "pending",
          created_at: "2026-06-12T12:00:00Z",
          updated_at: "2026-06-12T12:00:00Z"
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`, seenApiKeys, seenIdempotencyKeys);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

try {
  tmpdirPath = mkdtempSync(join(tmpdir(), "atlas-sdk-"));
  mkdirSync(dirname(staleDistSentinel), { recursive: true });
  writeFileSync(staleDistSentinel, "prepack must remove this file\n");
  const packOutput = runStep(`Failed to pack SDK into ${tmpdirPath}`, () =>
    run(npmCommand, ["pack", packageRoot, "--pack-destination", tmpdirPath, "--json", "--silent"])
  );
  const tarball = join(tmpdirPath, packedTarballName(packOutput));
  const projectDir = join(tmpdirPath, "project");
  mkdirSync(projectDir);
  runStep(`Failed to initialize smoke project at ${projectDir}`, () =>
    run(npmCommand, ["init", "-y", "--silent"], { cwd: projectDir })
  );
  runStep(`Failed to install SDK tarball ${tarball} into ${projectDir}`, () =>
    run(npmCommand, ["install", tarball, "--silent", "--no-audit", "--no-fund"], {
      cwd: projectDir,
      timeout: PACKAGE_INSTALL_TIMEOUT_MS
    })
  );
  const installedPackageRoot = join(projectDir, "node_modules/@the-drunken-coder/atlas-sdk");
  if (existsSync(join(installedPackageRoot, "dist/stale-package-output.txt"))) {
    throw new Error("prepack included stale dist output in the installed package");
  }
  for (const filename of ["README.md", "LICENSE", "package.json"]) {
    if (!existsSync(join(installedPackageRoot, filename))) {
      throw new Error(`installed package is missing ${filename}`);
    }
  }
  const installedPackageJSON = JSON.parse(readFileSync(join(installedPackageRoot, "package.json"), "utf8"));
  for (const field of [
    "name",
    "version",
    "description",
    "author",
    "license",
    "repository",
    "homepage",
    "bugs",
    "publishConfig",
    "exports",
    "bin"
  ]) {
    if (installedPackageJSON[field] === undefined) {
      throw new Error(`installed package.json is missing ${field}`);
    }
  }
  const installedBin = join(projectDir, "node_modules/.bin", process.platform === "win32" ? "atlas.cmd" : "atlas");
  if (!existsSync(installedBin)) {
    throw new Error("npm did not install the atlas binary from package.json bin metadata");
  }
  const atlasCLI = join(installedPackageRoot, installedPackageJSON.bin.atlas);

  const rootImportOutput = runCombined(
    "node",
    [
      "--input-type=module",
      "-e",
      "import('@the-drunken-coder/atlas-sdk').then((m) => console.log(JSON.stringify({ client: typeof m.AtlasClient, revision: m.ATLAS_PROTOCOL_REVISION, validTask: m.isTaskCreateRequest({ asset_id: 'asset-smoke', command: 'smoke.inspect', input: {} }) })))"
    ],
    { cwd: projectDir }
  );
  const rootImport = JSON.parse(rootImportOutput);
  if (rootImport.client !== "function" || rootImport.revision !== protocolRevision || rootImport.validTask !== true) {
    throw new Error(`installed root export or generated protocol artifact is invalid: ${rootImportOutput}`);
  }

  const adminImportOutput = runCombined(
    "node",
    [
      "--input-type=module",
      "-e",
      "import('@the-drunken-coder/atlas-sdk/admin').then((m) => console.log(typeof m.AtlasAdminClient))"
    ],
    {
      cwd: projectDir
    }
  );
  if (!adminImportOutput.includes("function")) {
    process.stderr.write(adminImportOutput);
    throw new Error("installed package did not expose ./admin AtlasAdminClient through package exports");
  }

  const typeConsumer = join(projectDir, "consumer.mts");
  writeFileSync(
    typeConsumer,
    `import { AtlasClient, ATLAS_PROTOCOL_REVISION, isTaskCreateRequest, type EntityResource } from "@the-drunken-coder/atlas-sdk";
import { AtlasAdminClient, type AdminAPIKey } from "@the-drunken-coder/atlas-sdk/admin";

const clientConstructor: typeof AtlasClient = AtlasClient;
const adminConstructor: typeof AtlasAdminClient = AtlasAdminClient;
const revision: string = ATLAS_PROTOCOL_REVISION;
const entity: EntityResource | undefined = undefined;
const apiKey: AdminAPIKey | undefined = undefined;
const validTask: boolean = isTaskCreateRequest({ asset_id: "asset-smoke", command: "smoke.inspect", input: {} });
void [clientConstructor, adminConstructor, revision, entity, apiKey, validTask];
`
  );
  runStep("Installed package TypeScript declarations did not compile", () =>
    run(
      process.execPath,
      [
        typeScriptCLI,
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--lib",
        "ES2022,DOM",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        typeConsumer
      ],
      {
        cwd: projectDir
      }
    )
  );

  const helpOutput = runCombined(process.execPath, [atlasCLI, "--help"], { cwd: projectDir });
  if (!/usage: atlas/i.test(helpOutput)) {
    process.stderr.write(helpOutput);
    throw new Error("installed atlas binary did not print usage");
  }

  await withFakeCore(async (baseUrl, seenApiKeys, seenIdempotencyKeys) => {
    const task = {
      asset_id: "asset-smoke",
      command: "smoke.inspect",
      input: { target: "camera-1" }
    };
    const output = await runCombinedAsync(
      process.execPath,
      [
        atlasCLI,
        "--base-url",
        baseUrl,
        "--api-key",
        "smoke-key",
        "--idempotency-key",
        "smoke-attempt",
        "tasks",
        "create",
        JSON.stringify(task)
      ],
      {
        cwd: projectDir
      }
    );
    if (!output.includes('"task_id":"smoke-task"')) {
      process.stderr.write(output);
      throw new Error("installed atlas binary did not run tasks create successfully");
    }
    if (
      !output.includes('"status":"pending"') ||
      !output.includes('"asset_id":"asset-smoke"') ||
      !output.includes('"command":"smoke.inspect"')
    ) {
      process.stderr.write(output);
      throw new Error("installed atlas binary did not print Core task create defaults");
    }
    if (!seenApiKeys.includes("smoke-key")) {
      throw new Error("installed atlas binary did not send --api-key as X-API-Key");
    }
    if (!seenIdempotencyKeys.includes("smoke-attempt")) {
      throw new Error("installed atlas binary did not send --idempotency-key as Idempotency-Key");
    }
  });

  runCombined(process.execPath, [atlasCLI, "not-a-command"], { cwd: projectDir, expectStatus: 2 });
} finally {
  rmSync(staleDistSentinel, { force: true });
  if (tmpdirPath) rmSync(tmpdirPath, { recursive: true, force: true });
}
