import { describe, expect, it } from "vitest";
import { RealClock, VirtualClock } from "./clock.js";
import { LinkHTTPServer, LinkService } from "./service.js";
import { SimulatedPacketNetwork } from "./simulation.js";
import { SUBSCRIPTION_LEASE_MS } from "./subscriptions.js";
import { positionPublication } from "./test-fixtures.js";
import { LinkTransport } from "./transport.js";

describe("loopback Link service", () => {
  it("serves status, picture, and asynchronous operation results as JSON", async () => {
    const service = new LinkService({ mode: "asset", nodeID: "asset-alpha", clock: new RealClock() });
    service.setLifecycle("discovering");
    const server = new LinkHTTPServer(service);
    const address = await server.listen(0);
    const base = `http://${address.host}:${address.port}`;
    try {
      const status = await fetch(`${base}/v1/status`).then((response) => response.json());
      expect(status).toMatchObject({ mode: "asset", lifecycle: "discovering", gateway_available: false });
      const submission = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: positionPublication(1) })
      }).then((response) => response.json());
      expect(submission).toMatchObject({ status: "failed", reason: "Link transport is unavailable" });
      if (!isRecord(submission) || typeof submission.operation_id !== "string") {
        throw new Error("submission did not return an operation ID");
      }
      const operation = await fetch(`${base}/v1/operations/${submission.operation_id}`).then((response) =>
        response.json()
      );
      expect(operation).toEqual(submission);
      const picture = await fetch(`${base}/v1/picture`).then((response) => response.json());
      expect(picture).toMatchObject({ session: service.picture.session, revision: 0, records: [] });
    } finally {
      await server.close();
      service.stop();
    }
  });

  it("refuses non-loopback binds", async () => {
    const service = new LinkService({ mode: "gateway", nodeID: "gateway", clock: new RealClock() });
    const server = new LinkHTTPServer(service);
    await expect(server.listen(0, "0.0.0.0")).rejects.toThrow("must bind to loopback");
  });

  it("rejects browser-originated mutations against the loopback interface", async () => {
    const service = new LinkService({ mode: "asset", nodeID: "asset-alpha", clock: new RealClock() });
    const server = new LinkHTTPServer(service);
    const address = await server.listen(0);
    try {
      const response = await fetch(`http://${address.host}:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "text/plain", origin: "https://example.test" },
        body: JSON.stringify({ message: positionPublication(1) })
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "browser-originated mutations are not allowed" });
    } finally {
      await server.close();
      service.stop();
    }
  });

  it("retains an asynchronous radio response under the originating request ID", async () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 41, clock });
    const gatewayRadio = network.addRadio("gateway", 1);
    const assetRadio = network.addRadio("asset-alpha", 2);
    network.connect("gateway", "asset-alpha");
    const gateway = new LinkTransport({
      node: { role: "gateway", id: "gateway" },
      sourceGeneration: 1,
      radio: gatewayRadio,
      clock
    });
    const service = new LinkService({ mode: "asset", nodeID: "asset-alpha", clock });
    const asset = new LinkTransport({
      node: service.node,
      sourceGeneration: 1,
      serviceSession: service.serviceSession,
      radio: assetRadio,
      clock,
      picture: service.picture
    });
    service.attachTransport(asset, { role: "gateway", id: "gateway" });
    gateway.onEvent((event) => {
      if (event.type !== "message" || event.message.type !== "data_request" || !event.addressed_to_local) return;
      gateway.settleInbound(event.settlement_id, true);
      const state = positionPublication(4);
      gateway.submit(
        {
          type: "data_response",
          request_id: event.message.request_id,
          operation: "entity.get",
          output: state.resource
        },
        { destination: event.source, operationID: `response-${event.message.request_id}` }
      );
    });
    expect(
      service.submit({
        type: "data_request",
        request_id: "request-asset-alpha",
        operation: "entity.get",
        target_id: "asset-alpha"
      })
    ).toMatchObject({ status: "queued" });
    for (let attempt = 0; attempt < 60 && service.operation("request-asset-alpha")?.status !== "responded"; attempt++) {
      await clock.advanceBy(500);
    }
    expect(service.operation("request-asset-alpha")).toMatchObject({
      status: "responded",
      output: { entity_id: "asset-alpha", metadata: { version: 4 } }
    });
    expect(service.snapshot().records[0]).toMatchObject({ id: "asset-alpha", atlas_version: 4 });
    service.stop();
    gateway.stop();
    await clock.runUntilIdle();
  });

  it("reports queued operations as failed before a controlled service stop", () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 44, clock });
    const service = new LinkService({
      mode: "asset",
      nodeID: "asset-alpha",
      clock,
      gatewayNode: { role: "gateway", id: "gateway" }
    });
    service.attachTransport(
      new LinkTransport({
        node: service.node,
        sourceGeneration: 1,
        serviceSession: service.serviceSession,
        radio: network.addRadio("asset-alpha", 2),
        clock
      })
    );
    const failures: string[] = [];
    service.onEvent((event) => {
      if (event.type === "transport" && event.event.type === "operation" && event.event.result.status === "failed") {
        failures.push(event.event.result.operation_id);
      }
    });
    service.submit({
      type: "data_request",
      request_id: "pending-request",
      operation: "entity.get",
      target_id: "asset-alpha"
    });
    service.submit(positionPublication(1));

    service.stop();

    expect(failures).toEqual(["pending-request", "position-1"]);
    expect(service.operation("position-1")).toMatchObject({ status: "failed", reason: "link service stopped" });
    expect(service.operation("pending-request")).toMatchObject({ status: "failed", reason: "link service stopped" });
  });

  it("expires local subscription demand when a client stops renewing", async () => {
    const clock = new VirtualClock();
    const service = new LinkService({ mode: "gateway", nodeID: "gateway", clock });
    const selector = { kind: "resource_type", resource_type: "entity" } as const;
    expect(service.updateLocalSubscription("client-a", "add", selector)).toMatchObject({ active: 1 });

    await clock.advanceBy(SUBSCRIPTION_LEASE_MS);

    expect(service.updateLocalSubscription("client-a", "remove", selector)).toEqual({ changed: false, active: 0 });
    service.stop();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
