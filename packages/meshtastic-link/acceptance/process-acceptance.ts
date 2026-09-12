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
  active_resources: {
    after_lifecycle_close: string[];
    after_ipc_disconnect: string[];
  };
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
  name: string;
  role: Role;
  child: ChildProcess;
  ready: Promise<ReadyMessage>;
  summary: Promise<SummaryMessage>;
  disconnected: Promise<void>;
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
  scenario: "required" | "nightly";
  fault: "none" | "drop-asset-private-packets";
  seed: number;
  controlled_values: {
    node_numbers: number[];
    private_channel_key_byte: number;
    join_key_labels: string[];
  };
  uncontrolled_random_sources: string[];
  artifact_directory: string;
  timings_ms: Record<string, number>;
  gateway?: { ready: ReadyMessage; status: unknown; profile: unknown };
  asset?: { ready: ReadyMessage; status: unknown; profile: unknown };
  state_submission?: unknown;
  state_event?: unknown;
  shared_picture?: unknown;
  application_confirmation?: unknown;
  application_rejection?: unknown;
  incomplete_operation_cleanup?: unknown;
  startup_rejection?: unknown;
  join_rejection?: unknown;
  shutdown_stream_closed?: boolean;
  summaries?: SummaryMessage[];
  exits?: Array<{ name: string; role: Role; code: number | null; signal: NodeJS.Signals | null }>;
  ports_reused?: number[];
  forced_terminations?: string[];
  cleanup_failures?: string[];
  failure?: string;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(packageRoot, "../..");
const runnerPath = join(packageRoot, "dist", "acceptance", "process-runner.js");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const artifactParent = process.env.ATLAS_LINK_ACCEPTANCE_ARTIFACTS ?? join(repositoryRoot, ".tmp", "link-acceptance");
const scenario = process.env.ATLAS_LINK_ACCEPTANCE_MODE === "nightly" ? "nightly" : "required";
const fault = acceptanceFault();
const seed = acceptanceSeed();
const nodeNumbers = Array.from({ length: 5 }, (_, index) => 100_000 + seed * 10 + index);
const privateChannelKeyByte = (seed % 255) + 1;
const sharedJoinKey = `atlas-link-acceptance-${seed}-shared-authentication-key`;
const rejectedJoinKey = `atlas-link-acceptance-${seed}-rejected-authentication-key`;
const httpRequestTimeoutMs = 15_000;
// Explicit phase deadlines total 207 seconds; cleanup adds 10 seconds, leaving 23 seconds for evidence writes.
const processTestTimeoutMs = 240_000;

test("runs compiled Link processes through joining, application settlement, rejected startup and join, and shutdown", {
  timeout: processTestTimeoutMs
}, async () => {
  const scenarioStarted = performance.now();
  const artifactDirectory = join(artifactParent, `${scenario}-${fault}-seed-${seed}-${randomUUID()}`);
  await mkdir(artifactDirectory, { recursive: true });
  process.stdout.write(`Atlas Link acceptance artifacts: ${artifactDirectory}\n`);
  const observation: ProcessObservation = {
    revision,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    scenario,
    fault,
    seed,
    controlled_values: {
      node_numbers: nodeNumbers,
      private_channel_key_byte: privateChannelKeyByte,
      join_key_labels: ["shared", "rejected"]
    },
    uncontrolled_random_sources: [
      "Link service sessions",
      "join attempt identifiers",
      "transport operation and message identifiers",
      "operating-system process and network scheduling"
    ],
    artifact_directory: artifactDirectory,
    timings_ms: {}
  };
  const expected = {
    processes: ["startup-rejected-gateway", "join-rejected-gateway", "join-rejected-asset", "gateway", "asset"],
    lifecycle: "active",
    authenticated_join: "joined",
    rejected_startup: "Gateway membership identity does not match --node-id",
    rejected_join: "Asset remains discovering after rejecting a challenge authenticated with another key",
    application_settlement: ["confirmed", "rejected"],
    incomplete_operation_shutdown: { status: "failed", reason: "link service stopped" },
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

  const network = new LaboratoryNetwork(fault === "drop-asset-private-packets" ? nodeNumbers[4] : undefined);
  const runners: Runner[] = [];
  let gatewayEvents: SSEReader | undefined;
  let assetEvents: SSEReader | undefined;
  let shutdownEvents: SSEReader | undefined;
  let failure: unknown;
  try {
    const rejectedStartupMembershipPath = join(artifactDirectory, "startup-rejected-membership.json");
    await writeMembership(rejectedStartupMembershipPath, "another-gateway");
    const startupRejected = spawnRunner(
      "startup-rejected-gateway",
      "gateway",
      "gateway-startup-rejected",
      nodeNumbers[0]!,
      artifactDirectory,
      sharedJoinKey,
      rejectedStartupMembershipPath
    );
    runners.push(startupRejected);
    new LaboratoryNetwork().add(startupRejected);
    await withTimeout(
      startupRejected.summary,
      30_000,
      "Gateway rejected-startup process did not publish its failure summary"
    );
    const startupSummary = await readFinalSummary(startupRejected);
    assertRejectedStartupCleanup(startupSummary);
    observation.startup_rejection = startupSummary;
    observation.timings_ms.startup_rejected = elapsed(scenarioStarted);

    const rejectedJoinMembershipPath = join(artifactDirectory, "join-rejected-membership.json");
    await writeMembership(rejectedJoinMembershipPath, "gateway-join-rejected");
    const rejectedJoinNetwork = new LaboratoryNetwork();
    const rejectedJoinGateway = spawnRunner(
      "join-rejected-gateway",
      "gateway",
      "gateway-join-rejected",
      nodeNumbers[1]!,
      artifactDirectory,
      sharedJoinKey,
      rejectedJoinMembershipPath
    );
    runners.push(rejectedJoinGateway);
    rejectedJoinNetwork.add(rejectedJoinGateway);
    const rejectedJoinGatewayReady = await withTimeout(
      rejectedJoinGateway.ready,
      30_000,
      "join-rejection Gateway did not become ready"
    );
    const rejectedJoinAsset = spawnRunner(
      "join-rejected-asset",
      "asset",
      "asset-join-rejected",
      nodeNumbers[2]!,
      artifactDirectory,
      rejectedJoinKey
    );
    runners.push(rejectedJoinAsset);
    rejectedJoinNetwork.add(rejectedJoinAsset);
    const rejectedJoinAssetReady = await withTimeout(
      rejectedJoinAsset.ready,
      30_000,
      "join-rejection Asset did not become ready"
    );
    await waitForCondition(
      () =>
        rejectedJoinNetwork.hasTransmission({
          from: nodeNumbers[1]!,
          to: nodeNumbers[2]!,
          channel: 0
        }),
      15_000,
      "Gateway did not send the mismatched-key Asset an authenticated join challenge"
    );
    const rejectedJoinStatus = await getJSON(`${baseURL(rejectedJoinAssetReady.address)}/v1/status`);
    assert.equal(property(rejectedJoinStatus, "lifecycle"), "discovering");
    assert.equal(property(property(rejectedJoinStatus, "joining"), "state"), "discovering");
    observation.join_rejection = {
      gateway: rejectedJoinGatewayReady,
      asset: rejectedJoinAssetReady,
      asset_status: rejectedJoinStatus,
      public_channel_transmissions: rejectedJoinNetwork.transmissionCount(0)
    };
    observation.timings_ms.join_rejected = elapsed(scenarioStarted);

    const membershipPath = join(artifactDirectory, "gateway-membership.json");
    await writeMembership(membershipPath, "gateway-main");

    const gateway = spawnRunner(
      "gateway",
      "gateway",
      "gateway-main",
      nodeNumbers[3]!,
      artifactDirectory,
      sharedJoinKey,
      membershipPath
    );
    runners.push(gateway);
    network.add(gateway);
    const gatewayReady = await withTimeout(gateway.ready, 30_000, "Gateway process did not become ready");
    observation.timings_ms.gateway_ready = elapsed(scenarioStarted);

    const asset = spawnRunner("asset", "asset", "asset-alpha", nodeNumbers[4]!, artifactDirectory, sharedJoinKey);
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
    assetEvents = await openSSE(`${assetBase}/v1/events?after=0&client_id=process-acceptance`);

    const confirmedSubmission = await postJSON(`${assetBase}/v1/messages`, {
      message: {
        type: "subscription",
        action: "add",
        selector: { kind: "resource_type", resource_type: "entity" }
      },
      destination: { role: "gateway", id: "gateway-main" },
      operation_id: "acceptance-subscription-confirmed"
    });
    assert.equal(property(confirmedSubmission, "status"), "queued");
    const confirmedPacketSent = await assetEvents.next(
      (value) =>
        property(value, "type") === "transport" &&
        property(property(value, "event"), "type") === "packet_sent" &&
        property(property(value, "event"), "operation_id") === "acceptance-subscription-confirmed",
      15_000,
      "Asset did not expose radio acceptance for the confirmed subscription"
    );
    const beforeApplicationConfirmation = await getJSON(`${assetBase}/v1/operations/acceptance-subscription-confirmed`);
    assert.equal(property(beforeApplicationConfirmation, "status"), "queued");
    const confirmedInbound = await gatewayEvents.next(
      (value) => isSettlementEvent(value, "acceptance-subscription-confirmed"),
      15_000,
      "Gateway did not expose the confirmed subscription for application settlement"
    );
    const confirmedSettlementID = requiredString(
      property(property(confirmedInbound, "event"), "settlement_id"),
      "confirmed settlement ID"
    );
    const confirmedSettlement = await postJSON(
      `${gatewayBase}/v1/inbound/${encodeURIComponent(confirmedSettlementID)}/settle`,
      { accepted: true }
    );
    assert.equal(property(confirmedSettlement, "settled"), true);
    const confirmedOperation = await waitForJSON(
      `${assetBase}/v1/operations/acceptance-subscription-confirmed`,
      (value) => property(value, "status") === "confirmed",
      15_000,
      "Asset operation did not reach application-confirmed status"
    );
    observation.application_confirmation = {
      submission: confirmedSubmission,
      radio_accepted_event: confirmedPacketSent,
      before_application_settlement: beforeApplicationConfirmation,
      inbound: confirmedInbound,
      settlement: confirmedSettlement,
      operation: confirmedOperation
    };

    const rejectedSubmission = await postJSON(`${assetBase}/v1/messages`, {
      message: {
        type: "subscription",
        action: "remove",
        selector: { kind: "resource_type", resource_type: "entity" }
      },
      destination: { role: "gateway", id: "gateway-main" },
      operation_id: "acceptance-subscription-rejected"
    });
    assert.equal(property(rejectedSubmission, "status"), "queued");
    const rejectedPacketSent = await assetEvents.next(
      (value) =>
        property(value, "type") === "transport" &&
        property(property(value, "event"), "type") === "packet_sent" &&
        property(property(value, "event"), "operation_id") === "acceptance-subscription-rejected",
      15_000,
      "Asset did not expose radio acceptance for the rejected subscription"
    );
    const beforeApplicationRejection = await getJSON(`${assetBase}/v1/operations/acceptance-subscription-rejected`);
    assert.equal(property(beforeApplicationRejection, "status"), "queued");
    const rejectedInbound = await gatewayEvents.next(
      (value) => isSettlementEvent(value, "acceptance-subscription-rejected"),
      15_000,
      "Gateway did not expose the subscription selected for application rejection"
    );
    const rejectedSettlementID = requiredString(
      property(property(rejectedInbound, "event"), "settlement_id"),
      "rejected settlement ID"
    );
    const rejectionReason = "laboratory application rejected subscription";
    const rejectedSettlement = await postJSON(
      `${gatewayBase}/v1/inbound/${encodeURIComponent(rejectedSettlementID)}/settle`,
      { accepted: false, reason: rejectionReason }
    );
    assert.equal(property(rejectedSettlement, "settled"), true);
    const rejectedOperation = await waitForJSON(
      `${assetBase}/v1/operations/acceptance-subscription-rejected`,
      (value) => property(value, "status") === "rejected",
      15_000,
      "Asset operation did not expose application rejection"
    );
    assert.equal(property(rejectedOperation, "reason"), rejectionReason);
    observation.application_rejection = {
      submission: rejectedSubmission,
      radio_accepted_event: rejectedPacketSent,
      before_application_settlement: beforeApplicationRejection,
      inbound: rejectedInbound,
      settlement: rejectedSettlement,
      operation: rejectedOperation
    };

    await waitForJSON(
      `${assetBase}/v1/status`,
      hasNoPendingTransportWork,
      15_000,
      "Asset retained pending transport work after application settlements"
    );
    await waitForJSON(
      `${gatewayBase}/v1/status`,
      hasNoPendingTransportWork,
      15_000,
      "Gateway retained pending transport work after application settlements"
    );
    observation.timings_ms.application_settlements = elapsed(scenarioStarted);

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

    const incompleteSubmission = await postJSON(`${assetBase}/v1/messages`, {
      message: {
        type: "subscription",
        action: "add",
        selector: { kind: "record", resource_type: "entity", id: "shutdown-pending" }
      },
      destination: { role: "gateway", id: "gateway-main" },
      operation_id: "acceptance-subscription-incomplete"
    });
    assert.equal(property(incompleteSubmission, "status"), "queued");
    const incompletePacketSent = await assetEvents.next(
      (value) =>
        property(value, "type") === "transport" &&
        property(property(value, "event"), "type") === "packet_sent" &&
        property(property(value, "event"), "operation_id") === "acceptance-subscription-incomplete",
      15_000,
      "Asset did not expose radio acceptance for the shutdown-pending subscription"
    );
    const incompleteInbound = await gatewayEvents.next(
      (value) => isSettlementEvent(value, "acceptance-subscription-incomplete"),
      15_000,
      "Gateway did not expose the shutdown-pending subscription"
    );
    const assetPendingStatus = await waitForJSON(
      `${assetBase}/v1/status`,
      (value) => property(property(value, "transport"), "confirmed_pending") === 1,
      15_000,
      "Asset did not retain the intentionally incomplete operation before shutdown"
    );
    const gatewayPendingStatus = await waitForJSON(
      `${gatewayBase}/v1/status`,
      (value) => property(property(value, "transport"), "inbound_awaiting_settlement") === 1,
      15_000,
      "Gateway did not retain the intentionally incomplete settlement before shutdown"
    );
    const incompleteFailure = assetEvents.next(
      (value) => {
        const event = property(value, "event");
        const result = property(event, "result");
        return (
          property(value, "type") === "transport" &&
          property(event, "type") === "operation" &&
          property(result, "operation_id") === "acceptance-subscription-incomplete" &&
          property(result, "status") === "failed"
        );
      },
      15_000,
      "Asset shutdown did not fail the incomplete operation"
    );
    void incompleteFailure.catch(() => undefined);
    observation.incomplete_operation_cleanup = {
      submission: incompleteSubmission,
      radio_accepted_event: incompletePacketSent,
      inbound: incompleteInbound,
      asset_before_shutdown: assetPendingStatus,
      gateway_before_shutdown: gatewayPendingStatus
    };

    shutdownEvents = await openSSE(`${gatewayBase}/v1/events?client_id=shutdown-observer`);
    for (const runner of runners) runner.child.kill("SIGTERM");
    const shutdownStream = waitForSSEClosure(shutdownEvents, 15_000);
    const exitsPromise = Promise.all(
      runners.map((runner) => withTimeout(runner.exit, 15_000, `${runner.name} did not exit`))
    );
    const shutdown = Promise.all([shutdownStream, exitsPromise]);
    void shutdown.catch(() => undefined);
    await Promise.all(
      runners.map((runner) => withTimeout(runner.summary, 5_000, `${runner.name} did not publish its summary`))
    );
    const summaries = await Promise.all(runners.map(readFinalSummary));
    const incompleteResult = await incompleteFailure;
    assert.equal(property(property(property(incompleteResult, "event"), "result"), "reason"), "link service stopped");
    observation.incomplete_operation_cleanup = {
      ...requiredRecord(observation.incomplete_operation_cleanup, "incomplete operation cleanup evidence"),
      shutdown_result: incompleteResult
    };
    observation.summaries = summaries;
    for (const [index, summary] of summaries.entries()) {
      if (runners[index]?.name === "startup-rejected-gateway") assertRejectedStartupCleanup(summary);
      else assertCleanLifecycleShutdown(summary);
    }
    const [shutdownStreamClosed, exits] = await shutdown;
    observation.shutdown_stream_closed = shutdownStreamClosed;
    assert.equal(observation.shutdown_stream_closed, true);
    observation.exits = exits.map((exit, index) => ({
      name: runners[index]?.name ?? "unknown",
      role: runners[index]?.role ?? "asset",
      ...exit
    }));
    observation.timings_ms.shutdown_complete = elapsed(scenarioStarted);
    for (const [index, exit] of exits.entries()) {
      const runner = runners[index];
      if (runner?.name === "startup-rejected-gateway") {
        assert.notEqual(exit.code, 0, "rejected-startup process must not exit successfully");
        continue;
      }
      assert.equal(exit.code, 0, `${runner?.name} process exit code`);
      assert.equal(exit.signal, null, `${runner?.name} process exit signal`);
    }

    const ports = [gatewayReady.address.port, assetReady.address.port];
    for (const port of ports) await assertPortReusable(port);
    observation.ports_reused = ports;
    observation.timings_ms.total = elapsed(scenarioStarted);
  } catch (error) {
    failure = error;
    observation.failure = errorMessage(error);
  } finally {
    await gatewayEvents?.close();
    await assetEvents?.close();
    await shutdownEvents?.close();
    for (const runner of runners) {
      if (runner.child.exitCode === null && runner.child.signalCode === null) runner.child.kill("SIGTERM");
    }
    const gracefulCleanup = await Promise.allSettled(
      runners.map((runner) => withTimeout(runner.exit, 5_000, `${runner.name} cleanup timed out`))
    );
    const forced: string[] = [];
    for (const runner of runners) {
      if (runner.child.exitCode === null && runner.child.signalCode === null) {
        forced.push(runner.name);
        runner.child.kill("SIGKILL");
      }
    }
    observation.forced_terminations = forced;
    const forcedCleanup = await Promise.allSettled(
      runners.map((runner) => withTimeout(runner.exit, 5_000, `${runner.name} did not exit after SIGKILL`))
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
        await writeFile(join(artifactDirectory, `${runner.name}.stdout.log`), runner.stdout.join(""));
        await writeFile(join(artifactDirectory, `${runner.name}.stderr.log`), runner.stderr.join(""));
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
  private readonly transmissions: RadioMessage[] = [];

  constructor(private readonly dropPrivateFrom?: number) {}

  hasTransmission(expected: Pick<RadioMessage, "from" | "to" | "channel">): boolean {
    return this.transmissions.some(
      (message) => message.from === expected.from && message.to === expected.to && message.channel === expected.channel
    );
  }

  transmissionCount(channel: number): number {
    return this.transmissions.filter((message) => message.channel === channel).length;
  }

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
    this.transmissions.push(message);
    if (message.from === this.dropPrivateFrom && message.channel === 1) return;
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

function spawnRunner(
  name: string,
  role: Role,
  nodeID: string,
  nodeNumber: number,
  artifactDirectory: string,
  joinKey: string,
  membershipPath?: string
): Runner {
  const summaryPath = join(artifactDirectory, `${name}.summary.json`);
  const args = ["--mode", role, "--node-id", nodeID, "--node-number", String(nodeNumber), "--summary", summaryPath];
  if (membershipPath) args.push("--membership", membershipPath);
  const child = fork(runnerPath, args, {
    cwd: packageRoot,
    env: { ...process.env, ATLAS_LINK_JOIN_KEY: joinKey },
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
  const disconnected = once(child, "disconnect").then(() => undefined);
  return {
    name,
    role,
    child,
    ready: readyDeferred.promise,
    summary: summaryDeferred.promise,
    disconnected,
    exit,
    stdout,
    stderr,
    summaryPath
  };
}

async function readFinalSummary(runner: Runner): Promise<SummaryMessage> {
  await withTimeout(runner.disconnected, 2_000, `${runner.name} did not disconnect after publishing its summary`);
  const value: unknown = JSON.parse(await readFile(runner.summaryPath, "utf8"));
  if (!isSummaryMessage(value)) throw new Error(`${runner.name} wrote an invalid summary`);
  return value;
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

async function writeMembership(path: string, gatewayNodeID: string): Promise<void> {
  await writeJSON(
    path,
    {
      gateway_node_id: gatewayNodeID,
      gateway_generation: 0,
      asset_generations: {},
      channel_index: 1,
      channel_name: "ATLAS",
      channel_key_base64: Buffer.alloc(32, privateChannelKeyByte).toString("base64")
    },
    0o600
  );
}

function isSettlementEvent(value: Record<string, unknown>, operationID: string): boolean {
  const event = property(value, "event");
  return (
    property(value, "type") === "transport" &&
    property(event, "type") === "message" &&
    property(event, "operation_id") === operationID &&
    property(event, "addressed_to_local") === true &&
    property(event, "requires_settlement") === true
  );
}

function hasNoPendingTransportWork(value: unknown): boolean {
  const transport = property(value, "transport");
  return (
    property(transport, "queue_depth") === 0 &&
    property(transport, "confirmed_pending") === 0 &&
    property(transport, "inbound_awaiting_settlement") === 0 &&
    property(transport, "incomplete_reassemblies") === 0
  );
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
  assert.equal(summary.active_resources.after_ipc_disconnect.includes("TCPServerWrap"), false);
  assert.equal(summary.active_resources.after_ipc_disconnect.includes("TCPSocketWrap"), false);
}

function assertRejectedStartupCleanup(summary: SummaryMessage): void {
  assert.equal(summary.outcome, "failed", "rejected-startup runner outcome");
  assert.match(summary.error ?? "", /Gateway membership identity does not match --node-id/);
  assert.equal(summary.lifecycle_cleanup.active_connections, 0, "rejected-startup lifecycle-owned active connections");
  assert.equal(summary.lifecycle_cleanup.pending_writes, 0, "rejected-startup lifecycle-owned pending writes");
  assert.equal(
    summary.active_resources.after_ipc_disconnect.includes("TCPServerWrap"),
    false,
    "rejected-startup HTTP listener resource"
  );
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

async function getJSON(url: string, signal?: AbortSignal): Promise<unknown> {
  return withHTTPRequestDeadline(signal, async (requestSignal) => {
    const response = await fetch(url, { signal: requestSignal });
    const value: unknown = await response.json();
    assert.equal(response.status, 200, `GET ${url}: ${JSON.stringify(value)}`);
    return value;
  });
}

async function postJSON(url: string, body: unknown): Promise<unknown> {
  return withHTTPRequestDeadline(undefined, async (signal) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
    const value: unknown = await response.json();
    assert.ok(response.status >= 200 && response.status < 300, `POST ${url}: ${JSON.stringify(value)}`);
    return value;
  });
}

async function withHTTPRequestDeadline<T>(
  signal: AbortSignal | undefined,
  request: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (signal) return request(signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), httpRequestTimeoutMs);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
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
    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    try {
      latest = await getJSON(url, controller.signal);
      if (accept(latest)) return latest;
    } catch (error) {
      latest = errorMessage(error);
    } finally {
      clearTimeout(requestTimeout);
    }
    const retryDelay = Math.min(50, deadline - Date.now());
    if (retryDelay > 0) await delay(retryDelay);
  }
  throw new Error(`${message}; latest observation: ${JSON.stringify(latest)}`);
}

async function waitForCondition(accept: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (accept()) return;
    await delay(25);
  }
  throw new Error(message);
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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is not a nonempty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isChildMessage(value: unknown): value is ChildMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  return ["runner:ready", "runner:summary", "lab:register", "lab:radio"].includes(value.type);
}

function isSummaryMessage(value: unknown): value is SummaryMessage {
  if (!isRecord(value) || value.type !== "runner:summary") return false;
  const lifecycleCleanup = value.lifecycle_cleanup;
  const device = value.device;
  const resources = value.active_resources;
  return (
    (value.mode === "asset" || value.mode === "gateway") &&
    typeof value.nodeID === "string" &&
    typeof value.duration_ms === "number" &&
    (value.outcome === "stopped" || value.outcome === "failed") &&
    isRecord(lifecycleCleanup) &&
    isRecord(device) &&
    isRecord(resources) &&
    Array.isArray(resources.after_lifecycle_close) &&
    resources.after_lifecycle_close.every((item) => typeof item === "string") &&
    Array.isArray(resources.after_ipc_disconnect) &&
    resources.after_ipc_disconnect.every((item) => typeof item === "string")
  );
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

function acceptanceSeed(): number {
  const raw = process.env.ATLAS_LINK_ACCEPTANCE_SEED ?? "390";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new Error("ATLAS_LINK_ACCEPTANCE_SEED must be an integer from 1 through 100000");
  }
  return value;
}

function acceptanceFault(): "none" | "drop-asset-private-packets" {
  const value = process.env.ATLAS_LINK_ACCEPTANCE_FAULT;
  if (value === undefined || value === "") return "none";
  if (value === "drop-asset-private-packets") return value;
  throw new Error("ATLAS_LINK_ACCEPTANCE_FAULT must be drop-asset-private-packets when set");
}
