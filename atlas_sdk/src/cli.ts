#!/usr/bin/env node
import { AtlasClient, type AtlasSubscription, type ResourceType } from "./index.js";

export type CLIIO = {
  stdout: { write(data: string): void };
  stderr: { write(data: string): void };
  env: Record<string, string | undefined>;
};

type CLIOptions = {
  baseUrl: string;
  apiKey?: string;
};

type CLICommand =
  | { kind: "help"; options: CLIOptions }
  | { kind: "entities.get"; options: CLIOptions; id: string }
  | { kind: "tasks.create"; options: CLIOptions; body: unknown }
  | { kind: "watch"; options: CLIOptions; filter: AtlasSubscription; follow: boolean };

const usage = "usage: atlas [--base-url <url>] [--api-key <key>] entities get <id> | atlas tasks create <json> | atlas watch --subscribe <filter> --follow\n";

export async function runCLI(argv: string[], io: CLIIO = defaultIO()): Promise<number> {
  try {
    const command = parseArgs(argv, io.env);
    if (command.kind === "help") {
      io.stdout.write(usage);
      return 0;
    }

    const client = new AtlasClient({ baseUrl: command.options.baseUrl, apiKey: command.options.apiKey, sync: "selective" });
    await client.handshake();
    if (command.kind === "entities.get") {
      io.stdout.write(JSON.stringify(await client.entities.get(command.id, { fresh: true })) + "\n");
      return 0;
    }
    if (command.kind === "tasks.create") {
      io.stdout.write(JSON.stringify(await client.tasks.create(command.body as any)) + "\n");
      return 0;
    }

    await client.subscribe(command.filter);
    await client.connectFeed();
    client.watch(command.filter, (_resource, event) => {
      io.stdout.write(JSON.stringify(event) + "\n");
    });
    if (command.follow) {
      await new Promise(() => undefined);
    }
    return 0;
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith("usage:") || message.startsWith("invalid ")) {
      io.stderr.write(message + "\n");
      io.stderr.write(usage);
      return 2;
    }
    io.stderr.write(message + "\n");
    return 1;
  }
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
          throw new Error(`usage: unknown flag ${arg}`);
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
      return { kind: "tasks.create", options, body: JSON.parse(raw) };
    } catch {
      throw new Error("invalid task JSON");
    }
  }
  if (resource === "watch" && action === undefined && rest.length === 0) {
    if (!subscribeFilter) {
      throw new Error("usage: watch requires --subscribe <filter>");
    }
    return { kind: "watch", options, filter: parseFilter(subscribeFilter), follow };
  }
  throw new Error("usage: invalid command");
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`usage: ${flag} requires a value`);
  }
  return value;
}

function parseFilter(raw: string): AtlasSubscription {
  if (raw === "all") return { filter: "all" };
  const [kind, resourceType, id] = raw.split(":");
  if (kind === "type" && isResourceType(resourceType) && id === undefined) return { filter: "type", resource_type: resourceType };
  if (kind === "id" && isResourceType(resourceType) && id) return { filter: "id", resource_type: resourceType, id };
  if (kind === "tasks_for_entity" && resourceType && id === undefined) return { filter: "tasks_for_entity", entity_id: resourceType };
  throw new Error(`invalid subscription filter: ${raw}`);
}

function isResourceType(value: string | undefined): value is ResourceType {
  return value === "entity" || value === "task" || value === "object";
}

function defaultIO(): CLIIO {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env
  };
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("cli.js")) {
  runCLI(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
