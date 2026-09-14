import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { runAcceptance } from "../../support/stack.mjs";

const executeFile = promisify(execFile);
const dockerTimeoutMs = 20_000;

export function runPluginAcceptance({
  name,
  reproduction,
  composeFile,
  fixtureVariant,
  pluginService,
  run,
}) {
  return runAcceptance({
    name,
    reproduction,
    additionalComposeFiles: [composeFile],
    fixtureVariant,
    run: async (context) => {
      const stack = pluginStackControl({
        runID: context.runID,
        artifacts: context.artifacts,
        service: pluginService,
        signal: context.signal,
      });
      await run({ ...context, pluginStack: stack });
    },
  });
}

export async function waitForPluginStatus(
  client,
  pluginID,
  expectedStatus,
  expectedReason,
  signal,
) {
  const deadline = Date.now() + 35_000;
  let observed;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const statuses = await client.plugins.list({ signal });
    observed = statuses.find((status) => status.plugin_id === pluginID);
    if (
      observed?.status === expectedStatus &&
      observed.reason_code === expectedReason
    )
      return observed;
    await abortableDelay(250, signal);
  }
  throw new Error(
    `Plugin ${pluginID} expected ${expectedStatus}/${String(expectedReason)} within 35000 ms, observed ${JSON.stringify(observed)}`,
  );
}

function pluginStackControl({ runID, artifacts, service, signal }) {
  const commandLog = join(artifacts, "plugin-stack-commands.jsonl");

  const containerID = async () => {
    const result = await docker(
      [
        "container",
        "ls",
        "--all",
        "--quiet",
        "--filter",
        `label=io.atlas.acceptance.run=${runID}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      ],
      { commandLog, signal },
    );
    const matches = result.stdout.trim().split(/\s+/u).filter(Boolean);
    if (matches.length !== 1) {
      throw new Error(
        `expected one owned ${service} container, observed ${JSON.stringify(matches)}`,
      );
    }
    return matches[0];
  };

  return Object.freeze({
    async stop() {
      const id = await containerID();
      await docker(["container", "stop", "--time", "5", id], {
        commandLog,
        signal,
      });
      return {
        container_id: id,
        state: await containerState(id, commandLog, signal),
      };
    },
    async start() {
      const id = await containerID();
      await docker(["container", "start", id], { commandLog, signal });
      return {
        container_id: id,
        state: await containerState(id, commandLog, signal),
      };
    },
  });
}

async function containerState(id, commandLog, signal) {
  const result = await docker(
    ["container", "inspect", "--format", "{{.State.Status}}", id],
    {
      commandLog,
      signal,
    },
  );
  return result.stdout.trim();
}

async function docker(args, { commandLog, signal }) {
  const startedAt = new Date().toISOString();
  const command = ["docker", ...args];
  appendFileSync(
    commandLog,
    `${JSON.stringify({ started_at: startedAt, command })}\n`,
  );
  try {
    const result = await executeFile("docker", args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: dockerTimeoutMs,
      signal,
    });
    appendFileSync(
      commandLog,
      `${JSON.stringify({ completed_at: new Date().toISOString(), command, status: 0, ...result })}\n`,
    );
    return result;
  } catch (error) {
    appendFileSync(
      commandLog,
      `${JSON.stringify({
        completed_at: new Date().toISOString(),
        command,
        status: typeof error.code === "number" ? error.code : null,
        signal: error.signal ?? null,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        message: error.message,
      })}\n`,
    );
    throw error;
  }
}

function abortableDelay(milliseconds, signal) {
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
