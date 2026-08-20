#!/usr/bin/env node
import { sanitizeErrorMessage } from "./error-sanitizer.js";
import {
  AtlasClient,
  type AtlasClientOptions,
  type AtlasSubscription,
  isTaskCreateRequest,
  type ResourceType,
  type TaskCreateRequest
} from "./index.js";
import { PACKAGE_BIN, PACKAGE_NAME } from "./package-metadata.js";
import { isResourceType as isProtocolResourceType, RESOURCE_TYPE_VALUES } from "./protocol.js";

export { PACKAGE_BIN, PACKAGE_NAME, RESOURCE_TYPE_VALUES };

export type CLIIO = {
  stdout: { write(data: string): void };
  stderr: { write(data: string): void };
  env: Record<string, string | undefined>;
  fetch?: AtlasClientOptions["fetch"];
  WebSocket?: AtlasClientOptions["WebSocket"];
  waitForExitSignal?: () => Promise<void>;
};

type CLIOptions = {
  baseUrl: string;
  apiKey?: string;
  idempotencyKey?: string;
};

type CLICommand =
  | { kind: "help"; options: CLIOptions }
  | { kind: "entities.get"; options: CLIOptions; id: string }
  | { kind: "tasks.create"; options: CLIOptions; body: TaskCreateRequest }
  | { kind: "watch"; options: CLIOptions; filter: AtlasSubscription; follow: boolean };

const usage =
  "usage: atlas [--base-url <url>] [--api-key <key>] entities get <id> | atlas --idempotency-key <key> tasks create <json> | atlas watch --subscribe <filter> --follow\n";
const CLI_REQUEST_TIMEOUT_MS = 10_000;
const CLI_ENTRYPOINT_NAMES = buildCLIEntrypointNames();

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export async function runCLI(argv: string[], io: CLIIO = defaultIO()): Promise<number> {
  try {
    const command = parseArgs(argv, io.env);
    if (command.kind === "help") {
      io.stdout.write(usage);
      return 0;
    }
    const client = new AtlasClient({
      baseUrl: command.options.baseUrl,
      apiKey: command.options.apiKey,
      fetch: io.fetch,
      WebSocket: io.WebSocket,
      requestTimeoutMs: CLI_REQUEST_TIMEOUT_MS
    });
    if (command.kind === "entities.get") {
      await client.handshake();
      io.stdout.write(JSON.stringify(await client.entities.get(command.id, { fresh: true })) + "\n");
      return 0;
    }
    if (command.kind === "tasks.create") {
      const idempotencyKey = command.options.idempotencyKey;
      if (!idempotencyKey) throw new UsageError("usage: tasks create requires --idempotency-key <key>");
      await client.handshake();
      io.stdout.write(JSON.stringify(await client.tasks.create(command.body, { idempotencyKey })) + "\n");
      return 0;
    }

    client.watch(command.filter, (_resource, event) => {
      io.stdout.write(JSON.stringify(event) + "\n");
    });
    try {
      await client.subscribe(command.filter);
      await client.sync.start();
      if (command.follow) {
        await (io.waitForExitSignal ?? waitForExitSignal)();
      }
      return 0;
    } finally {
      if (client.sync.status().running) {
        client.sync.stop();
      }
    }
  } catch (error) {
    const message = errorMessage(error);
    if (error instanceof UsageError) {
      io.stderr.write(message + "\n");
      io.stderr.write(usage);
      return 2;
    }
    io.stderr.write(message + "\n");
    return 1;
  }
}

function errorMessage(error: unknown): string {
  return sanitizeErrorMessage(error, { fallback: "unknown error" });
}

function parseArgs(argv: string[], env: Record<string, string | undefined>): CLICommand {
  const options: CLIOptions = {
    baseUrl: env.ATLAS_BASE_URL ?? "http://localhost:8000",
    apiKey: env.ATLAS_API_KEY
  };
  const positional: string[] = [];
  let subscribeFilter: string | undefined;
  let follow = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        return { kind: "help", options };
      case "--base-url":
        options.baseUrl = readFlagValue(argv, index, "--base-url");
        index++;
        break;
      case "--api-key":
        options.apiKey = readFlagValue(argv, index, "--api-key");
        index++;
        break;
      case "--idempotency-key":
        options.idempotencyKey = readFlagValue(argv, index, "--idempotency-key");
        index++;
        break;
      case "--subscribe":
        subscribeFilter = readFlagValue(argv, index, "--subscribe");
        index++;
        break;
      case "--follow":
        follow = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new UsageError(`usage: unknown flag ${arg}`);
        }
        positional.push(arg);
    }
  }

  const [resource, action, ...rest] = positional;
  if (resource === "entities" && action === "get" && rest.length === 1) {
    return { kind: "entities.get", options, id: rest[0] };
  }
  if (resource === "tasks" && action === "create" && rest.length > 0) {
    const raw = rest.join(" ");
    try {
      return { kind: "tasks.create", options, body: parseTaskCreateBody(JSON.parse(raw)) };
    } catch {
      throw new UsageError("invalid task JSON");
    }
  }
  if (resource === "watch" && action === undefined && rest.length === 0) {
    if (!subscribeFilter) {
      throw new UsageError("usage: watch requires --subscribe <filter>");
    }
    const filter = parseFilter(subscribeFilter);
    if (!follow) {
      throw new UsageError("usage: watch requires --follow");
    }
    return { kind: "watch", options, filter, follow };
  }
  throw new UsageError("usage: invalid command");
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new UsageError(`usage: ${flag} requires a value`);
  }
  return value;
}

export function parseFilter(raw: string): AtlasSubscription {
  if (raw === "all") return { filter: "all" };
  const parts = raw.split(":");
  const [kind, secondPart] = parts;
  if (kind === "type" && isResourceType(secondPart) && parts.length === 2)
    return { filter: "type", resource_type: secondPart };
  if (kind === "id" && isResourceType(secondPart) && parts.length >= 3) {
    const id = parts.slice(2).join(":");
    if (id) return { filter: "id", resource_type: secondPart, id };
  }
  if (kind === "tasks_for_asset" && parts.length >= 2) {
    const assetId = parts.slice(1).join(":");
    if (assetId) return { filter: "tasks_for_asset", asset_id: assetId };
  }
  throw new UsageError(`invalid subscription filter: ${raw}`);
}

export function isResourceType(value: string | undefined): value is ResourceType {
  return isProtocolResourceType(value);
}

function parseTaskCreateBody(value: unknown): TaskCreateRequest {
  if (!isTaskCreateRequest(value)) {
    throw new UsageError("invalid task JSON");
  }
  return value;
}

function waitForExitSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

function defaultIO(): CLIIO {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env
  };
}

function isCLIEntrypoint(): boolean {
  if (typeof process === "undefined") return false;
  const invoked = basename(process.argv[1] ?? "").toLowerCase();
  return CLI_ENTRYPOINT_NAMES.has(invoked);
}

function buildCLIEntrypointNames(): Set<string> {
  const allowedNames = new Set<string>(["cli.ts"]);
  for (const [binName, binPath] of Object.entries(PACKAGE_BIN)) {
    allowedNames.add(binName.toLowerCase());
    allowedNames.add(`${binName}.cmd`.toLowerCase());
    allowedNames.add(basename(binPath).toLowerCase());
  }
  const packageLeafName = PACKAGE_NAME.split("/").pop();
  if (packageLeafName) {
    allowedNames.add(packageLeafName.toLowerCase());
    allowedNames.add(`${packageLeafName}.cmd`.toLowerCase());
  }
  return allowedNames;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}

if (isCLIEntrypoint()) {
  void runCLI(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
