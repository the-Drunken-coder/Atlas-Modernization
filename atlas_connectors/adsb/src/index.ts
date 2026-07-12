import { randomUUID } from "node:crypto";
import { AtlasClient, type TaskCreateRequest } from "@the-drunken-coder/atlas-sdk";
import { readConfig } from "./config.js";
import { ADSBConnector } from "./connector.js";
import { scanTaskComponent, type ScanBounds } from "./scan.js";

const config = readConfig();
const client = new AtlasClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, sync: false });
const command = process.argv[2] ?? "run";

if (command === "run") {
  await run(process.argv.includes("--once"));
} else if (command === "scan") {
  await submitScan(process.argv.slice(3));
} else {
  throw new Error("Usage: run [--once] | scan [--north N --south N --east N --west N --count N]");
}

async function run(once: boolean): Promise<void> {
  const connector = new ADSBConnector(client, config);
  await client.handshake();
  await connector.ensureAsset();
  console.log(`ADS-B connector is running against ${config.baseUrl}`);
  if (once) {
    await connector.tick();
    return;
  }

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  while (!controller.signal.aborted) {
    await connector.tick();
    await wait(config.intervalMs, controller.signal);
  }
}

async function submitScan(args: string[]): Promise<void> {
  const bounds: ScanBounds = {
    north: numberArgument(args, "--north", 39.1),
    south: numberArgument(args, "--south", 38.7),
    east: numberArgument(args, "--east", -76.8),
    west: numberArgument(args, "--west", -77.3)
  };
  const trackCount = numberArgument(args, "--count", 3);
  const request: TaskCreateRequest = {
    task_id: `scan-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    entity_id: config.connectorId,
    components: { custom_connector: scanTaskComponent(bounds, trackCount) }
  };
  const task = await client.tasks.create(request);
  console.log(`Submitted ${task.task_id} to ${config.connectorId}`);
  console.log(JSON.stringify(task, null, 2));
}

function numberArgument(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
