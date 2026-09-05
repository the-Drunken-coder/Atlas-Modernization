#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runCanonicalBaseline, runFirstVerticalSlice, runStressBaseline } from "./benchmark.js";
import { RealClock } from "./clock.js";
import { AssetJoinService, GatewayJoinService, PreSharedKeyAuthenticationPolicy } from "./joining.js";
import { GatewayMembershipStore } from "./membership.js";
import { readPrivateFile } from "./private-file.js";
import { createUSShortFastProfile, type RadioProfile, RadioProfileManager, validateRadioProfile } from "./profile.js";
import { LinkRadioGate, MeshtasticSerialRadio } from "./radio.js";
import { LinkHTTPServer, LinkService } from "./service.js";
import { LinkTransport } from "./transport.js";

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
    await store.initialize({
      gateway_node_id: gatewayID,
      channel_index: requiredIntegerOption(argv, "--channel-index"),
      channel_name: "ATLAS",
      channel_key_base64: randomBytes(32).toString("base64")
    });
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
  const result: unknown = await response.json();
  if (!response.ok) {
    const detail = isRecord(result) && typeof result.error === "string" ? result.error : response.statusText;
    throw new Error(`Link service returned ${response.status}: ${detail}`);
  }
  return result;
}

async function serve(argv: string[]): Promise<void> {
  const mode = requiredOption(argv, "--mode");
  if (mode !== "asset" && mode !== "gateway") throw new Error("--mode must be asset or gateway");
  const nodeID = requiredOption(argv, "--node-id");
  if (nodeID.includes(":")) throw new Error("--node-id must not contain ':'");
  const profile = await readProfile(requiredOption(argv, "--profile"));
  const joinKey = await readPrivateFile(requiredOption(argv, "--join-key-file"), "join authentication key");
  const port = integerOption(argv, "--port", 7331);
  const authentication = new PreSharedKeyAuthenticationPolicy(joinKey);
  const clock = new RealClock();
  const rawRadio = await MeshtasticSerialRadio.open(requiredOption(argv, "--serial"));
  const radio = new LinkRadioGate(rawRadio);
  const profileManager = new RadioProfileManager(profile, rawRadio);
  const service = new LinkService({ mode, nodeID, clock, profileManager, radioGate: radio });
  const http = new LinkHTTPServer(service);
  let listening = false;
  let gatewayJoin: GatewayJoinService | undefined;
  let assetJoin: AssetJoinService | undefined;
  let primaryError: unknown;

  try {
    const address = await http.listen(port);
    listening = true;
    if (mode === "gateway") {
      const store = new GatewayMembershipStore(requiredOption(argv, "--membership"));
      const membership = await store.load();
      if (membership.gateway_node_id !== nodeID)
        throw new Error("Gateway membership identity does not match --node-id");
      await profileManager.prepareGateway(membership);
      const active = await store.activateGateway();
      const transport = new LinkTransport({
        node: service.node,
        sourceGeneration: active.gateway_generation,
        serviceSession: service.serviceSession,
        radio,
        clock,
        picture: service.picture,
        privateChannel: active.channel_index
      });
      service.attachTransport(transport);
      gatewayJoin = new GatewayJoinService(
        radio,
        profile.public_channel.index,
        store,
        authentication,
        (error) => service.setJoiningLifecycle("active", `join attempt deferred: ${error.message}`),
        (admission) => {
          transport.announceSourceActivation(admission.source, admission.source_generation, admission.service_session);
        }
      );
    } else {
      await profileManager.prepareAssetForJoin();
      service.setJoiningLifecycle("discovering", "waiting for authenticated Gateway admission");
      let attached = false;
      assetJoin = new AssetJoinService({
        radio,
        clock,
        assetID: nodeID,
        radioNodeID: rawRadio.nodeNumber(),
        serviceSession: service.serviceSession,
        rendezvousChannel: profile.public_channel.index,
        authentication,
        installMembership: async (membership) => {
          if (service.isRadioProfileApplying()) throw new Error("radio profile apply is in progress");
          await profileManager.installAssetMembership(membership);
        },
        onStatus: (status) => {
          service.setJoiningStatus(status);
          if (status.state === "discovering" || status.state === "authenticating") {
            service.setJoiningLifecycle("discovering", status.state);
          } else if (status.state === "joined" && !attached) {
            attached = true;
            const transport = new LinkTransport({
              node: service.node,
              sourceGeneration: status.source_generation,
              serviceSession: service.serviceSession,
              radio,
              clock,
              picture: service.picture,
              privateChannel: profile.private_channel.index
            });
            service.attachTransport(transport, { role: "gateway", id: status.gateway_node_id });
          }
        },
        onError: (error) => service.setJoiningLifecycle("discovering", `join attempt deferred: ${error.message}`),
        onDisconnect: (error) => service.setLifecycle("error", error.message)
      });
      assetJoin.start();
    }
    console.log(JSON.stringify({ listening: `http://${address.host}:${address.port}`, mode, node_id: nodeID }));
    await waitForShutdown();
  } catch (error) {
    primaryError = error;
    try {
      service.setLifecycle("error", error instanceof Error ? error.message : String(error));
    } catch {
      // Preserve the operation failure even if a local event listener is faulty.
    }
  }

  const cleanupErrors: unknown[] = [];
  for (const cleanup of [() => service.stop(), () => assetJoin?.close(), () => gatewayJoin?.close()]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (listening) {
    try {
      await http.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await radio.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Link service cleanup failed");
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
    "  atlas-meshtastic-link serve --mode asset|gateway --node-id ID --serial /dev/cu.* --profile PATH --join-key-file PATH [--membership PATH] [--port N]"
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
