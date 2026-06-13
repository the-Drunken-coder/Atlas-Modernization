import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;
const testDir = dirname(fileURLToPath(import.meta.url));
const protocolRevision = readFileSync(join(testDir, "../../atlas_protocol/generated/revision.txt"), "utf8").trim();
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
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/protocol/revision") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ protocol_revision: protocolRevision }));
      return;
    }
    if (req.method === "POST" && req.url === "/tasks") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const task = JSON.parse(body);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          task_id: task.task_id,
          status: task.status ?? "pending",
          entity_id: task.entity_id ?? null,
          components: task.components ?? {},
          ...(task.extra === undefined ? {} : { extra: task.extra }),
          metadata: {
            created_at: "2026-06-12T12:00:00Z",
            updated_at: "2026-06-12T12:00:00Z",
            version: 1
          }
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
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

try {
  tmpdirPath = mkdtempSync(join(tmpdir(), "atlas-sdk-"));
  const packOutput = runStep(`Failed to pack SDK into ${tmpdirPath}`, () => run("npm", ["pack", "--pack-destination", tmpdirPath, "--json", "--silent"]));
  const tarball = join(tmpdirPath, packedTarballName(packOutput));
  const projectDir = join(tmpdirPath, "project");
  mkdirSync(projectDir);
  runStep(`Failed to initialize smoke project at ${projectDir}`, () => run("npm", ["init", "-y", "--silent"], { cwd: projectDir }));
  runStep(`Failed to install SDK tarball ${tarball} into ${projectDir}`, () => run("npm", ["install", tarball, "--silent"], { cwd: projectDir }));

  const helpOutput = runCombined("npx", ["atlas", "--help"], { cwd: projectDir });
  if (!/usage: atlas/i.test(helpOutput)) {
    process.stderr.write(helpOutput);
    throw new Error("installed atlas binary did not print usage");
  }

  await withFakeCore(async (baseUrl) => {
    const task = {
      task_id: "smoke-task"
    };
    const output = await runCombinedAsync("npx", ["atlas", "--base-url", baseUrl, "tasks", "create", JSON.stringify(task)], { cwd: projectDir });
    if (!output.includes('"task_id":"smoke-task"')) {
      process.stderr.write(output);
      throw new Error("installed atlas binary did not run tasks create successfully");
    }
    if (!output.includes('"status":"pending"') || !output.includes('"entity_id":null') || !output.includes('"components":{}')) {
      process.stderr.write(output);
      throw new Error("installed atlas binary did not print Core task create defaults");
    }
  });

  const invalidOutput = runCombined("npx", ["atlas", "not-a-command"], { cwd: projectDir, expectStatus: 2 });
  if (!/usage: invalid command/i.test(invalidOutput)) {
    process.stderr.write(invalidOutput);
    throw new Error("installed atlas binary did not reject invalid command");
  }
} finally {
  if (tmpdirPath) rmSync(tmpdirPath, { recursive: true, force: true });
}
