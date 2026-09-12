#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runCanonicalBaseline, runFirstVerticalSlice, runStressBaseline } from "./benchmark.js";
import type { FrameEncoding } from "./frame.js";
import { PreSharedKeyAuthenticationPolicy } from "./joining.js";
import { preflightGatewayAcceptance, startLinkService } from "./lifecycle.js";
import { GatewayMembershipStore } from "./membership.js";
import { readPrivateFile } from "./private-file.js";
import { createUSShortFastProfile, type RadioProfile, validateRadioProfile } from "./profile.js";
import { MeshtasticSerialRadio } from "./radio.js";

const args = process.argv.slice(2);

export async function main(argv = args): Promise<void> {
  const command = argv[0];
  if (command === "benchmark") {
    const seed = integerOption(argv, "--seed", 42);
    const scenario = option(argv, "--scenario") ?? "canonical";
    if (scenario !== "canonical" && scenario !== "vertical-slice" && scenario !== "stress") {
      throw new Error("--scenario must be canonical, stress, or vertical-slice");
    }
    const result =
      scenario === "vertical-slice"
        ? await runFirstVerticalSlice(seed)
        : scenario === "stress"
          ? await runStressBaseline(seed)
          : await runCanonicalBaseline(seed);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "profile") {
    const slot = requiredIntegerOption(argv, "--frequency-slot");
    const firmware = requiredOption(argv, "--tested-firmware");
    console.log(JSON.stringify(createUSShortFastProfile(slot, firmware), null, 2));
    return;
  }
  if (command === "gateway-init") {
    const gatewayID = requiredOption(argv, "--gateway-id");
    if (gatewayID.includes(":")) throw new Error("--gateway-id must not contain ':'");
    const store = new GatewayMembershipStore(requiredOption(argv, "--membership"));
    const membership = {
      gateway_node_id: gatewayID,
      channel_index: requiredIntegerOption(argv, "--channel-index"),
      channel_name: "ATLAS",
      channel_key_base64: randomBytes(32).toString("base64")
    };
    preflightGatewayAcceptance(membership);
    await store.initialize(membership);
    console.log(JSON.stringify({ initialized: true, membership: requiredOption(argv, "--membership") }));
    return;
  }
  if (command === "radio") {
    await radioCommand(argv);
    return;
  }
  if (command === "serve") {
    await serve(argv);
    return;
  }
  throw new Error(usage());
}

async function radioCommand(argv: string[]): Promise<void> {
  const action = argv[1];
  const baseURL = new URL(option(argv, "--url") ?? "http://127.0.0.1:7331");
  if (!isLoopbackHostname(baseURL.hostname)) throw new Error("radio configuration CLI requires a loopback service URL");
  let result: unknown;
  if (action === "show") {
    result = await localJSON(baseURL, "/v1/radio/profile");
  } else if (action === "set") {
    const profile = await readProfile(requiredOption(argv, "--profile"));
    result = await localJSON(baseURL, "/v1/radio/profile", "PUT", profile);
  } else if (action === "apply") {
    result = await localJSON(baseURL, "/v1/radio/profile/apply", "POST", undefined, 90_000);
  } else {
    throw new Error("radio action must be show, set, or apply");
  }
  console.log(JSON.stringify(result, null, 2));
}

async function localJSON(
  baseURL: URL,
  path: string,
  method = "GET",
  body?: unknown,
  timeoutMs = 30_000
): Promise<unknown> {
  const url = new URL(path, baseURL);
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  });
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => undefined);
    const detail = isRecord(result) && typeof result.error === "string" ? result.error : response.statusText;
    throw new Error(`Link service returned ${response.status}: ${detail}`);
  }
  return response.json();
}

async function serve(argv: string[]): Promise<void> {
  const mode = requiredOption(argv, "--mode");
  if (mode !== "asset" && mode !== "gateway") throw new Error("--mode must be asset or gateway");
  const nodeID = requiredOption(argv, "--node-id");
  if (nodeID.includes(":")) throw new Error("--node-id must not contain ':'");
  const frameEncoding = option(argv, "--frame-encoding") ?? "canonical-json";
  if (
    frameEncoding !== "canonical-json" &&
    frameEncoding !== "deflate-v1" &&
    frameEncoding !== "deflate-v2" &&
    frameEncoding !== "deflate-v3" &&
    frameEncoding !== "binary-v1" &&
    frameEncoding !== "message-v1" &&
    frameEncoding !== "message-v2"
  )
    throw new Error("Invalid --frame-encoding");
  const validatedFrameEncoding: FrameEncoding = frameEncoding;
  const profile = await readProfile(requiredOption(argv, "--profile"));
  const joinKey = await readPrivateFile(requiredOption(argv, "--join-key-file"), "join authentication key");
  const port = integerOption(argv, "--port", 7331);
  const authentication = new PreSharedKeyAuthenticationPolicy(joinKey);
  const membershipPath = option(argv, "--membership");
  const common = {
    nodeID,
    profile,
    openRadio: () => MeshtasticSerialRadio.open(requiredOption(argv, "--serial")),
    port,
    frameEncoding: validatedFrameEncoding,
    adaptiveRetries: argv.includes("--adaptive-retries"),
    stateDeltas: argv.includes("--state-deltas")
  };
  const running =
    mode === "gateway"
      ? await startLinkService({
          ...common,
          mode,
          authentication,
          ...(membershipPath === undefined ? {} : { membershipPath })
        })
      : await startLinkService({ ...common, mode, authentication });

  console.log(
    JSON.stringify({ listening: `http://${running.address.host}:${running.address.port}`, mode, node_id: nodeID })
  );
  try {
    await waitForShutdown();
  } finally {
    await running.close();
  }
}

async function readProfile(path: string): Promise<RadioProfile> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  validateRadioProfile(value);
  return value;
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

function requiredOption(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  return !value || value.startsWith("--") ? undefined : value;
}

function integerOption(argv: string[], name: string, fallback: number): number {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const raw = argv[index + 1];
  if (raw === undefined || raw.trim() === "" || raw.startsWith("--")) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function requiredIntegerOption(argv: string[], name: string): number {
  requiredOption(argv, name);
  return integerOption(argv, name, 0);
}

function usage(): string {
  return [
    "Usage:",
    "  atlas-meshtastic-link benchmark [--scenario canonical|stress|vertical-slice] [--seed N]",
    "  atlas-meshtastic-link profile --frequency-slot N --tested-firmware VERSION",
    "  atlas-meshtastic-link gateway-init --membership PATH --gateway-id ID --channel-index N",
    "  atlas-meshtastic-link radio show [--url http://127.0.0.1:7331]",
    "  atlas-meshtastic-link radio set --profile PATH [--url http://127.0.0.1:7331]",
    "  atlas-meshtastic-link radio apply [--url http://127.0.0.1:7331]",
    "  atlas-meshtastic-link serve --mode asset|gateway --node-id ID --serial /dev/cu.* --profile PATH --join-key-file PATH [--membership PATH] [--port N] [--frame-encoding canonical-json|deflate-v1|deflate-v2|deflate-v3|binary-v1|message-v1|message-v2] [--adaptive-retries] [--state-deltas]"
  ].join("\n");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname === "localhost";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
