import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const serverEntrypoint = join(repositoryRoot, "simulations", "src", "server", "index.ts");
const readinessTimeoutMs = 30_000;
const shutdownTimeoutMs = 5_000;

export const simulationFixtureVariant = {
  name: "real-simulations-server",
  entrypoint: "simulations/src/server/index.ts",
  sdk: "built @the-drunken-coder/atlas-sdk workspace package",
  target: "runner-owned disposable loopback Core",
  transport: "public simulation HTTP and server-sent event routes"
};

export function createSimulationServerFixture() {
  let artifacts;
  let child;
  let childCompletion;
  let initialReservation;
  let serverState;
  let spawnError;

  return {
    prepare: async ({ artifacts: artifactDirectory, runID, signal }) => {
      artifacts = artifactDirectory;
      const packageState = validateIsolatedPackageState();
      initialReservation = await reserveLoopbackPort(signal);
      const metadata = {
        ...simulationFixtureVariant,
        acceptance_run_id: runID,
        node: process.version,
        reserved_loopback_port: initialReservation.port,
        package_state: packageState,
        cleanup: "owned child receives SIGTERM and then SIGKILL only if it misses the bounded shutdown deadline"
      };
      writeJSON(join(artifacts, "simulation-fixture.json"), metadata);
      return {
        metadata,
        cleanup: async () => {
          await initialReservation?.release();
          initialReservation = undefined;
          if (!child || !childCompletion) return;
          const forced = await stopChild(child, childCompletion);
          serverState = {
            ...serverState,
            stopped_at: new Date().toISOString(),
            forced_shutdown: forced,
            exit_code: child.exitCode,
            exit_signal: child.signalCode
          };
          writeJSON(join(artifacts, "simulation-server.json"), serverState);
        }
      };
    },

    start: async ({ coreBaseUrl, apiKey, signal }) => {
      if (!artifacts || !initialReservation) throw new Error("Simulation fixture must be prepared before it starts");
      signal.throwIfAborted();
      const port = initialReservation.port;
      await initialReservation.release();
      initialReservation = undefined;

      const logPath = join(artifacts, "simulation-server.log");
      const environment = { ...process.env };
      environment.ATLAS_LOCAL_BASE_URL = coreBaseUrl;
      environment.ATLAS_LOCAL_API_KEY = apiKey;
      environment.ATLAS_SIM_ENABLE_DEPLOYED = "false";
      environment.ATLAS_SIM_TARGET = "local";
      environment.ATLAS_SIM_PORT = String(port);
      delete environment.ATLAS_DEPLOYED_BASE_URL;
      delete environment.ATLAS_DEPLOYED_API_KEY;

      const args = ["--import", "tsx", serverEntrypoint];
      appendFileSync(logPath, `$ ${process.execPath} ${args.join(" ")}\n`);
      child = spawn(process.execPath, args, {
        cwd: repositoryRoot,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.on("data", (chunk) => appendFileSync(logPath, chunk));
      child.stderr.on("data", (chunk) => appendFileSync(logPath, chunk));
      childCompletion = observeCompletion(child, (error) => {
        spawnError = error;
      });

      const url = `http://127.0.0.1:${port}`;
      serverState = {
        command: [process.execPath, ...args],
        pid: child.pid,
        node: process.version,
        url,
        core_base_url: coreBaseUrl,
        started_at: new Date().toISOString(),
        log: logPath
      };
      writeJSON(join(artifacts, "simulation-server.json"), serverState);
      const health = await waitForReadiness(url, signal, () => ({ child, spawnError }));
      serverState = { ...serverState, ready_at: new Date().toISOString(), health };
      writeJSON(join(artifacts, "simulation-server.json"), serverState);
      return { url, health };
    }
  };
}

function validateIsolatedPackageState() {
  const ledgerDirectory = join(repositoryRoot, "simulations", ".atlas-simulations", "runs");
  const ledgerEntries = existsSync(ledgerDirectory) ? readdirSync(ledgerDirectory) : [];
  if (ledgerEntries.length > 0) {
    throw new Error(
      `Simulation acceptance requires a clean worktree without retained cleanup-ledger entries; found ${ledgerEntries.length}`
    );
  }
  return {
    retained_cleanup_ledger_entries: 0,
    retained_cleanup_ledger_path: ledgerDirectory
  };
}

async function waitForReadiness(url, signal, processState) {
  const deadline = Date.now() + readinessTimeoutMs;
  let lastObservation = "no response";
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const { child, spawnError } = processState();
    if (spawnError) throw new Error(`Simulation server failed to start: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Simulation server exited before readiness with code ${String(child.exitCode)} and signal ${String(child.signalCode)}`
      );
    }
    try {
      const response = await fetch(`${url}/api/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)])
      });
      const raw = await response.text();
      lastObservation = `HTTP ${response.status}: ${raw}`;
      if (response.status === 200) return parseJSON(raw, "simulation health response");
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await abortableDelay(100, signal);
  }
  throw new Error(
    `Simulation server readiness expected HTTP 200 within ${readinessTimeoutMs} ms; observed ${lastObservation}`
  );
}

function observeCompletion(child, onSpawnError) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("error", (error) => {
      onSpawnError(error);
      settle();
    });
    child.once("close", settle);
  });
}

async function stopChild(child, completion) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await completion;
    return false;
  }
  child.kill("SIGTERM");
  if (await settledWithin(completion, shutdownTimeoutMs)) return false;
  child.kill("SIGKILL");
  await completion;
  return true;
}

async function settledWithin(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function reserveLoopbackPort(signal) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const onAbort = () => finish(signal.reason ?? new Error("Simulation port reservation aborted"));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    server.once("error", finish);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        finish(new Error("Could not reserve an isolated simulation server port"));
        return;
      }
      let released = false;
      finish(undefined, {
        port: address.port,
        release: () =>
          new Promise((release, releaseReject) => {
            if (released) {
              release();
              return;
            }
            released = true;
            server.close((error) => (error ? releaseReject(error) : release()));
          })
      });
    });
  });
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    function finish() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseJSON(raw, description) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${description} was not valid JSON: ${raw}`);
  }
}

function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
