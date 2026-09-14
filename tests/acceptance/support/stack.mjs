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
const fixtureHookTimeoutMs = 120_000;
const coreStartupAttempts = 2;
const runnerOwnedEnvironmentKeys = new Set([
  "ATLAS_ACCEPTANCE_RUN_ID",
  "API_AUTH_KEY",
  "ATLAS_ADMIN_PASSWORD",
  "POSTGRES_PASSWORD",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "ATLAS_ACCEPTANCE_CORE_PORT"
]);

let activeChild;

export async function runAcceptance({
  name,
  reproduction,
  run,
  additionalComposeFiles = [],
  fixtureVariant,
  prepare
}) {
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
  const compose = [
    "compose",
    "--ansi",
    "never",
    "--project-name",
    project,
    "--file",
    composeFile,
    ...additionalComposeFiles.flatMap((path) => ["--file", resolve(repositoryRoot, path)])
  ];
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
  process.stdout.write(
    `Atlas acceptance ${name}\nrevision: ${metadata.revision}${workingTree ? " (working tree has changes)" : ""}\n` +
      `run: ${runID}\nartifacts: ${artifacts}\nreproduce: ${reproduction}\n`
  );

  let ownsProject = false;
  let failure;
  let fixtureCleanupFailure;
  let baseUrl;
  let initialPortReservation;
  let preparation;
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
    writeJSON(join(artifacts, "run.json"), { ...metadata, status: "starting" });
    if (fixtureVariant !== undefined) {
      metadata.fixture_variant = cloneJSONValue(fixtureVariant, "fixture variant");
      writeJSON(join(artifacts, "run.json"), { ...metadata, status: "starting" });
    }
    preparation = await runFixtureHook(
      "fixture preparation",
      prepare ? (signal) => prepare({ artifacts, runID, signal }) : undefined,
      interruption.signal
    );
    if (preparation?.environment) {
      const reservedKeys = Object.keys(preparation.environment).filter((key) => runnerOwnedEnvironmentKeys.has(key));
      if (reservedKeys.length > 0) {
        throw new Error(`fixture environment cannot override runner-owned keys: ${reservedKeys.join(", ")}`);
      }
      Object.assign(environment, preparation.environment);
    }
    if (preparation?.metadata !== undefined) {
      metadata.fixture = cloneJSONValue(preparation.metadata, "fixture metadata");
      writeJSON(join(artifacts, "run.json"), { ...metadata, status: "prepared" });
    }
    await preflight(commandLog);
    interruption.signal.throwIfAborted();
    initialPortReservation = await reserveLoopbackPort();
    environment.ATLAS_ACCEPTANCE_CORE_PORT = String(initialPortReservation.port);
    const composeConfig = await capture("docker", [...compose, "config", "--format", "json"], {
      cwd: repositoryRoot,
      env: environment,
      logPath: commandLog,
      timeoutMs: 30_000
    });
    validateComposeConfig(JSON.parse(composeConfig), { project, corePort: initialPortReservation.port });
    ownsProject = true;
    await execute("docker", [...compose, "build"], {
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
    baseUrl = await startCore(compose, environment, commandLog, interruption.signal, record, initialPortReservation);
    interruption.signal.throwIfAborted();
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
      await initialPortReservation?.release();
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
    try {
      await runFixtureHook(
        "fixture cleanup",
        preparation?.cleanup ? (signal) => preparation.cleanup({ signal }) : undefined
      );
    } catch (cleanupError) {
      fixtureCleanupFailure ??= cleanupError;
      failure ??= cleanupError;
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
    ...(failure ? { failure: serializeError(failure) } : {}),
    ...(fixtureCleanupFailure ? { fixture_cleanup_failure: serializeError(fixtureCleanupFailure) } : {})
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

async function startCore(compose, environment, commandLog, signal, record, initialPortReservation) {
  for (let attempt = 1; attempt <= coreStartupAttempts; attempt++) {
    signal.throwIfAborted();
    const portReservation = attempt === 1 ? initialPortReservation : await reserveLoopbackPort();
    const port = portReservation.port;
    environment.ATLAS_ACCEPTANCE_CORE_PORT = String(port);
    await portReservation.release();

    try {
      await runProcess("docker", [...compose, "up", "--detach", "--no-build"], {
        cwd: repositoryRoot,
        env: environment,
        logPath: commandLog,
        timeoutMs: 120_000,
        capture: true
      });
      return `http://127.0.0.1:${port}`;
    } catch (error) {
      if (attempt === coreStartupAttempts || !isPortBindConflict(error, port)) throw error;
      record({
        check: "Core startup retried after a recognized loopback port bind conflict",
        expected: { attempts: coreStartupAttempts, conflict_port: port },
        actual: { attempt, conflict_port: port, error: errorMessage(error) },
        passed: true
      });
      await execute("docker", [...compose, "down", "--volumes", "--remove-orphans"], {
        cwd: repositoryRoot,
        env: environment,
        logPath: commandLog,
        timeoutMs: 120_000,
        echo: false
      });
    }
  }
  throw new Error("Core startup exhausted its recognized port bind retries");
}

export async function runFixtureHook(label, hook, parentSignal) {
  if (!hook) return undefined;
  const timeoutController = new AbortController();
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`${label} exceeded ${fixtureHookTimeoutMs} ms`);
      timeoutController.abort(error);
      reject(error);
    }, fixtureHookTimeoutMs);
  });
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutController.signal]) : timeoutController.signal;
  try {
    return await Promise.race([Promise.resolve().then(() => hook(signal)), timeoutPromise]);
  } finally {
    clearTimeout(timeout);
    timeoutController.abort();
  }
}

export function cloneJSONValue(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
  if (serialized === undefined) throw new Error(`${label} must be valid JSON`);
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
}

export function validateComposeConfig(config, { project, corePort }) {
  if (!config || typeof config !== "object" || config.name !== project) {
    throw new Error("acceptance Compose config must retain the runner project name");
  }
  const services = config.services;
  if (!services || typeof services !== "object" || !services.api) {
    throw new Error("acceptance Compose config must define the api service");
  }
  const apiPorts = services.api.ports ?? [];
  if (apiPorts.length !== 1 || !isRunnerCorePort(apiPorts[0], corePort)) {
    throw new Error("acceptance Compose config must publish only the runner-owned Core port");
  }
  const projectPrefix = `${project}_`;
  const declaredVolumes = config.volumes ?? {};
  for (const [serviceName, service] of Object.entries(services)) {
    if (service.container_name || service.network_mode === "host" || service.pid === "host" || service.ipc === "host") {
      throw new Error(`acceptance Compose service ${serviceName} escapes runner ownership`);
    }
    if (serviceName !== "api" && (service.ports?.length ?? 0) > 0) {
      throw new Error(`acceptance Compose service ${serviceName} cannot publish a host port`);
    }
    if ((service.devices?.length ?? 0) > 0) {
      throw new Error(`acceptance Compose service ${serviceName} cannot attach host devices`);
    }
    for (const volume of service.volumes ?? []) {
      if (volume.type === "bind") throw new Error(`acceptance Compose service ${serviceName} cannot bind host paths`);
      if (volume.type === "volume" && !Object.hasOwn(declaredVolumes, volume.source)) {
        throw new Error(`acceptance Compose service ${serviceName} uses an unowned volume`);
      }
    }
  }
  for (const [networkName, network] of Object.entries(config.networks ?? {})) {
    if (network.external || !String(network.name).startsWith(projectPrefix)) {
      throw new Error(`acceptance Compose network ${networkName} is not runner-owned`);
    }
  }
  for (const [volumeName, volume] of Object.entries(declaredVolumes)) {
    if (volume.external || !String(volume.name).startsWith(projectPrefix)) {
      throw new Error(`acceptance Compose volume ${volumeName} is not runner-owned`);
    }
  }
}

function isRunnerCorePort(port, corePort) {
  return (
    port &&
    port.host_ip === "127.0.0.1" &&
    String(port.published) === String(corePort) &&
    String(port.target) === "8000" &&
    (port.protocol ?? "tcp") === "tcp"
  );
}

function isPortBindConflict(error, port) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes(String(port)) &&
    (message.includes("address already in use") ||
      message.includes("port is already allocated") ||
      message.includes("failed to bind host port"))
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
        const output = [
          stdout && `stdout:\n${stdout.trim()}`,
          stderr && `stderr:\n${stderr.trim()}`
        ]
          .filter(Boolean)
          .join("\n");
        finish(new Error(`${rendered} exited ${code ?? signal ?? "without a status"}${output ? `:\n${output}` : ""}`));
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
    apiKey: acceptanceAPIKey(),
    adminPassword: randomBytes(32).toString("base64url"),
    postgresPassword: randomBytes(24).toString("base64url"),
    minioPassword: randomBytes(24).toString("hex")
  };
}

function acceptanceAPIKey() {
  const hex = randomBytes(32).toString("hex");
  const groups = [];
  for (let index = 0; index < hex.length; index += 2) {
    groups.push(hex.slice(index, index + 2));
  }
  return `atlas_ak_${groups.join("-")}`;
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
