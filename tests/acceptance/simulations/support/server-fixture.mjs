import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const defaultServerEntrypoint = fileURLToPath(
  new URL("./server-launcher.mjs", import.meta.url),
);
const simulationPackageRoot = join(repositoryRoot, "simulations");
const simulationRequire = createRequire(
  join(simulationPackageRoot, "package.json"),
);
const tsxLoader = simulationRequire.resolve("tsx");
const readinessTimeoutMs = 30_000;
const shutdownTimeoutMs = 5_000;
const startupRetryAttempts = 3;

export const simulationFixtureVariant = {
  name: "real-simulations-server",
  entrypoint: "tests/acceptance/simulations/support/server-launcher.mjs",
  server_factory: "simulations/src/server/index.ts#createSimulationServer",
  config_loader: "simulations/src/server/config.ts#loadConfig",
  sdk: "built @the-drunken-coder/atlas-sdk workspace package",
  target: "runner-owned disposable loopback Core",
  transport: "public simulation HTTP and server-sent event routes",
};

export function createSimulationServerFixture({
  serverEntrypoint = defaultServerEntrypoint,
} = {}) {
  let artifacts;
  let child;
  let childCompletion;
  let cleanupLedgerDirectory;
  let isolatedPackageRoot;
  let serverState;
  let spawnError;

  return {
    prepare: async ({ artifacts: artifactDirectory, runID, signal }) => {
      artifacts = artifactDirectory;
      const isolatedPackage = prepareIsolatedPackageRoot(artifacts);
      isolatedPackageRoot = isolatedPackage.root;
      cleanupLedgerDirectory = join(
        isolatedPackageRoot,
        ".atlas-simulations",
        "runs",
      );
      const packageState = validateIsolatedPackageState(isolatedPackageRoot);
      const metadata = {
        ...simulationFixtureVariant,
        entrypoint: relative(repositoryRoot, serverEntrypoint),
        acceptance_run_id: runID,
        node: process.version,
        startup:
          "each child startup reserves a loopback port and retries only a recognized EADDRINUSE exit",
        isolated_package_root: isolatedPackageRoot,
        static_assets: isolatedPackage.staticAssets
          ? {
              present: true,
              path: join(isolatedPackageRoot, "dist"),
            }
          : {
              present: false,
              reason: "simulations/dist is absent",
            },
        package_state: packageState,
        cleanup:
          "owned child receives SIGTERM and then SIGKILL only if it misses the bounded shutdown deadline",
      };
      writeJSON(join(artifacts, "simulation-fixture.json"), metadata);
      return {
        metadata,
        cleanup: async () => {
          try {
            if (!child || !childCompletion) return;
            const forced = await stopChild(child, childCompletion);
            serverState = {
              ...serverState,
              stopped_at: new Date().toISOString(),
              forced_shutdown: forced,
              exit_code: child.exitCode,
              exit_signal: child.signalCode,
            };
            writeJSON(join(artifacts, "simulation-server.json"), serverState);
          } finally {
            removeIsolatedPackageRoot(isolatedPackageRoot);
            isolatedPackageRoot = undefined;
          }
        },
      };
    },

    start: async ({ coreBaseUrl, apiKey, signal }) => {
      if (!artifacts || !isolatedPackageRoot) {
        throw new Error("Simulation fixture must be prepared before it starts");
      }
      signal.throwIfAborted();

      const logPath = join(artifacts, "simulation-server.log");
      const environment = { ...process.env };
      environment.ATLAS_LOCAL_BASE_URL = coreBaseUrl;
      environment.ATLAS_LOCAL_API_KEY = apiKey;
      environment.ATLAS_SIM_ENABLE_DEPLOYED = "false";
      environment.ATLAS_SIM_TARGET = "local";
      environment.ATLAS_ACCEPTANCE_SIMULATION_PACKAGE_ROOT =
        isolatedPackageRoot;
      delete environment.ATLAS_DEPLOYED_BASE_URL;
      delete environment.ATLAS_DEPLOYED_API_KEY;

      const args = ["--import", tsxLoader, serverEntrypoint];
      appendFileSync(logPath, `$ ${process.execPath} ${args.join(" ")}\n`);
      const startupAttempts = [];
      for (let attempt = 1; attempt <= startupRetryAttempts; attempt += 1) {
        const reservation = await reserveLoopbackPort(signal);
        const port = reservation.port;
        await reservation.release();
        environment.ATLAS_SIM_PORT = String(port);
        spawnError = undefined;
        let childOutput = "";
        child = spawn(process.execPath, args, {
          cwd: repositoryRoot,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (chunk) => {
          childOutput += chunk;
          appendFileSync(logPath, chunk);
        });
        child.stderr.on("data", (chunk) => {
          childOutput += chunk;
          appendFileSync(logPath, chunk);
        });
        childCompletion = observeCompletion(child, (error) => {
          spawnError = error;
        });

        const url = `http://127.0.0.1:${port}`;
        serverState = {
          command: [process.execPath, ...args],
          pid: child.pid,
          node: process.version,
          url,
          startup_attempt: attempt,
          startup_attempts: startupAttempts,
          core_base_url: coreBaseUrl,
          started_at: new Date().toISOString(),
          log: logPath,
        };
        writeJSON(join(artifacts, "simulation-server.json"), serverState);
        try {
          const health = await waitForReadiness(url, signal, () => ({
            child,
            spawnError,
            childOutput,
          }));
          serverState = {
            ...serverState,
            ready_at: new Date().toISOString(),
            health,
          };
          writeJSON(join(artifacts, "simulation-server.json"), serverState);
          return { url, health, cleanupLedgerDirectory };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const retryable = isAddressInUse(errorMessage);
          startupAttempts.push({
            attempt,
            port,
            error: errorMessage,
            retryable,
          });
          serverState = {
            ...serverState,
            failed_at: new Date().toISOString(),
            startup_attempts: startupAttempts,
          };
          writeJSON(join(artifacts, "simulation-server.json"), serverState);
          if (!retryable || attempt === startupRetryAttempts) throw error;
          await childCompletion;
        }
      }
      throw new Error(
        "Simulation server exhausted its bounded startup retries",
      );
    },
  };
}

function prepareIsolatedPackageRoot(artifacts) {
  const packageRoot = join(artifacts, "simulation-server-package");
  mkdirSync(packageRoot, { recursive: true });
  const staticAssetSource = join(simulationPackageRoot, "dist");
  const staticAssets = existsSync(staticAssetSource);
  if (staticAssets) {
    symlinkSync(staticAssetSource, join(packageRoot, "dist"), "dir");
  }
  return { root: packageRoot, staticAssets };
}

function removeIsolatedPackageRoot(packageRoot) {
  if (packageRoot) rmSync(packageRoot, { recursive: true, force: true });
}

function validateIsolatedPackageState(packageRoot) {
  const ledgerDirectory = join(packageRoot, ".atlas-simulations", "runs");
  const ledgerEntries = existsSync(ledgerDirectory)
    ? readdirSync(ledgerDirectory)
    : [];
  if (ledgerEntries.length > 0) {
    throw new Error(
      `Simulation acceptance requires a clean worktree without retained cleanup-ledger entries; found ${ledgerEntries.length}`,
    );
  }
  return {
    retained_cleanup_ledger_entries: 0,
    retained_cleanup_ledger_path: ledgerDirectory,
  };
}

async function waitForReadiness(url, signal, processState) {
  const deadline = Date.now() + readinessTimeoutMs;
  let lastObservation = "no response";
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const { child, spawnError, childOutput } = processState();
    if (spawnError)
      throw new Error(
        `Simulation server failed to start: ${spawnError.message}`,
      );
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Simulation server exited before readiness with code ${String(child.exitCode)} and signal ${String(child.signalCode)}: ${childOutput}`,
      );
    }
    try {
      const response = await fetch(`${url}/api/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      });
      const raw = await response.text();
      lastObservation = `HTTP ${response.status}: ${raw}`;
      if (response.status === 200)
        return parseJSON(raw, "simulation health response");
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await abortableDelay(100, signal);
  }
  throw new Error(
    `Simulation server readiness expected HTTP 200 within ${readinessTimeoutMs} ms; observed ${lastObservation}`,
  );
}

function isAddressInUse(message) {
  return /\bEADDRINUSE\b/u.test(message);
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
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function reserveLoopbackPort(signal) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    let closed = false;
    const closeServer = () => {
      if (closed) return;
      closed = true;
      server.close(() => undefined);
    };
    const onAbort = () =>
      finish(signal.reason ?? new Error("Simulation port reservation aborted"));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) closeServer();
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
      if (settled) {
        closeServer();
        return;
      }
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        finish(
          new Error("Could not reserve an isolated simulation server port"),
        );
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
            closed = true;
            server.close((error) => (error ? releaseReject(error) : release()));
          }),
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
