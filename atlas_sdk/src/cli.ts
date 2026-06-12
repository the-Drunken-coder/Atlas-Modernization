#!/usr/bin/env node
import { AtlasClient, type AtlasSubscription } from "./index";

export type CLIIO = {
  stdout: { write(data: string): void };
  stderr: { write(data: string): void };
  env: Record<string, string | undefined>;
};

export async function runCLI(argv: string[], io: CLIIO = defaultIO()): Promise<number> {
  const baseUrl = readFlag(argv, "--base-url") ?? io.env.ATLAS_BASE_URL ?? "http://localhost:8000";
  const apiKey = readFlag(argv, "--api-key") ?? io.env.ATLAS_API_KEY;
  const client = new AtlasClient({ baseUrl, apiKey, sync: "selective" });
  const [resource, command, ...rest] = argv.filter((arg, index) => {
    const previous = argv[index - 1];
    return !arg.startsWith("--") && previous !== "--base-url" && previous !== "--api-key" && previous !== "--subscribe";
  });

  try {
    await client.handshake();
    if (resource === "entities" && command === "get") {
      io.stdout.write(JSON.stringify(await client.entities.get(rest[0], { fresh: true })) + "\n");
      return 0;
    }
    if (resource === "tasks" && command === "create") {
      io.stdout.write(JSON.stringify(await client.tasks.create(JSON.parse(rest.join(" ")))) + "\n");
      return 0;
    }
    if (resource === "watch") {
      const filter = parseFilter(readFlag(argv, "--subscribe") ?? "all");
      await client.subscribe(filter);
      await client.connectFeed();
      client.watch(filter, (_resource, event) => {
        io.stdout.write(JSON.stringify(event) + "\n");
      });
      if (argv.includes("--follow")) {
        await new Promise(() => undefined);
      }
      return 0;
    }
    io.stderr.write("usage: atlas entities get <id> | atlas tasks create <json> | atlas watch --subscribe <filter> --follow\n");
    return 2;
  } catch (error) {
    io.stderr.write((error as Error).message + "\n");
    return 1;
  }
}

function parseFilter(raw: string): AtlasSubscription {
  if (raw === "all") return { filter: "all" };
  const [kind, resourceType, id] = raw.split(":");
  if (kind === "type") return { filter: "type", resource_type: resourceType as any };
  if (kind === "id") return { filter: "id", resource_type: resourceType as any, id };
  if (kind === "tasks_for_entity") return { filter: "tasks_for_entity", entity_id: resourceType };
  throw new Error(`invalid subscription filter: ${raw}`);
}

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  return argv[index + 1];
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
