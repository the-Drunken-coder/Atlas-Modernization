import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type Role = "asset" | "gateway";

type Address = { host: string; port: number };

type ReadyMessage = {
  type: "runner:ready";
  mode: Role;
  nodeID: string;
  address: Address;
};

type DeviceSummary = {
  node_id: string;
  node_number: number;
  connections_opened: number;
  connections_closed: number;
  active_connections: number;
  configure_requests: number;
  configuration_commits: number;
  configuration_writes: number;
  queue_statuses: number;
  radio_packets_sent: number;
  radio_packets_received: number;
  pending_writes: number;
};

type SummaryMessage = {
  type: "runner:summary";
  mode: Role;
  nodeID: string;
  duration_ms: number;
  outcome: "stopped" | "failed";
  error?: string;
  lifecycle_cleanup: DeviceSummary;
  device: DeviceSummary;
};

type RegisterMessage = {
  type: "lab:register";
  nodeNumber: number;
  publicKeyBase64: string;
};

type RadioMessage = {
  type: "lab:radio";
  from: number;
  to: number;
  channel: number;
  packetBase64: string;
};

type ChildMessage = ReadyMessage | SummaryMessage | RegisterMessage | RadioMessage;

type Runner = {
  role: Role;
  child: ChildProcess;
  ready: Promise<ReadyMessage>;
  summary: Promise<SummaryMessage>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: string[];
  stderr: string[];
  summaryPath: string;
};

type ProcessObservation = {
  revision: string;
  platform: NodeJS.Platform;
  architecture: string;
  node: string;
  scenario: "baseline" | "drop-asset-private-packets";
  artifact_directory: string;
  timings_ms: Record<string, number>;
  gateway?: { ready: ReadyMessage; status: unknown; profile: unknown };
  asset?: { ready: ReadyMessage; status: unknown; profile: unknown };
  state_submission?: unknown;
  state_event?: unknown;
  shared_picture?: unknown;
  shutdown_stream_closed?: boolean;
  summaries?: SummaryMessage[];
  exits?: Array<{ role: Role; code: number | null; signal: NodeJS.Signals | null }>;
  ports_reused?: number[];
  forced_terminations?: Role[];
  cleanup_failures?: string[];
  failure?: string;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(packageRoot, "../..");
const runnerPath = join(packageRoot, "dist", "acceptance", "process-runner.js");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const artifactParent = process.env.ATLAS_LINK_ACCEPTANCE_ARTIFACTS ?? join(repositoryRoot, ".tmp", "link-acceptance");
const scenario =
  process.env.ATLAS_LINK_ACCEPTANCE_FAULT === "drop-asset-private-packets" ? "drop-asset-private-packets" : "baseline";

test("runs compiled Gateway and Asset processes through device configuration, authenticated join, traffic, and shutdown", {
  timeout: 120_000
}, async () => {
  const scenarioStarted = performance.now();
  const artifactDirectory = join(artifactParent, `${scenario}-${randomUUID()}`);
  await mkdir(artifactDirectory, { recursive: true });
  process.stdout.write(`Atlas Link acceptance artifacts: ${artifactDirectory}\n`);
  const observation: ProcessObservation = {
    revision,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    scenario,
    artifact_directory: artifactDirectory,
    timings_ms: {}
  };
  const expected = {
    processes: ["gateway", "asset"],
    lifecycle: "active",
    authenticated_join: "joined",
    radio_profile_differences: [],
    picture_record: { source: { role: "asset", id: "asset-alpha" }, entity_id: "asset-alpha", altitude: 101 },
    shutdown: { exit_code: 0, active_connections: 0, pending_writes: 0, loopback_ports_reusable: true },
    evidence_boundaries: [
      "test-owned stream transport and device protocol subset",
      "firmware-decoded unicast metadata supplied by the fixture",
      "no Meshtastic firmware PKI cryptography, RF, USB, hardware, or Linux serial proof"
    ]
  };
  await writeJSON(join(artifactDirectory, "expected.json"), expected);

  const network = new LaboratoryNetwork(scenario === "drop-asset-private-packets");
  const runners: Runner[] = [];
  let gatewayEvents: SSEReader | undefined;
  let shutdownEvents: SSEReader | undefined;
  let failure: unknown;
  try {
    const membershipPath = join(artifactDirectory, "gateway-membership.json");
    await writeJSON(
      membershipPath,
      {
        gateway_node_id: "gateway-main",
        gateway_generation: 0,
        asset_generations: {},
        channel_index: 1,
        channel_name: "ATLAS",
        channel_key_base64: Buffer.alloc(32, 7).toString("base64")
      },
      0o600
    );

    const gateway = spawnRunner("gateway", 10_001, artifactDirectory, membershipPath);
    runners.push(gateway);
    network.add(gateway);
    const gatewayReady = await withTimeout(gateway.ready, 30_000, "Gateway process did not become ready");
    observation.timings_ms.gateway_ready = elapsed(scenarioStarted);

    const asset = spawnRunner("asset", 10_002, artifactDirectory);
    runners.push(asset);
    network.add(asset);
    const assetReady = await withTimeout(asset.ready, 30_000, "Asset process did not become ready");
    observation.timings_ms.asset_ready = elapsed(scenarioStarted);

    const gatewayBase = baseURL(gatewayReady.address);
    const assetBase = baseURL(assetReady.address);
    const gatewayStatus = await waitForJSON(
      `${gatewayBase}/v1/status`,
      (value) => property(value, "lifecycle") === "active",
      15_000,
      "Gateway did not report an active lifecycle"
    );
    const assetStatus = await waitForJSON(
      `${assetBase}/v1/status`,
      (value) =>
        property(value, "lifecycle") === "active" && property(property(value, "joining"), "state") === "joined",
      30_000,
      "Asset did not complete authenticated joining"
    );
    observation.timings_ms.joined = elapsed(scenarioStarted);

    const gatewayProfile = await getJSON(`${gatewayBase}/v1/radio/profile`);
    const assetProfile = await getJSON(`${assetBase}/v1/radio/profile`);
    assertRadioProfile(gatewayProfile, "Gateway");
    assertRadioProfile(assetProfile, "Asset");
    observation.gateway = { ready: gatewayReady, status: gatewayStatus, profile: gatewayProfile };
    observation.asset = { ready: assetReady, status: assetStatus, profile: assetProfile };

    gatewayEvents = await openSSE(`${gatewayBase}/v1/events?after=0&client_id=process-acceptance`);
    const statePublication = positionPublication();
    const stateSubmission = await postJSON(`${assetBase}/v1/messages`, {
      message: statePublication,
      operation_id: "acceptance-position"
    });
    assert.equal(property(stateSubmission, "status"), "queued");
    const stateEvent = await gatewayEvents.next(
      (value) => {
        const event = property(value, "event");
        return (
          property(value, "type") === "transport" &&
          property(event, "type") === "message" &&
          property(property(event, "message"), "operation_id") === "acceptance-position" &&
          property(property(event, "source"), "id") === "asset-alpha"
        );
      },
      15_000,
      "Gateway public event stream did not expose the Asset state publication"
    );
    const sharedPicture = await waitForJSON(
      `${gatewayBase}/v1/picture`,
      (value) => findPictureRecord(value) !== undefined,
      15_000,
      "Gateway Shared Picture did not observe the Asset publication"
    );
    assertPublishedPosition(sharedPicture, 101);
    observation.state_submission = stateSubmission;
    observation.state_event = stateEvent;
    observation.shared_picture = sharedPicture;
    observation.timings_ms.picture_observed = elapsed(scenarioStarted);

    shutdownEvents = await openSSE(`${gatewayBase}/v1/events?client_id=shutdown-observer`);
    for (const runner of runners) runner.child.kill("SIGTERM");
    const shutdownStream = waitForSSEClosure(shutdownEvents, 15_000);
    const exits = await Promise.all(
      runners.map((runner) => withTimeout(runner.exit, 15_000, `${runner.role} did not exit`))
    );
    observation.shutdown_stream_closed = await shutdownStream;
    const summaries = await Promise.all(
      runners.map((runner) => withTimeout(runner.summary, 2_000, `${runner.role} did not publish its summary`))
    );
    observation.summaries = summaries;
    observation.exits = exits.map((exit, index) => ({ role: runners[index]?.role ?? "asset", ...exit }));
    observation.timings_ms.shutdown_complete = elapsed(scenarioStarted);

    for (const [index, exit] of exits.entries()) {
      assert.equal(exit.code, 0, `${runners[index]?.role} process exit code`);
      assert.equal(exit.signal, null, `${runners[index]?.role} process exit signal`);
    }
    for (const summary of summaries) assertCleanLifecycleShutdown(summary);
    assert.equal(observation.shutdown_stream_closed, true);

    const ports = [gatewayReady.address.port, assetReady.address.port];
    for (const port of ports) await assertPortReusable(port);
    observation.ports_reused = ports;
    observation.timings_ms.total = elapsed(scenarioStarted);
  } catch (error) {
    failure = error;
    observation.failure = errorMessage(error);
  } finally {
    await gatewayEvents?.close();
    await shutdownEvents?.close();
    for (const runner of runners) {
      if (runner.child.exitCode === null && runner.child.signalCode === null) runner.child.kill("SIGTERM");
    }
    const gracefulCleanup = await Promise.allSettled(
      runners.map((runner) => withTimeout(runner.exit, 5_000, `${runner.role} cleanup timed out`))
    );
    const forced: Role[] = [];
    for (const runner of runners) {
      if (runner.child.exitCode === null && runner.child.signalCode === null) {
        forced.push(runner.role);
        runner.child.kill("SIGKILL");
      }
    }
    observation.forced_terminations = forced;
    const forcedCleanup = await Promise.allSettled(
      runners.map((runner) => withTimeout(runner.exit, 5_000, `${runner.role} did not exit after SIGKILL`))
    );
    const cleanupFailures = [...gracefulCleanup, ...forcedCleanup]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => errorMessage(result.reason));
    if (cleanupFailures.length > 0) {
      observation.cleanup_failures = cleanupFailures;
      if (failure === undefined) failure = new AggregateError(cleanupFailures, "acceptance child cleanup failed");
    }
    await Promise.all(
      runners.map(async (runner) => {
        await writeFile(join(artifactDirectory, `${runner.role}.stdout.log`), runner.stdout.join(""));
        await writeFile(join(artifactDirectory, `${runner.role}.stderr.log`), runner.stderr.join(""));
        try {
          await readFile(runner.summaryPath);
        } catch {
          await writeFile(runner.summaryPath, `${JSON.stringify({ missing: true }, null, 2)}\n`);
        }
      })
    );
    if (observation.timings_ms.total === undefined) observation.timings_ms.total = elapsed(scenarioStarted);
    await writeJSON(join(artifactDirectory, "observed.json"), observation);
  }
  if (failure !== undefined) throw failure;
});

class LaboratoryNetwork {
  private readonly nodes = new Map<number, { child: ChildProcess; publicKeyBase64: string }>();

  constructor(private readonly dropAssetPrivatePackets: boolean) {}

  add(runner: Runner): void {
    runner.child.on("message", (message: unknown) => this.receive(runner.child, message));
  }

  private receive(child: ChildProcess, message: unknown): void {
    if (!isChildMessage(message)) return;
    if (message.type === "lab:register") {
      for (const [nodeNumber, peer] of this.nodes) {
        if (nodeNumber === message.nodeNumber) continue;
        child.send({ type: "lab:peer", nodeNumber, publicKeyBase64: peer.publicKeyBase64 });
        peer.child.send({
          type: "lab:peer",
          nodeNumber: message.nodeNumber,
          publicKeyBase64: message.publicKeyBase64
        });
      }
      this.nodes.set(message.nodeNumber, { child, publicKeyBase64: message.publicKeyBase64 });
      return;
    }
    if (message.type !== "lab:radio") return;
    if (this.dropAssetPrivatePackets && message.from === 10_002 && message.channel === 1) return;
    for (const [nodeNumber, peer] of this.nodes) {
      if (nodeNumber === message.from) continue;
      if (message.to !== 0xffffffff && message.to !== nodeNumber) continue;
      if (peer.child.connected) peer.child.send({ type: "lab:radio", packetBase64: message.packetBase64 });
    }
  }
}

class SSEReader {
  private buffer = "";

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly abort: AbortController
  ) {}

  async next(
    predicate: (value: Record<string, unknown>) => boolean,
    timeoutMs: number,
    message: string
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const separator = this.buffer.indexOf("\n\n");
      if (separator >= 0) {
        const block = this.buffer.slice(0, separator);
        this.buffer = this.buffer.slice(separator + 2);
        const value = parseSSEBlock(block);
        if (value && predicate(value)) return value;
        continue;
      }
      const result = await withTimeout(this.reader.read(), Math.max(1, deadline - Date.now()), message);
      if (result.done) throw new Error(`${message}: stream closed`);
      this.buffer += new TextDecoder().decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
    }
    throw new Error(message);
  }

  async close(): Promise<void> {
    this.abort.abort();
    try {
      await this.reader.cancel();
    } catch {
      // An expected server shutdown may already have errored the stream.
    }
  }

  async waitForClosure(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        const result = await withTimeout(
          this.reader.read(),
          Math.max(1, deadline - Date.now()),
          "SSE connection remained open after shutdown"
        );
        if (result.done) return true;
      }
      return false;
    } catch (error) {
      if (error instanceof Error && error.message === "SSE connection remained open after shutdown") throw error;
      return true;
    }
  }
}

function spawnRunner(role: Role, nodeNumber: number, artifactDirectory: string, membershipPath?: string): Runner {
  const nodeID = role === "gateway" ? "gateway-main" : "asset-alpha";
  const summaryPath = join(artifactDirectory, `${role}.summary.json`);
  const args = ["--mode", role, "--node-id", nodeID, "--node-number", String(nodeNumber), "--summary", summaryPath];
  if (membershipPath) args.push("--membership", membershipPath);
  const child = fork(runnerPath, args, {
    cwd: packageRoot,
    env: { ...process.env, ATLAS_LINK_JOIN_KEY: "seed-389-shared-authentication-key" },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  const readyDeferred = deferred<ReadyMessage>();
  const summaryDeferred = deferred<SummaryMessage>();
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => stdout.push(chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
  child.on("message", (message: unknown) => {
    if (!isChildMessage(message)) return;
    if (message.type === "runner:ready") readyDeferred.resolve(message);
    if (message.type === "runner:summary") summaryDeferred.resolve(message);
  });
  child.once("error", (error) => {
    readyDeferred.reject(error);
    summaryDeferred.reject(error);
  });
  const exit = once(child, "exit").then(([code, signal]) => ({
    code: typeof code === "number" ? code : null,
    signal: typeof signal === "string" ? (signal as NodeJS.Signals) : null
  }));
  return {
    role,
    child,
    ready: readyDeferred.promise,
    summary: summaryDeferred.promise,
    exit,
    stdout,
    stderr,
    summaryPath
  };
}

function positionPublication(): Record<string, unknown> {
  return {
    type: "state",
    resource_type: "entity",
    resource: {
      alias: "Alpha",
      entity_id: "asset-alpha",
      entity_type: "asset",
      subtype: null,
      components: { geometry: { type: "Point", coordinates: [-71.8, 42.2, 101] } },
      metadata: {
        created_at: "2026-09-12T12:00:00Z",
        updated_at: "2026-09-12T12:00:01Z",
        version: 1
      }
    },
    observation_time: "2026-09-12T12:00:01Z",
    path: "field",
    confirmation: "awaiting_core",
    operation_id: "acceptance-position",
    runtime_id: "acceptance-runtime"
  };
}

function assertRadioProfile(value: unknown, role: string): void {
  assert.equal(property(value, "available"), true, `${role} radio profile availability`);
  assert.deepEqual(property(value, "differences"), [], `${role} radio profile differences`);
  assert.equal(property(property(value, "actual"), "firmware_version"), "2.7.15", `${role} firmware readback`);
}

function assertPublishedPosition(value: unknown, altitude: number): void {
  const record = findPictureRecord(value);
  assert.ok(record, "Shared Picture contains asset-alpha");
  assert.deepEqual(record.source, { role: "asset", id: "asset-alpha" });
  const state = requiredRecord(record.state, "picture record state");
  assert.equal(state.entity_id, "asset-alpha");
  const components = requiredRecord(state.components, "picture record components");
  const geometry = requiredRecord(components.geometry, "picture record geometry");
  assert.deepEqual(geometry.coordinates, [-71.8, 42.2, altitude]);
}

function findPictureRecord(value: unknown): Record<string, unknown> | undefined {
  const records = property(value, "records");
  if (!Array.isArray(records)) return undefined;
  return records.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.resource_type === "entity" && candidate.id === "asset-alpha"
  );
}

function assertCleanLifecycleShutdown(summary: SummaryMessage): void {
  assert.equal(summary.outcome, "stopped", `${summary.mode} runner outcome`);
  assert.equal(summary.error, undefined, `${summary.mode} runner error`);
  assert.equal(summary.lifecycle_cleanup.active_connections, 0, `${summary.mode} lifecycle-owned active connections`);
  assert.equal(summary.lifecycle_cleanup.pending_writes, 0, `${summary.mode} lifecycle-owned pending writes`);
  assert.ok(summary.lifecycle_cleanup.configuration_commits > 0, `${summary.mode} exercised configuration commits`);
  assert.ok(summary.lifecycle_cleanup.configuration_writes > 0, `${summary.mode} exercised configuration writes`);
  assert.ok(summary.lifecycle_cleanup.radio_packets_sent > 0, `${summary.mode} sent application packets`);
  assert.ok(summary.lifecycle_cleanup.radio_packets_received > 0, `${summary.mode} received application packets`);
}

async function openSSE(url: string, connectTimeoutMs = 5_000): Promise<SSEReader> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), connectTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { signal: abort.signal });
  } catch (error) {
    throw new Error(`GET ${url} did not establish an event stream: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(response.status, 200, `GET ${url}`);
  if (!response.body) throw new Error(`GET ${url} did not return an event stream`);
  return new SSEReader(response.body.getReader(), abort);
}

async function waitForSSEClosure(reader: SSEReader, timeoutMs: number): Promise<boolean> {
  return reader.waitForClosure(timeoutMs);
}

function parseSSEBlock(block: string): Record<string, unknown> | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return undefined;
  const value: unknown = JSON.parse(data);
  return isRecord(value) ? value : undefined;
}

async function getJSON(url: string): Promise<unknown> {
  const response = await fetch(url);
  const value: unknown = await response.json();
  assert.equal(response.status, 200, `GET ${url}: ${JSON.stringify(value)}`);
  return value;
}

async function postJSON(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const value: unknown = await response.json();
  assert.ok(response.status >= 200 && response.status < 300, `POST ${url}: ${JSON.stringify(value)}`);
  return value;
}

async function waitForJSON(
  url: string,
  accept: (value: unknown) => boolean,
  timeoutMs: number,
  message: string
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let latest: unknown;
  while (Date.now() < deadline) {
    try {
      latest = await getJSON(url);
      if (accept(latest)) return latest;
    } catch (error) {
      latest = errorMessage(error);
    }
    await delay(50);
  }
  throw new Error(`${message}; latest observation: ${JSON.stringify(latest)}`);
}

async function assertPortReusable(port: number): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolveListen);
    });
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose()))
    );
  }
}

function baseURL(address: Address): string {
  return `http://${address.host}:${address.port}`;
}

function property(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isChildMessage(value: unknown): value is ChildMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  return ["runner:ready", "runner:summary", "lab:register", "lab:radio"].includes(value.type);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeJSON(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
