import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createUSShortFastProfile,
  MeshtasticSerialRadio,
  PreSharedKeyAuthenticationPolicy,
  startLinkService
} from "@the-drunken-coder/atlas-meshtastic-link";
import {
  type LaboratoryControllerMessage,
  LaboratoryMeshtasticDevice,
  type LaboratoryProcessMessage
} from "./laboratory-meshtastic.js";

type RunnerReady = {
  type: "runner:ready";
  mode: "asset" | "gateway";
  nodeID: string;
  address: { host: string; port: number };
};

type RunnerSummary = {
  type: "runner:summary";
  mode: "asset" | "gateway";
  nodeID: string;
  duration_ms: number;
  outcome: "stopped" | "failed";
  error?: string;
  evidence_complete: boolean;
  lifecycle_cleanup: ReturnType<LaboratoryMeshtasticDevice["summary"]>;
  device: ReturnType<LaboratoryMeshtasticDevice["summary"]>;
  active_resources: {
    after_lifecycle_close: string[];
    after_ipc_disconnect: string[];
  };
};

const startedAt = performance.now();
const mode = option("--mode");
if (mode !== "asset" && mode !== "gateway") throw new Error("--mode must be asset or gateway");
const nodeID = option("--node-id");
const nodeNumber = integerOption("--node-number");
const summaryPath = option("--summary");
const membershipPath = optionalOption("--membership");
const joinKey = process.env.ATLAS_LINK_JOIN_KEY;
if (!joinKey) throw new Error("ATLAS_LINK_JOIN_KEY is required");

const sendToController = (message: LaboratoryProcessMessage | RunnerReady | RunnerSummary): void => {
  if (!process.send) throw new Error("laboratory process requires an IPC controller");
  process.send(message);
};
const sendFinalSummary = (message: RunnerSummary): Promise<void> =>
  new Promise((resolve) => {
    if (!process.send || !process.connected) {
      resolve();
      return;
    }
    process.send(message, () => resolve());
  });
const device = new LaboratoryMeshtasticDevice(nodeID, nodeNumber, sendToController);
const onControllerMessage = (message: unknown): void => {
  if (isControllerMessage(message)) device.handleControllerMessage(message);
};
process.on("message", onControllerMessage);

let outcome: RunnerSummary["outcome"] = "failed";
let failure: unknown;
let activeResourcesAfterLifecycleClose: string[] = [];
try {
  const profile = createUSShortFastProfile(20, "2.7.15");
  const authentication = new PreSharedKeyAuthenticationPolicy(joinKey);
  const common = {
    nodeID,
    profile,
    authentication,
    openRadio: () => MeshtasticSerialRadio.openTransport(() => device.openTransport()),
    port: 0,
    frameEncoding: "canonical-json" as const
  };
  const running =
    mode === "gateway"
      ? await startLinkService({
          ...common,
          mode,
          ...(membershipPath === undefined ? {} : { membershipPath })
        })
      : await startLinkService({ ...common, mode });
  sendToController({ type: "runner:ready", mode, nodeID, address: running.address });
  process.stdout.write(
    `${JSON.stringify({ type: "ready", mode, node_id: nodeID, listening: `http://${running.address.host}:${running.address.port}` })}\n`
  );
  try {
    await waitForShutdown();
    outcome = "stopped";
  } finally {
    try {
      await running.close();
    } finally {
      activeResourcesAfterLifecycleClose = process.getActiveResourcesInfo();
    }
  }
} catch (error) {
  outcome = "failed";
  failure = error;
} finally {
  process.off("message", onControllerMessage);
  const lifecycleCleanup = device.summary();
  await device.close();
  const summary: RunnerSummary = {
    type: "runner:summary",
    mode,
    nodeID,
    duration_ms: Math.round(performance.now() - startedAt),
    outcome,
    ...(failure === undefined ? {} : { error: errorMessage(failure) }),
    evidence_complete: false,
    lifecycle_cleanup: lifecycleCleanup,
    device: device.summary(),
    active_resources: {
      after_lifecycle_close: activeResourcesAfterLifecycleClose,
      after_ipc_disconnect: []
    }
  };
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeSummary(summary);
  await sendFinalSummary(summary);
  await disconnectFromController();
  summary.active_resources.after_ipc_disconnect = process.getActiveResourcesInfo();
  summary.evidence_complete = true;
  await writeSummary(summary);
}

if (failure !== undefined) throw failure;

async function writeSummary(summary: RunnerSummary): Promise<void> {
  const temporaryPath = `${summaryPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await rename(temporaryPath, summaryPath);
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const stop = (): void => {
      if (resolved) return;
      resolved = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function disconnectFromController(): Promise<void> {
  return new Promise((resolve) => {
    const disconnect = process.disconnect;
    if (!process.connected || disconnect === undefined) {
      resolve();
      return;
    }
    process.once("disconnect", resolve);
    disconnect.call(process);
  });
}

function option(name: string): string {
  const value = optionalOption(name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function optionalOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  return !value || value.startsWith("--") ? undefined : value;
}

function integerOption(name: string): number {
  const raw = option(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isControllerMessage(value: unknown): value is LaboratoryControllerMessage {
  if (!isRecord(value)) return false;
  if (value.type === "lab:peer") {
    return Number.isSafeInteger(value.nodeNumber) && typeof value.publicKeyBase64 === "string";
  }
  return value.type === "lab:radio" && typeof value.packetBase64 === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
