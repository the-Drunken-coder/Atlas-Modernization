#!/usr/bin/env node
import { AtlasClient, isTaskCreateRequest, type AtlasClientOptions, type AtlasSubscription, type ResourceType, type TaskCreateRequest } from "./index.js";
import { PACKAGE_BIN, PACKAGE_NAME } from "./package-metadata.js";

export { PACKAGE_BIN, PACKAGE_NAME };

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
};

type CLICommand =
  | { kind: "help"; options: CLIOptions }
  | { kind: "entities.get"; options: CLIOptions; id: string }
  | { kind: "tasks.create"; options: CLIOptions; body: TaskCreateRequest }
  | { kind: "watch"; options: CLIOptions; filter: AtlasSubscription; follow: boolean };

const usage = "usage: atlas [--base-url <url>] [--api-key <key>] entities get <id> | atlas tasks create <json> | atlas watch --subscribe <filter> --follow\n";
export const RESOURCE_TYPE_VALUES = ["entity", "task", "object"] as const satisfies readonly ResourceType[];
const RESOURCE_TYPE_SET = new Set<string>(RESOURCE_TYPE_VALUES);
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
      sync: "selective",
      requestTimeoutMs: CLI_REQUEST_TIMEOUT_MS
    });
    if (command.kind === "entities.get") {
      await client.handshake();
      io.stdout.write(JSON.stringify(await client.entities.get(command.id, { fresh: true })) + "\n");
      return 0;
    }
    if (command.kind === "tasks.create") {
      await client.handshake();
      io.stdout.write(JSON.stringify(await client.tasks.create(command.body)) + "\n");
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
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error ?? "unknown error");
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
  if (kind === "type" && isResourceType(secondPart) && parts.length === 2) return { filter: "type", resource_type: secondPart };
  if (kind === "id" && isResourceType(secondPart) && parts.length >= 3) {
    const id = parts.slice(2).join(":");
    if (id) return { filter: "id", resource_type: secondPart, id };
  }
  if (kind === "tasks_for_entity" && parts.length >= 2) {
    const entityId = parts.slice(1).join(":");
    if (entityId) return { filter: "tasks_for_entity", entity_id: entityId };
  }
  throw new UsageError(`invalid subscription filter: ${raw}`);
}

export function isResourceType(value: string | undefined): value is ResourceType {
  return value !== undefined && RESOURCE_TYPE_SET.has(value);
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
  runCLI(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
