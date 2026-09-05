import { once } from "node:events";
import { connect, type Socket } from "node:net";
import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it, vi } from "vitest";
import { RealClock, VirtualClock } from "./clock.js";
import type { LinkRadio } from "./radio.js";
import { LinkHTTPServer, LinkService } from "./service.js";
import { SimulatedPacketNetwork } from "./simulation.js";
import { SUBSCRIPTION_LEASE_MS } from "./subscriptions.js";
import { positionPublication } from "./test-fixtures.js";
import { LinkTransport } from "./transport.js";
import type { ResourceStatePublication } from "./types.js";

describe("loopback Link service", () => {
  it("logs and removes throwing event listeners", () => {
    const service = new LinkService({ mode: "asset", nodeID: "asset-alpha", clock: new VirtualClock() });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    service.onEvent(() => {
      calls++;
      throw new Error("event listener failed");
    });
    try {
      service.setLifecycle("discovering");
      service.setLifecycle("active");

      expect(calls).toBe(1);
      expect(consoleError).toHaveBeenCalledWith(
        "Link service event listener failed; removing listener",
        expect.any(Error)
      );
    } finally {
      consoleError.mockRestore();
      service.stop();
    }
  });

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
        body: JSON.stringify({ message: positionPublication(1), operation_id: "caller-stable-operation" })
      }).then((response) => response.json());
      expect(submission).toMatchObject({
        operation_id: "caller-stable-operation",
        status: "failed",
        reason: "Link transport is unavailable"
      });
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

  it("reports the configured Gateway association without claiming peer liveness", () => {
    const service = new LinkService({
      mode: "asset",
      nodeID: "asset-alpha",
      clock: new VirtualClock(),
      gatewayNode: { role: "gateway", id: "gateway" }
    });

    expect(service.status().gateway_available).toBe(true);
    service.setLifecycle("error", "serial connection lost");
    expect(service.status().gateway_available).toBe(true);
    service.stop();
  });

  it("refuses non-loopback binds", async () => {
    const service = new LinkService({ mode: "gateway", nodeID: "gateway", clock: new RealClock() });
    const server = new LinkHTTPServer(service);
    try {
      await expect(server.listen(0, "0.0.0.0")).rejects.toThrow("must bind to loopback");
    } finally {
      service.stop();
    }
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

  it("removes subscriptions owned by active streams when the HTTP server closes", async () => {
    const transitions: string[] = [];
    const service = new LinkService({
      mode: "gateway",
      nodeID: "gateway",
      clock: new RealClock(),
      onGatewaySubscriptionTransition: (transition) => transitions.push(transition.action)
    });
    const server = new LinkHTTPServer(service);
    const address = await server.listen(0);
    const base = `http://${address.host}:${address.port}`;
    const selector = { kind: "resource_type", resource_type: "entity" } as const;
    await fetch(`${base}/v1/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "client-a", action: "add", selector })
    });
    const stream = await fetch(`${base}/v1/events?client_id=client-a`);

    await server.close();

    expect(stream.ok).toBe(true);
    expect(transitions).toEqual(["add", "remove"]);
    service.stop();
  });

  it("starts a new event stream after buffer rotation while preserving explicit cursor expiry", async () => {
    const service = new LinkService({ mode: "asset", nodeID: "asset-alpha", clock: new VirtualClock() });
    for (let index = 0; index < 1_025; index++) service.setLifecycle("discovering");
    const server = new LinkHTTPServer(service);
    const address = await server.listen(0);
    const base = `http://${address.host}:${address.port}`;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${base}/v1/events`);
      expect(response.status).toBe(200);
      reader = response.body?.getReader();
      if (!reader) throw new Error("event stream did not expose a body reader");

      service.setLifecycle("active");
      const next = await reader.read();
      expect(next.done).toBe(false);
      expect(new TextDecoder().decode(next.value)).toContain("id: 1026");

      const expired = await fetch(`${base}/v1/events?after=0`);
      expect(expired.status).toBe(400);
      await expect(expired.json()).resolves.toEqual({ error: "service event cursor expired" });
    } finally {
      await reader?.cancel();
      await server.close();
      service.stop();
    }
  });

  it("replays the full ordinary event buffer before delivering a live event", async () => {
    const service = new LinkService({ mode: "asset", nodeID: "asset-alpha", clock: new VirtualClock() });
    for (let index = 0; index < 1_024; index++) service.setLifecycle("discovering");
    const expectedReplay = service.eventsAfter(0);
    const server = new LinkHTTPServer(service);
    const address = await server.listen(0);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`http://${address.host}:${address.port}/v1/events?after=0&client_id=replay-test`);
      expect(response.status).toBe(200);
      reader = response.body?.getReader();
      if (!reader) throw new Error("event stream did not expose a body reader");

      service.setLifecycle("active");
      const records = await readSSERecords(reader, 1_025);
      expect(records.map((record) => record.id)).toEqual(Array.from({ length: 1_025 }, (_, index) => index + 1));
      expect(records.map((record) => record.data)).toEqual([...expectedReplay, ...service.eventsAfter(1_024)]);
      expect(records.at(-1)?.data).toMatchObject({
        sequence: 1_025,
        type: "status",
        status: { lifecycle: "active" }
      });
    } finally {
      await reader?.cancel();
      await server.close();
      service.stop();
    }
  });

  it("drains a large live picture event for a healthy reader", async () => {
    const service = new LinkService({ mode: "asset", nodeID: "asset-alpha", clock: new RealClock() });
    const server = new LinkHTTPServer(service);
    const address = await server.listen(0);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(
        `http://${address.host}:${address.port}/v1/picture/events?session=${service.picture.session}&after=0`
      );
      expect(response.status).toBe(200);
      reader = response.body?.getReader();
      if (!reader) throw new Error("picture stream did not expose a body reader");

      expect(
        service.picture.apply(largeObjectPublication(0), {
          source: { role: "asset", id: "asset-alpha" },
          source_generation: 1,
          service_session: "asset-session",
          source_sequence: 1,
          received_at: 0
        })
      ).toEqual({ status: "applied" });

      const expected = service.picture.eventsAfter(service.picture.session, 0)[0];
      const [record] = await readSSERecords(reader, 1);
      expect(record).toEqual({ id: 1, data: expected });
    } finally {
      await reader?.cancel();
      await server.close();
      service.stop();
    }
  });

  it("drains a large retained picture replay for a healthy reader", async () => {
    const service = new LinkService({ mode: "asset", nodeID: "asset-alpha", clock: new RealClock() });
    expect(
      service.picture.apply(largeObjectPublication(0), {
        source: { role: "asset", id: "asset-alpha" },
        source_generation: 1,
        service_session: "asset-session",
        source_sequence: 1,
        received_at: 0
      })
    ).toEqual({ status: "applied" });
    const server = new LinkHTTPServer(service);
    const address = await server.listen(0);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(
        `http://${address.host}:${address.port}/v1/picture/events?session=${service.picture.session}&after=0`
      );
      expect(response.status).toBe(200);
      reader = response.body?.getReader();
      if (!reader) throw new Error("picture stream did not expose a body reader");

      const expected = service.picture.eventsAfter(service.picture.session, 0)[0];
      const [record] = await readSSERecords(reader, 1);
      expect(record).toEqual({ id: 1, data: expected });
    } finally {
      await reader?.cancel();
      await server.close();
      service.stop();
    }
  });

  it("disconnects a stalled picture reader after its pending buffer is full", async () => {
    const service = new LinkService({ mode: "asset", nodeID: "asset-alpha", clock: new VirtualClock() });
    const server = new LinkHTTPServer(service);
    const address = await server.listen(0);
    let socket: Socket | undefined;
    try {
      socket = connect(address.port, address.host);
      await once(socket, "connect");
      socket.write(
        `GET /v1/picture/events?session=${service.picture.session}&after=0 HTTP/1.1\r\nHost: ${address.host}\r\nConnection: keep-alive\r\n\r\n`
      );
      const [head] = await once(socket, "data");
      expect(Buffer.from(head as Uint8Array).toString("utf8")).toContain("text/event-stream");
      socket.pause();

      const closed = waitForSocketClose(socket);
      const usageHint = "x".repeat(8_000);
      for (let index = 0; index < 1_200; index++) {
        service.picture.apply(largeObjectPublication(index, usageHint), {
          source: { role: "asset", id: "asset-alpha" },
          source_generation: 1,
          service_session: "asset-session",
          source_sequence: index + 1,
          received_at: index
        });
      }
      await closed;
    } finally {
      socket?.destroy();
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

  it("rejects Gateway-required messages explicitly addressed to another Asset", () => {
    const clock = new VirtualClock();
    const network = new SimulatedPacketNetwork({ seed: 58, clock });
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

    expect(
      service.submit(
        { type: "data_request", request_id: "misrouted", operation: "entity.get", target_id: "asset-bravo" },
        { role: "asset", id: "asset-bravo" }
      )
    ).toMatchObject({ status: "failed", reason: "Gateway-required message must target the active Gateway" });
    service.stop();
  });

  it("moves to an error lifecycle when the live radio disconnects", () => {
    const clock = new VirtualClock();
    let disconnect: ((reason: Error) => void) | undefined;
    const radio: LinkRadio = {
      max_payload_bytes: 233,
      send: async () => undefined,
      onPacket: () => () => undefined,
      onDisconnect: (handler) => {
        disconnect = handler;
        return () => {
          disconnect = undefined;
        };
      },
      close: async () => undefined
    };
    const service = new LinkService({ mode: "asset", nodeID: "asset-alpha", clock });
    service.attachTransport(new LinkTransport({ node: service.node, sourceGeneration: 1, radio, clock }), {
      role: "gateway",
      id: "gateway"
    });

    disconnect?.(new Error("serial connection lost"));

    expect(service.status()).toMatchObject({ lifecycle: "error", detail: "serial connection lost" });
    service.stop();
  });

  it("does not let a deferred callback overwrite a terminal lifecycle", () => {
    const service = new LinkService({ mode: "gateway", nodeID: "gateway", clock: new VirtualClock() });
    service.setLifecycle("error", "serial connection lost");

    service.setLifecycle("active", "join attempt deferred: radio send failed");

    expect(service.status()).toMatchObject({ lifecycle: "error", detail: "serial connection lost" });
    service.stop();
    expect(service.status().lifecycle).toBe("stopped");
  });

  it("expires local subscription demand when a client stops renewing", async () => {
    const clock = new VirtualClock();
    const transitions: string[] = [];
    const service = new LinkService({
      mode: "gateway",
      nodeID: "gateway",
      clock,
      onGatewaySubscriptionTransition: (transition) => transitions.push(transition.action)
    });
    const selector = { kind: "resource_type", resource_type: "entity" } as const;
    expect(service.updateLocalSubscription("client-a", "add", selector)).toMatchObject({ active: 1 });

    await clock.advanceBy(SUBSCRIPTION_LEASE_MS);

    expect(transitions).toEqual(["add", "renew", "renew", "remove"]);
    expect(service.updateLocalSubscription("client-a", "remove", selector)).toEqual({ changed: false, active: 0 });
    service.stop();
  });

  it("rejects Gateway subscription demand when no feed bridge is attached", () => {
    const service = new LinkService({ mode: "gateway", nodeID: "gateway", clock: new VirtualClock() });
    const selector = { kind: "resource_type", resource_type: "entity" } as const;

    expect(service.updateLocalSubscription("client-a", "add", selector)).toEqual({
      changed: false,
      active: 0,
      reason: "Gateway feed bridge is unavailable"
    });
    service.stop();
  });

  it("rolls back local demand when the Gateway feed bridge rejects a transition", () => {
    const service = new LinkService({
      mode: "gateway",
      nodeID: "gateway",
      clock: new VirtualClock(),
      onGatewaySubscriptionTransition: () => {
        throw new Error("Core feed is unavailable");
      }
    });
    const selector = { kind: "resource_type", resource_type: "entity" } as const;

    expect(service.updateLocalSubscription("client-a", "add", selector)).toEqual({
      changed: false,
      active: 0,
      reason: "Core feed is unavailable"
    });
    service.stop();
  });

  it("keeps the aggregate renewal cadence when a client renews its local lease", async () => {
    const clock = new VirtualClock();
    const transitions: string[] = [];
    const service = new LinkService({
      mode: "gateway",
      nodeID: "gateway",
      clock,
      onGatewaySubscriptionTransition: (transition) => transitions.push(transition.action)
    });
    const selector = { kind: "resource_type", resource_type: "entity" } as const;
    service.updateLocalSubscription("client-a", "add", selector);
    await clock.advanceBy(20_000);
    service.updateLocalSubscription("client-a", "renew", selector);
    await clock.advanceBy(10_000);

    expect(transitions).toEqual(["add", "renew"]);
    service.stop();
  });
});

describe("Gateway Task dispatch over loopback", () => {
  it("orders assignments and replays a failed first Task from authoritative HTTP state", async () => {
    const harness = await taskHarness({ connected: false });
    const delivered: string[] = [];
    harness.assetTransport.onEvent((event) => {
      if (event.type !== "message" || !event.addressed_to_local || event.message.type !== "task_delivery") return;
      delivered.push(event.message.task.task_id);
      harness.assetTransport.settleInbound(event.settlement_id, true);
    });
    const first = pendingTask("first", "2026-09-05T12:00:00Z");
    const second = pendingTask("second", "2026-09-05T12:01:00Z");

    try {
      const submitted = await postJSON(`${harness.base}/v1/tasks/asset-alpha/assignments`, { tasks: [first, second] });
      expect(submitted.response.status).toBe(202);
      await expect(getJSON(`${harness.base}/v1/tasks/asset-alpha`)).resolves.toEqual({
        in_flight: "first",
        in_flight_operation_id: "task_first_assignment_1",
        queued: ["second"]
      });

      await harness.clock.advanceBy(15_001);
      await expect(getJSON(`${harness.base}/v1/tasks/asset-alpha`)).resolves.toEqual({
        in_flight: "first",
        in_flight_operation_id: "task_first_assignment_1",
        queued: ["second"]
      });

      harness.network.connect("gateway", "asset-alpha");
      const replay = await postJSON(`${harness.base}/v1/tasks/asset-alpha/assignments`, { tasks: [first, second] });
      expect(replay.response.status).toBe(202);
      await advanceUntil(harness.clock, () => delivered.length === 2);

      expect(delivered).toEqual(["first", "second"]);
      await waitForTaskIdle(harness);
      await expect(getJSON(`${harness.base}/v1/tasks/asset-alpha`)).resolves.toEqual({ queued: [] });
    } finally {
      await closeTaskHarness(harness);
    }
  });

  it("delivers cancellation and removes terminal work after authoritative observation", async () => {
    const harness = await taskHarness();
    const delivered: Array<{ delivery: string; taskID: string }> = [];
    harness.assetTransport.onEvent((event) => {
      if (event.type !== "message" || !event.addressed_to_local || event.message.type !== "task_delivery") return;
      delivered.push({ delivery: event.message.delivery, taskID: event.message.task.task_id });
      harness.assetTransport.settleInbound(event.settlement_id, true);
    });
    const task = pendingTask("cancel-me", "2026-09-05T12:00:00Z");

    try {
      const assignment = await postJSON(`${harness.base}/v1/tasks/asset-alpha`, { task, delivery: "assignment" });
      expect(assignment.response.status).toBe(202);
      await advanceUntil(harness.clock, () => delivered.length === 1);

      const cancellation = cancelledTask(task.task_id, task.created_at);
      const cancelled = await postJSON(`${harness.base}/v1/tasks/asset-alpha`, {
        task: cancellation,
        delivery: "cancellation"
      });
      expect(cancelled.response.status).toBe(202);
      await advanceUntil(harness.clock, () => delivered.length === 2);
      expect(delivered).toEqual([
        { delivery: "assignment", taskID: "cancel-me" },
        { delivery: "cancellation", taskID: "cancel-me" }
      ]);
      await expect(getJSON(`${harness.base}/v1/tasks/asset-alpha`)).resolves.toMatchObject({
        cancellation: { task_id: "cancel-me", operation_id: "task_cancel-me_cancellation_2" },
        queued: []
      });
      await waitForTaskIdle(harness);
      await expect(getJSON(`${harness.base}/v1/tasks/asset-alpha`)).resolves.toEqual({ queued: [] });

      const terminal = pendingTask("terminal", "2026-09-05T12:02:00Z");
      const later = pendingTask("later", "2026-09-05T12:03:00Z");
      const batch = await postJSON(`${harness.base}/v1/tasks/asset-alpha/assignments`, { tasks: [terminal, later] });
      expect(batch.response.status).toBe(202);
      const observed = await postJSON(`${harness.base}/v1/tasks/asset-alpha/authoritative`, {
        task: cancelledTask(terminal.task_id, terminal.created_at)
      });
      expect(observed.response.status).toBe(200);
      await advanceUntil(harness.clock, () => delivered.some((item) => item.taskID === "later"));
      expect(delivered.filter((item) => item.taskID === "terminal")).toEqual([]);
      await waitForTaskIdle(harness);
      await expect(getJSON(`${harness.base}/v1/tasks/asset-alpha`)).resolves.toEqual({ queued: [] });
    } finally {
      await closeTaskHarness(harness);
    }
  });

  it("retains an assignment when transport capacity is full and retries after capacity clears", async () => {
    const harness = await taskHarness({ connected: false, transportQueueLimit: 1 });
    const delivered: string[] = [];
    harness.assetTransport.onEvent((event) => {
      if (event.type !== "message" || !event.addressed_to_local || event.message.type !== "task_delivery") return;
      delivered.push(event.message.task.task_id);
      harness.assetTransport.settleInbound(event.settlement_id, true);
    });
    const occupied = harness.gatewayTransport.submit(
      { type: "task_delivery", delivery: "assignment", task: pendingTask("occupier", "2026-09-05T12:00:00Z") },
      { destination: { role: "asset", id: "asset-alpha" }, operationID: "occupier" }
    );
    expect(occupied.status).toBe("queued");

    try {
      const submitted = await postJSON(`${harness.base}/v1/tasks/asset-alpha`, {
        task: pendingTask("capacity-task", "2026-09-05T12:01:00Z"),
        delivery: "assignment"
      });
      expect(submitted.response.status).toBe(202);
      await expect(getJSON(`${harness.base}/v1/tasks/asset-alpha`)).resolves.toEqual({ queued: ["capacity-task"] });

      harness.network.connect("gateway", "asset-alpha");
      await advanceUntil(harness.clock, () => delivered.length === 2);
      expect(delivered).toEqual(["occupier", "capacity-task"]);
      await waitForTaskIdle(harness);
      await expect(getJSON(`${harness.base}/v1/tasks/asset-alpha`)).resolves.toEqual({ queued: [] });
    } finally {
      await closeTaskHarness(harness);
    }
  });

  it("validates Task routes before enqueue and rejects the generic task_delivery bypass", async () => {
    const harness = await taskHarness();
    try {
      const mismatched = await postJSON(`${harness.base}/v1/tasks/asset-alpha`, {
        task: { ...pendingTask("wrong-asset", "2026-09-05T12:00:00Z"), asset_id: "asset-bravo" },
        delivery: "assignment"
      });
      expect(mismatched.response.status).toBe(400);
      await expect(getJSON(`${harness.base}/v1/tasks/asset-alpha`)).resolves.toEqual({ queued: [] });

      const batchMismatch = await postJSON(`${harness.base}/v1/tasks/asset-alpha/assignments`, {
        tasks: [
          pendingTask("batch-valid", "2026-09-05T12:00:30Z"),
          { ...pendingTask("batch-wrong-asset", "2026-09-05T12:00:31Z"), asset_id: "asset-bravo" }
        ]
      });
      expect(batchMismatch.response.status).toBe(400);
      await expect(getJSON(`${harness.base}/v1/tasks/asset-alpha`)).resolves.toEqual({ queued: [] });

      const duplicate = pendingTask("duplicate", "2026-09-05T12:01:00Z");
      const duplicateBatch = await postJSON(`${harness.base}/v1/tasks/asset-alpha/assignments`, {
        tasks: [duplicate, duplicate]
      });
      expect(duplicateBatch.response.status).toBe(400);
      await expect(getJSON(`${harness.base}/v1/tasks/asset-alpha`)).resolves.toEqual({ queued: [] });

      const bypass = await postJSON(`${harness.base}/v1/messages`, {
        message: { type: "task_delivery", delivery: "assignment", task: pendingTask("bypass", "2026-09-05T12:02:00Z") },
        destination: { role: "asset", id: "asset-alpha" },
        operation_id: "bypass"
      });
      expect(bypass.response.status).toBe(400);
      expect(bypass.body).toMatchObject({ error: expect.stringContaining("/v1/tasks") });
    } finally {
      await closeTaskHarness(harness);
    }
  });

  it.each(["configuring", "error", "stopped"] as const)(
    "rejects Task routes while the service is %s",
    async (lifecycle) => {
      const clock = new VirtualClock();
      const service = new LinkService({ mode: "gateway", nodeID: "gateway", clock });
      if (lifecycle !== "configuring") service.setLifecycle(lifecycle);
      const server = new LinkHTTPServer(service);
      const address = await server.listen(0);
      try {
        if (lifecycle === "stopped") service.stop();
        const response = await fetch(`http://${address.host}:${address.port}/v1/tasks/asset-alpha`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: pendingTask("inactive", "2026-09-05T12:00:00Z"), delivery: "assignment" })
        });
        expect(response.status).toBe(503);
      } finally {
        await server.close();
        service.stop();
      }
    }
  );

  it("rejects an active service that has no Gateway transport", async () => {
    const clock = new VirtualClock();
    const service = new LinkService({ mode: "gateway", nodeID: "gateway", clock });
    service.setLifecycle("active");
    const server = new LinkHTTPServer(service);
    const address = await server.listen(0);
    try {
      const response = await fetch(`http://${address.host}:${address.port}/v1/tasks/asset-alpha`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: pendingTask("no-transport", "2026-09-05T12:00:00Z"), delivery: "assignment" })
      });
      expect(response.status).toBe(503);
    } finally {
      await server.close();
      service.stop();
    }
  });

  it("reports Task queue exhaustion as service overload", async () => {
    const harness = await taskHarness({ connected: false });
    try {
      for (let index = 0; index < 4_097; index++) {
        harness.service.enqueueTask(
          "asset-alpha",
          pendingTask(`queued-${index}`, "2026-09-05T12:00:00Z"),
          "assignment"
        );
      }

      const result = await postJSON(`${harness.base}/v1/tasks/asset-alpha`, {
        task: pendingTask("overflow", "2026-09-05T12:00:00Z"),
        delivery: "assignment"
      });

      expect(result.response.status).toBe(503);
      expect(result.body).toEqual({ error: "Task delivery queue capacity is exhausted" });
    } finally {
      await closeTaskHarness(harness);
    }
  });

  it("keeps dispatcher state readable while the Gateway service is configuring or in error", async () => {
    const harness = await taskHarness({ connected: false });
    try {
      const submitted = await postJSON(`${harness.base}/v1/tasks/asset-alpha`, {
        task: pendingTask("diagnostic", "2026-09-05T12:00:00Z"),
        delivery: "assignment"
      });
      expect(submitted.response.status).toBe(202);

      for (const lifecycle of ["error", "configuring"] as const) {
        harness.service.setLifecycle(lifecycle);
        await expect(getJSON(`${harness.base}/v1/tasks/asset-alpha`)).resolves.toEqual({
          in_flight: "diagnostic",
          in_flight_operation_id: "task_diagnostic_assignment_1",
          queued: []
        });
      }
    } finally {
      await closeTaskHarness(harness);
    }
  });
});

type TaskHarness = {
  clock: VirtualClock;
  network: SimulatedPacketNetwork;
  gatewayTransport: LinkTransport;
  assetTransport: LinkTransport;
  service: LinkService;
  server: LinkHTTPServer;
  base: string;
};

async function taskHarness(options: { connected?: boolean; transportQueueLimit?: number } = {}): Promise<TaskHarness> {
  const clock = new VirtualClock();
  const network = new SimulatedPacketNetwork({ seed: 82, clock });
  const gatewayRadio = network.addRadio("gateway", 1);
  const assetRadio = network.addRadio("asset-alpha", 2);
  if (options.connected ?? true) network.connect("gateway", "asset-alpha");
  const gatewayTransport = new LinkTransport({
    node: { role: "gateway", id: "gateway" },
    sourceGeneration: 1,
    serviceSession: "gateway-session",
    radio: gatewayRadio,
    clock,
    ...(options.transportQueueLimit === undefined ? {} : { queueLimit: options.transportQueueLimit })
  });
  const assetTransport = new LinkTransport({
    node: { role: "asset", id: "asset-alpha" },
    sourceGeneration: 1,
    serviceSession: "asset-session",
    radio: assetRadio,
    clock
  });
  const service = new LinkService({ mode: "gateway", nodeID: "gateway", clock });
  service.attachTransport(gatewayTransport);
  const server = new LinkHTTPServer(service);
  const address = await server.listen(0);
  return {
    clock,
    network,
    gatewayTransport,
    assetTransport,
    service,
    server,
    base: `http://${address.host}:${address.port}`
  };
}

async function closeTaskHarness(harness: TaskHarness): Promise<void> {
  await harness.server.close();
  harness.service.stop();
  harness.assetTransport.stop();
  await harness.clock.runUntilIdle();
}

async function postJSON(url: string, body: unknown): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

async function getJSON(base: string): Promise<unknown> {
  return fetch(base).then((response) => response.json());
}

async function advanceUntil(clock: VirtualClock, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80 && !predicate(); attempt++) await clock.advanceBy(500);
  expect(predicate()).toBe(true);
}

async function waitForTaskIdle(harness: TaskHarness): Promise<void> {
  await advanceUntil(harness.clock, () => {
    const state = harness.service.taskState("asset-alpha");
    return (
      state !== undefined &&
      state.in_flight === undefined &&
      state.cancellation === undefined &&
      state.queued.length === 0
    );
  });
}

function pendingTask(taskID: string, createdAt: string): TaskResource {
  return {
    asset_id: "asset-alpha",
    command: "atlas.survey",
    created_at: createdAt,
    input: {},
    status: "pending",
    task_id: taskID,
    updated_at: createdAt
  };
}

function cancelledTask(taskID: string, createdAt: string): TaskResource {
  return {
    ...pendingTask(taskID, createdAt),
    cancellation: { code: "requested", message: "Return immediately" },
    finished_at: "2026-09-05T12:05:00Z",
    status: "cancelled",
    updated_at: "2026-09-05T12:05:00Z"
  };
}

function largeObjectPublication(
  index: number,
  usageHint = "x".repeat(72_000)
): Extract<ResourceStatePublication, { resource_type: "object" }> {
  const timestamp = "2026-09-05T12:00:00Z";
  return {
    type: "state",
    resource_type: "object",
    resource: {
      bucket: null,
      content_type: null,
      metadata: { created_at: timestamp, updated_at: timestamp, version: index + 1 },
      object_id: `object-${index}`,
      path: null,
      size_bytes: 0,
      type: "test",
      usage_hints: [usageHint]
    },
    observation_time: timestamp,
    path: "field",
    confirmation: "awaiting_core",
    operation_id: `object-${index}`
  };
}

async function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const onClose = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      socket.off("close", onClose);
      reject(new Error("stalled SSE socket did not close within the bounded drain window"));
    }, 5_000);
    timer.unref();
    socket.once("close", onClose);
  });
}

async function readSSERecords(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number
): Promise<Array<{ id: number; data: unknown }>> {
  const decoder = new TextDecoder();
  const records: Array<{ id: number; data: unknown }> = [];
  let pending = "";
  while (records.length < count) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`event stream ended after ${records.length} records`);
    pending += decoder.decode(chunk.value, { stream: true });
    let boundary = pending.indexOf("\n\n");
    while (boundary >= 0) {
      const record = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const id = /^id: (\d+)$/m.exec(record)?.[1];
      const data = /^data: (.+)$/m.exec(record)?.[1];
      if (id === undefined || data === undefined) throw new Error("malformed SSE record");
      records.push({ id: Number(id), data: JSON.parse(data) });
      if (records.length === count) return records;
      boundary = pending.indexOf("\n\n");
    }
  }
  return records;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
