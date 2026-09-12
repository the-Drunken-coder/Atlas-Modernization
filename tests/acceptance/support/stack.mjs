import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const composeFile = join(repositoryRoot, "tests", "acceptance", "compose.yml");
const commandTimeoutMs = 10 * 60_000;
const readinessTimeoutMs = 90_000;

let activeChild;

export async function runAcceptance({ name, reproduction, run }) {
  const startedAt = new Date();
  const runLabel = acceptanceRunLabel();
  const runID = acceptanceRunID(name, runLabel);
  const project = `atlas_acceptance_${runID.replaceAll("-", "_")}`;
  const artifacts = acceptanceArtifacts(name, runID);
  const commandLog = join(artifacts, "commands.log");
  const evidenceLog = join(artifacts, "evidence.jsonl");
  const credentials = acceptanceCredentials();
  const environment = {
    ...process.env,
    ATLAS_ACCEPTANCE_RUN_ID: runID,
    API_AUTH_KEY: credentials.apiKey,
    ATLAS_ADMIN_PASSWORD: credentials.adminPassword,
    POSTGRES_PASSWORD: credentials.postgresPassword,
    MINIO_ROOT_USER: "atlas",
    MINIO_ROOT_PASSWORD: credentials.minioPassword
  };
  const compose = ["compose", "--ansi", "never", "--project-name", project, "--file", composeFile];
  const revision = await capture("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
  const workingTree = await capture("git", ["status", "--short"], { cwd: repositoryRoot });
  const metadata = {
    scenario: name,
    run_id: runID,
    ...(runLabel ? { run_label: runLabel } : {}),
    compose_project: project,
    revision: revision.trim(),
    working_tree: workingTree.trim() || "clean",
    reproduction,
    started_at: startedAt.toISOString(),
    artifacts
  };
  writeJSON(join(artifacts, "run.json"), { ...metadata, status: "starting" });
  process.stdout.write(
    `Atlas acceptance ${name}\nrevision: ${metadata.revision}${workingTree ? " (working tree has changes)" : ""}\n` +
      `run: ${runID}\nartifacts: ${artifacts}\nreproduce: ${reproduction}\n`
  );

  let ownsProject = false;
  let failure;
  let baseUrl;
  let portReservation;
  let interruptedSignal;
  const interruption = new AbortController();
  const onSignal = (signal) => {
    interruptedSignal = signal;
    interruption.abort(new Error(`acceptance run interrupted by ${signal}`));
    activeChild?.kill("SIGTERM");
  };
  const onInterrupt = () => onSignal("SIGINT");
  const onTerminate = () => onSignal("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  const record = (entry) => {
    const value = { timestamp: new Date().toISOString(), ...entry };
    appendFileSync(evidenceLog, `${JSON.stringify(value)}\n`);
    if (value.passed === false) {
      const error = new Error(`${value.check}: expected ${formatValue(value.expected)}, observed ${formatValue(value.actual)}`);
      error.name = "AcceptanceCheckError";
      error.acceptanceEvidence = value;
      throw error;
    }
    return value;
  };

  try {
    await preflight(commandLog);
    interruption.signal.throwIfAborted();
    portReservation = await reserveLoopbackPort();
    environment.ATLAS_ACCEPTANCE_CORE_PORT = String(portReservation.port);
    ownsProject = true;
    await execute("docker", [...compose, "build", "api"], {
      cwd: repositoryRoot,
      env: environment,
      logPath: commandLog,
      timeoutMs: commandTimeoutMs
    });
    await execute("docker", [...compose, "pull", "postgres", "minio", "minio-init"], {
      cwd: repositoryRoot,
      env: environment,
      logPath: commandLog,
      timeoutMs: commandTimeoutMs
    });
    const port = portReservation.port;
    await portReservation.release();
    portReservation = undefined;
    await execute("docker", [...compose, "up", "--detach", "--no-build"], {
      cwd: repositoryRoot,
      env: environment,
      logPath: commandLog,
      timeoutMs: 120_000
    });
    interruption.signal.throwIfAborted();
    baseUrl = `http://127.0.0.1:${port}`;
    await waitForReadiness(baseUrl, interruption.signal);
    record({ check: "core readiness", expected: 200, actual: 200, passed: true });
    writeJSON(join(artifacts, "stack.json"), {
      run_id: runID,
      compose_project: project,
      core_base_url: baseUrl,
      storage: {
        postgres_volume: `${project}_postgres_data`,
        minio_volume: `${project}_minio_data`
      }
    });

    await run({
      runID,
      baseUrl,
      apiKey: credentials.apiKey,
      admin: { username: "admin", password: credentials.adminPassword },
      artifacts,
      record,
      signal: interruption.signal,
      restartCore: async () => {
        interruption.signal.throwIfAborted();
        const before = (
          await capture("docker", [...compose, "ps", "--quiet", "api"], { cwd: repositoryRoot, env: environment })
        ).trim();
        await execute("docker", [...compose, "restart", "--no-deps", "api"], {
          cwd: repositoryRoot,
          env: environment,
          logPath: commandLog,
          timeoutMs: 120_000
        });
        await waitForReadiness(baseUrl, interruption.signal);
        const after = (
          await capture("docker", [...compose, "ps", "--quiet", "api"], { cwd: repositoryRoot, env: environment })
        ).trim();
        record({
          check: "Core restart retained the acceptance container and project storage",
          expected: { container: before, project },
          actual: { container: after, project },
          passed: before.length > 0 && before === after
        });
      }
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await portReservation?.release();
    } catch (releaseError) {
      failure ??= releaseError;
    }
    if (ownsProject) {
      await collectComposeLogs(compose, environment, artifacts);
      try {
        await execute("docker", [...compose, "down", "--volumes", "--remove-orphans", "--rmi", "local"], {
          cwd: repositoryRoot,
          env: environment,
          logPath: commandLog,
          timeoutMs: 120_000,
          echo: false
        });
      } catch (cleanupError) {
        failure ??= cleanupError;
      }
    }
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }

  if (interruptedSignal) {
    failure ??= new Error(`acceptance run interrupted by ${interruptedSignal}`);
  }
  const completedAt = new Date();
  const result = {
    ...metadata,
    ...(baseUrl ? { core_base_url: baseUrl } : {}),
    status: failure ? "failed" : "passed",
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt.getTime() - startedAt.getTime(),
    ...(failure ? { failure: serializeError(failure) } : {})
  };
  writeJSON(join(artifacts, "result.json"), result);
  if (failure) {
    process.stderr.write(
      `Acceptance failed at revision ${metadata.revision}.\nExpected/actual evidence: ${evidenceLog}\n` +
        `Compose logs: ${join(artifacts, "compose.log")}\nReproduce: ${reproduction}\n`
    );
    throw failure;
  }
  process.stdout.write(`Acceptance passed in ${result.duration_ms} ms. Evidence: ${artifacts}\n`);
  return result;
}

async function preflight(commandLog) {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error(`Node 24 or newer is required; found ${process.version}`);
  }
  await execute("docker", ["version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"], {
    cwd: repositoryRoot,
    logPath: commandLog,
    timeoutMs: 15_000
  });
  await execute("docker", ["compose", "version"], {
    cwd: repositoryRoot,
    logPath: commandLog,
    timeoutMs: 15_000
  });
}

async function waitForReadiness(baseUrl, signal) {
  let lastObservation = "no response";
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`${baseUrl}/readiness`, {
        headers: { Connection: "close" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)])
      });
      lastObservation = `HTTP ${response.status}`;
      if (response.status === 200) return;
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await delay(500, signal);
  }
  throw new Error(`Core readiness expected HTTP 200 within ${readinessTimeoutMs} ms; observed ${lastObservation}`);
}

async function collectComposeLogs(compose, environment, artifacts) {
  try {
    await execute("docker", [...compose, "logs", "--no-color", "--timestamps"], {
      cwd: repositoryRoot,
      env: environment,
      logPath: join(artifacts, "compose.log"),
      timeoutMs: 30_000,
      echo: false
    });
  } catch (error) {
    appendFileSync(join(artifacts, "compose.log"), `Unable to collect Compose logs: ${String(error)}\n`);
  }
}

function execute(command, args, options = {}) {
  return runProcess(command, args, { ...options, capture: false });
}

async function capture(command, args, options = {}) {
  const result = await runProcess(command, args, { ...options, capture: true, echo: false });
  return result.stdout;
}

function runProcess(command, args, options) {
  const { cwd, env, logPath, timeoutMs = 30_000, echo = true, capture: shouldCapture = false } = options;
  if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  const rendered = [command, ...args].join(" ");
  if (logPath) appendFileSync(logPath, `$ ${rendered}\n`);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const append = (stream, chunk) => {
      const value = String(chunk);
      if (shouldCapture) {
        if (stream === "stdout") stdout += value;
        else stderr += value;
      }
      if (logPath) appendFileSync(logPath, value);
      if (echo) (stream === "stdout" ? process.stdout : process.stderr).write(value);
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activeChild === child) activeChild = undefined;
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    child.on("error", (error) => finish(new Error(`failed to run ${rendered}: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish(new Error(`${rendered} exceeded ${timeoutMs} ms`));
        return;
      }
      if (code !== 0) {
        finish(new Error(`${rendered} exited ${code ?? signal ?? "without a status"}${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      finish(undefined, { stdout, stderr });
    });
  });
}

function acceptanceRunID(name, label) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(name)) {
    throw new Error("acceptance scenario name must be 1-40 lowercase letters, digits, or hyphens");
  }
  return `${name}${label ? `-${label}` : ""}-${randomUUID()}`;
}

function acceptanceRunLabel() {
  const requested = process.env.ATLAS_ACCEPTANCE_RUN_LABEL;
  if (!requested) return undefined;
  const normalized = requested
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (!normalized || normalized.length > 24) {
    throw new Error("ATLAS_ACCEPTANCE_RUN_LABEL must normalize to 1-24 lowercase letters, digits, or hyphens");
  }
  return normalized;
}

function acceptanceArtifacts(name, runID) {
  const configured = process.env.ATLAS_ACCEPTANCE_ARTIFACTS;
  const root = configured ? resolve(repositoryRoot, configured) : join(repositoryRoot, ".atlas", "acceptance");
  mkdirSync(join(root, name), { recursive: true });
  const path = join(root, name, runID);
  mkdirSync(path);
  return path;
}

function acceptanceCredentials() {
  return {
    apiKey: `atlas_ak_${randomBytes(32).toString("base64url")}`,
    adminPassword: randomBytes(32).toString("base64url"),
    postgresPassword: randomBytes(24).toString("base64url"),
    minioPassword: randomBytes(24).toString("base64url")
  };
}

function reserveLoopbackPort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPromise(new Error("could not reserve an isolated Core port"));
        return;
      }
      let released = false;
      resolvePromise({
        port: address.port,
        release: () =>
          new Promise((releasePromise, releaseReject) => {
            if (released) {
              releasePromise();
              return;
            }
            released = true;
            server.close((error) => (error ? releaseReject(error) : releasePromise()));
          })
      });
    });
  });
}

function serializeError(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.acceptanceEvidence ? { evidence: error.acceptanceEvidence } : {})
  };
}

function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function formatValue(value) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function delay(milliseconds, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(signal.reason);
    };
    function finish() {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
