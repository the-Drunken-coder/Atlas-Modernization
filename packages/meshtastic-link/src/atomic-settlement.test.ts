import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.js";
import { AtlasRadioSDK } from "./sdk.js";
import { LinkHTTPServer, LinkService } from "./service.js";
import { SimulatedPacketNetwork } from "./simulation.js";
import { positionPublication } from "./test-fixtures.js";
import { LinkTransport } from "./transport.js";
import type { TaskReport } from "./types.js";

describe("atomic Task settlement", () => {
  it("accepts an inbound Task and queues its report through the HTTP API", async () => {
    const harness = await createHarness();
    let settlementID: string | undefined;
    harness.service.onEvent((event) => {
      if (
        event.type === "transport" &&
        event.event.type === "message" &&
        event.event.message.type === "task_delivery"
      ) {
        settlementID = event.event.settlement_id;
      }
    });
    harness.gateway.onEvent((event) => {
      if (event.type === "message" && event.message.type === "task_report" && event.addressed_to_local) {
        harness.gateway.settleInbound(event.settlement_id, true);
      }
    });
    harness.gateway.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-http") },
      { destination: harness.asset.node, operationID: "deliver-http" }
    );
    await harness.clock.advanceBy(1_000);
    expect(settlementID).toBeDefined();

    const before = harness.network.metrics().radio_submissions;
    const result = await fetch(`${harness.base}/v1/inbound/${encodeURIComponent(settlementID!)}/settle-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        report: report("task-http"),
        destination: harness.gateway.node,
        operation_id: "report-http"
      })
    }).then(async (response) => ({ response, body: await response.json() }));

    expect(result.response.status).toBe(202);
    expect(result.body).toMatchObject({
      accepted: true,
      receipt: { operation_id: expect.stringMatching(/^control_/), status: "queued" },
      report: { operation_id: "report-http", status: "queued" }
    });
    const retry = await fetch(`${harness.base}/v1/inbound/${encodeURIComponent(settlementID!)}/settle-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        report: report("task-http"),
        destination: harness.gateway.node,
        operation_id: "report-http"
      })
    });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual(result.body);
    const conflict = harness.asset.settleInboundWithTaskReport(
      settlementID!,
      {
        ...report("task-http"),
        runtime_id: "different-runtime"
      },
      harness.gateway.node,
      "report-http"
    );
    expect(conflict.accepted).toBe(false);
    await harness.clock.advanceBy(0);
    expect(harness.network.metrics().radio_submissions - before).toBe(1);
    expect(harness.asset.diagnostics()).toMatchObject({ confirmed_pending: 1, inbound_awaiting_settlement: 0 });
    await harness.clock.advanceBy(1_000);
    expect(harness.gateway.status("deliver-http")?.status).toBe("confirmed");
    expect(harness.asset.status("report-http")?.status).toBe("confirmed");
    await closeHarness(harness);
  });

  it("exposes the same atomic operation through the typed SDK", async () => {
    const harness = await createHarness();
    let settlementID: string | undefined;
    harness.asset.onEvent((event) => {
      if (event.type === "message" && event.message.type === "task_delivery") settlementID = event.settlement_id;
    });
    harness.gateway.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-sdk") },
      { destination: harness.asset.node, operationID: "deliver-sdk" }
    );
    await harness.clock.advanceBy(1_000);
    expect(settlementID).toBeDefined();

    const result = new AtlasRadioSDK(harness.asset).settleInboundWithTaskReport(
      settlementID!,
      report("task-sdk"),
      harness.gateway.node,
      "report-sdk"
    );
    expect(result).toMatchObject({
      accepted: true,
      receipt: { status: "queued" },
      report: { operation_id: "report-sdk", status: "queued" }
    });
    expect(harness.asset.diagnostics().inbound_awaiting_settlement).toBe(0);
    await closeHarness(harness);
  });

  it("leaves a pending settlement untouched when report capacity is unavailable", async () => {
    const harness = await createHarness(1);
    let settlementID: string | undefined;
    harness.asset.onEvent((event) => {
      if (event.type === "message" && event.message.type === "task_delivery") settlementID = event.settlement_id;
    });
    harness.gateway.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-capacity") },
      { destination: harness.asset.node, operationID: "deliver-capacity" }
    );
    await harness.clock.advanceBy(1_000);
    expect(settlementID).toBeDefined();

    const result = harness.asset.settleInboundWithTaskReport(
      settlementID!,
      report("task-capacity"),
      harness.gateway.node,
      "report-capacity"
    );
    expect(result).toMatchObject({
      accepted: false,
      receipt: { status: "failed", reason: "outbound queue capacity is exhausted" },
      report: { status: "failed", reason: "outbound queue capacity is exhausted" }
    });
    expect(harness.asset.status("report-capacity")).toBeUndefined();
    expect(harness.asset.diagnostics()).toMatchObject({ queue_depth: 0, inbound_awaiting_settlement: 1 });
    expect(harness.asset.settleInbound(settlementID!, true)).toBe(true);
    await closeHarness(harness);
  });

  it("rejects a mismatched report without accepting the inbound Task", async () => {
    const harness = await createHarness();
    let settlementID: string | undefined;
    harness.asset.onEvent((event) => {
      if (event.type === "message" && event.message.type === "task_delivery") settlementID = event.settlement_id;
    });
    harness.gateway.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-identity") },
      { destination: harness.asset.node, operationID: "deliver-identity" }
    );
    await harness.clock.advanceBy(1_000);
    const result = harness.asset.settleInboundWithTaskReport(
      settlementID!,
      report("different-task"),
      { role: "gateway", id: "gateway" },
      "report-identity"
    );
    expect(result.accepted).toBe(false);
    expect(result.report.reason).toBe("settlement does not belong to the reported Task");
    expect(harness.asset.diagnostics().inbound_awaiting_settlement).toBe(1);
    await closeHarness(harness);
  });

  it("admits a newer unsent state when it replaces the full queue", async () => {
    const harness = await createHarness(1);
    const first = harness.asset.submit(positionPublication(1), { operationID: "position-old" });
    const second = harness.asset.submit(positionPublication(2), { operationID: "position-new" });
    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");
    expect(harness.asset.status("position-old")).toMatchObject({
      status: "failed",
      reason: "replaced by newer unsent state"
    });
    expect(harness.asset.diagnostics().queue_depth).toBe(1);
    await closeHarness(harness);
  });
});

type Harness = {
  clock: VirtualClock;
  network: SimulatedPacketNetwork;
  gateway: LinkTransport;
  asset: LinkTransport;
  service: LinkService;
  base: string;
  close: () => Promise<void>;
};

async function createHarness(queueLimit?: number, confirmedLimit?: number): Promise<Harness> {
  const clock = new VirtualClock();
  const network = new SimulatedPacketNetwork({ seed: 913, clock, contentionWindowAirtimes: 0 });
  const gatewayRadio = network.addRadio("gateway", 1);
  const assetRadio = network.addRadio("asset-alpha", 2);
  network.connect("gateway", "asset-alpha");
  const gateway = new LinkTransport({
    node: { role: "gateway", id: "gateway" },
    sourceGeneration: 1,
    serviceSession: "gateway-session",
    radio: gatewayRadio,
    clock,
    frameEncoding: "deflate-v3"
  });
  const service = new LinkService({
    mode: "asset",
    nodeID: "asset-alpha",
    clock,
    gatewayNode: gateway.node
  });
  const asset = new LinkTransport({
    node: service.node,
    sourceGeneration: 1,
    serviceSession: service.serviceSession,
    radio: assetRadio,
    clock,
    frameEncoding: "deflate-v3",
    ...(queueLimit === undefined ? {} : { queueLimit }),
    ...(confirmedLimit === undefined ? {} : { confirmedLimit }),
    picture: service.picture
  });
  service.attachTransport(asset, gateway.node);
  const server = new LinkHTTPServer(service);
  const address = await server.listen(0);
  return {
    clock,
    network,
    gateway,
    asset,
    service,
    base: `http://${address.host}:${address.port}`,
    close: async () => {
      await server.close();
      service.stop();
      gateway.stop();
      await clock.runUntilIdle();
    }
  };
}

async function closeHarness(harness: Harness): Promise<void> {
  await harness.close();
}

function report(taskID: string): TaskReport {
  return {
    type: "task_report",
    action: "complete",
    task_id: taskID,
    runtime_id: "runtime-alpha",
    observation_time: "2026-09-02T12:00:00Z",
    body: { output: { complete: true } }
  };
}

function pendingTask(taskID: string): TaskResource {
  return {
    asset_id: "asset-alpha",
    command: "atlas.survey",
    created_at: "2026-09-02T12:00:00Z",
    input: {},
    status: "pending",
    task_id: taskID,
    updated_at: "2026-09-02T12:00:00Z"
  };
}

it("accounts for an atomic report rejected by confirmed-operation capacity", async () => {
  const harness = await createHarness(undefined, 1);
  let settlementID: string | undefined;
  harness.asset.onEvent((event) => {
    if (event.type === "message" && event.message.type === "task_delivery") settlementID = event.settlement_id;
  });
  try {
    harness.gateway.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("task-full") },
      {
        destination: harness.asset.node,
        operationID: "deliver-full"
      }
    );
    await harness.clock.advanceBy(1000);
    expect(settlementID).toBeDefined();
    expect(
      harness.asset.submit(report("other-task"), { destination: harness.gateway.node, operationID: "busy" }).status
    ).toBe("queued");
    const result = harness.asset.settleInboundWithTaskReport(
      settlementID!,
      report("task-full"),
      harness.gateway.node,
      "result-full"
    );
    expect(result.accepted).toBe(false);
    expect(harness.asset.metrics().confirmed_rejected_overload).toBe(1);
    expect(harness.asset.diagnostics().inbound_awaiting_settlement).toBe(1);
    expect(harness.asset.status("result-full")).toBeUndefined();
  } finally {
    await closeHarness(harness);
  }
});
