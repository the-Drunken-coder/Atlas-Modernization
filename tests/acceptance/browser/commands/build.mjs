import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const applicationRoot = join(repositoryRoot, "surfaces", "command-interface");
const viteEntry = join(repositoryRoot, "node_modules", "vite", "bin", "vite.js");
const fixtureConfig = fileURLToPath(new URL("./vite.config.mjs", import.meta.url));
const buildTimeoutMs = 10 * 60_000;

export async function buildCommandFixture({ coreOrigin, artifacts, signal }) {
  const outputDirectory = join(artifacts, "command-interface-build");
  const logPath = join(artifacts, "browser-build.log");
  await runLogged(process.execPath, [viteEntry, "build", "--config", fixtureConfig], {
    cwd: applicationRoot,
    env: {
      ...process.env,
      ATLAS_BROWSER_COMMANDS_BUILD_DIR: outputDirectory,
      VITE_ATLAS_CORE_BASE_URL: coreOrigin,
      VITE_MAPTILER_API_KEY: "atlas-local-map-fixture"
    },
    logPath,
    signal,
    timeoutMs: buildTimeoutMs
  });
  if (!existsSync(join(outputDirectory, "index.html"))) {
    throw new Error(`fixture build did not create ${join(outputDirectory, "index.html")}`);
  }
  return outputDirectory;
}

function runLogged(command, args, { cwd, env, logPath, signal, timeoutMs }) {
  appendFileSync(logPath, `$ ${[command, ...args].join(" ")}\n`);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let timedOut = false;
    const append = (stream, chunk) => {
      const value = String(chunk);
      appendFileSync(logPath, value);
      (stream === "stdout" ? process.stdout : process.stderr).write(value);
    };
    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    child.once("error", (error) => finish(new Error(`failed to run fixture build: ${error.message}`)));
    child.once("close", (code, childSignal) => {
      if (signal.aborted) return finish(signal.reason);
      if (timedOut) return finish(new Error(`fixture build exceeded ${timeoutMs} ms`));
      if (code !== 0) return finish(new Error(`fixture build exited ${code ?? childSignal ?? "without a status"}`));
      finish();
    });
  });
}
