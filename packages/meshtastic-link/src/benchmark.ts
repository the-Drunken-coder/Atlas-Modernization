import { createHash } from "node:crypto";
import type { EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { canonicalJSON } from "./canonical-json.js";
import { VirtualClock } from "./clock.js";
import { GatewayFeedDemand, OrderedTaskDispatcher } from "./gateway.js";
import { SharedPicture } from "./picture.js";
import { AtlasRadioSDK } from "./sdk.js";
import { type PacketNetworkMetrics, SimulatedPacketNetwork } from "./simulation.js";
import { LinkTransport } from "./transport.js";
import type { LinkMetrics, StatePublication } from "./types.js";

const SCENARIO_START_MS = Date.parse("2026-09-02T12:00:00Z");

export type BaselineBenchmarkResult = {
  scenario: "first_position_vertical_slice";
  scenario_revision: 1;
  seed: number;
  semantic_result: {
    gateway_received: boolean;
    peer_asset_received: boolean;
    entity: EntityResource;
  };
  source_metrics: LinkMetrics;
  network_metrics: PacketNetworkMetrics;
  delivery_latency_ms: number;
};

export type CanonicalBaselineResult = {
  scenario: "canonical_five_radio_normal";
  scenario_revision: 1;
  seed: number;
  semantic_result: {
    gateway_field_records: number;
    minimum_asset_picture_records: number;
    aggregate_subscription_feeds: number;
    task_delivery_order: string[];
    data_request_completed: boolean;
    task_reports_received: number;
  };
  transport_metrics: LinkMetrics;
  network_metrics: PacketNetworkMetrics;
  picture_metrics: {
    at_30_seconds: PictureBenchmarkSummary;
    at_60_seconds: PictureBenchmarkSummary;
    final: PictureBenchmarkSummary;
  };
  elapsed_ms: number;
};

export type StressBaselineResult = {
  scenario: "canonical_five_radio_stress";
  scenario_revision: 1;
  seed: number;
  semantic_result: {
    object_completed: boolean;
    cancellation_received: boolean;
    object_content_bytes: number;
    priority_preempted_object: boolean;
    gateway_track_records: number;
  };
  transport_metrics: LinkMetrics;
  network_metrics: PacketNetworkMetrics;
  picture_metrics: PictureBenchmarkSummary;
  timing: {
    object_completion_ms: number | null;
    cancellation_delivery_ms: number | null;
  };
  elapsed_ms: number;
};

export type PictureBenchmarkSummary = {
  total_records: number;
  gateway_records: number;
  minimum_asset_records: number;
  fresh_records: number;
  stale_records: number;
  degraded_records: number;
};

export async function runFirstVerticalSlice(seed = 42): Promise<BaselineBenchmarkResult> {
  const clock = new VirtualClock(SCENARIO_START_MS);
  const network = new SimulatedPacketNetwork({ seed, clock });
  const sourceRadio = network.addRadio("asset-alpha", 101);
  const gatewayRadio = network.addRadio("gateway", 201);
  const peerRadio = network.addRadio("asset-bravo", 102);
  network.connect("asset-alpha", "gateway");
  network.connect("gateway", "asset-bravo");

  const gatewayPicture = new SharedPicture("picture-gateway");
  const peerPicture = new SharedPicture("picture-asset-bravo");
  const source = new LinkTransport({
    node: { role: "asset", id: "asset-alpha" },
    sourceGeneration: 1,
    serviceSession: "session-asset-alpha",
    radio: sourceRadio,
    clock
  });
  const gateway = new LinkTransport({
    node: { role: "gateway", id: "gateway" },
    sourceGeneration: 1,
    serviceSession: "session-gateway",
    radio: gatewayRadio,
    clock,
    picture: gatewayPicture
  });
  const peer = new LinkTransport({
    node: { role: "asset", id: "asset-bravo" },
    sourceGeneration: 1,
    serviceSession: "session-asset-bravo",
    radio: peerRadio,
    clock,
    picture: peerPicture
  });

  const entity = positionFixture();
  const publication: StatePublication = {
    type: "state",
    resource_type: "entity",
    resource: entity,
    observation_time: entity.metadata.updated_at,
    path: "field",
    confirmation: "awaiting_core",
    operation_id: "position-alpha-1",
    runtime_id: "runtime-alpha"
  };
  const startedAt = clock.now();
  new AtlasRadioSDK(source).publish(publication, "position-alpha-1");
  await clock.runUntilIdle();
  const completedAt = clock.now();

  const gatewayRecord = gatewayPicture.snapshot().records.find((record) => record.id === entity.entity_id);
  const peerRecord = peerPicture.snapshot().records.find((record) => record.id === entity.entity_id);
  source.stop();
  gateway.stop();
  peer.stop();
  return {
    scenario: "first_position_vertical_slice",
    scenario_revision: 1,
    seed,
    semantic_result: {
      gateway_received: gatewayRecord?.state === entity || deepEqual(gatewayRecord?.state, entity),
      peer_asset_received: peerRecord?.state === entity || deepEqual(peerRecord?.state, entity),
      entity
    },
    source_metrics: source.metrics(),
    network_metrics: network.metrics(),
    delivery_latency_ms: completedAt - startedAt
  };
}

export async function runCanonicalBaseline(seed = 42): Promise<CanonicalBaselineResult> {
  const clock = new VirtualClock(SCENARIO_START_MS);
  const network = new SimulatedPacketNetwork({ seed, clock });
  const radioIDs = ["gateway", "asset-alpha", "asset-bravo", "asset-charlie", "asset-delta"] as const;
  const radios = new Map(radioIDs.map((id, index) => [id, network.addRadio(id, 200 + index)]));
  network.connect("gateway", "asset-alpha");
  network.connect("gateway", "asset-bravo");
  network.connect("asset-alpha", "asset-charlie");
  network.connect("asset-bravo", "asset-charlie");
  network.connect("asset-charlie", "asset-delta");

  const pictures = new Map(radioIDs.map((id) => [id, new SharedPicture(`picture-${id}`)]));
  const transports = new Map<string, LinkTransport>();
  for (const [index, id] of radioIDs.entries()) {
    const transport = new LinkTransport({
      node: id === "gateway" ? { role: "gateway", id } : { role: "asset", id },
      sourceGeneration: 1,
      serviceSession: `session-${id}`,
      radio: requiredMapValue(radios, id),
      clock,
      picture: requiredMapValue(pictures, id)
    });
    transports.set(id, transport);
    if (index > 0) {
      transport.onEvent((event) => {
        if (event.type === "message" && event.requires_settlement && event.addressed_to_local) {
          transport.settleInbound(event.settlement_id, true);
        }
      });
    }
  }

  const gateway = requiredMapValue(transports, "gateway");
  const clients = new Map([...transports].map(([id, transport]) => [id, new AtlasRadioSDK(transport)]));
  const feedDemand = new GatewayFeedDemand();
  let aggregateFeedActivations = 0;
  let dataRequestsCompleted = 0;
  let taskReportsReceived = 0;
  gateway.onEvent((event) => {
    if (event.type !== "message") return;
    if (event.message.type === "subscription") {
      const transition = feedDemand.apply(event, clock.now());
      if (transition?.active) aggregateFeedActivations++;
      gateway.settleInbound(event.settlement_id, true);
    } else if (event.message.type === "data_request" && event.addressed_to_local) {
      requiredMapValue(clients, "gateway").respond(
        {
          type: "data_response",
          request_id: event.message.request_id,
          operation: event.message.operation,
          output: positionFixtureFor(event.message.target_id ?? "asset-alpha", 1)
        },
        event.source,
        `response_${event.message.request_id}`
      );
      gateway.settleInbound(event.settlement_id, true);
    } else if (event.message.type === "task_report" && event.addressed_to_local) {
      taskReportsReceived++;
      gateway.settleInbound(event.settlement_id, true);
    }
  });
  requiredMapValue(transports, "asset-bravo").onEvent((event) => {
    if (
      event.type === "message" &&
      event.addressed_to_local &&
      event.message.type === "data_response" &&
      event.message.request_id.startsWith("canonical-request-")
    ) {
      dataRequestsCompleted++;
    }
  });

  const assetIDs = radioIDs.filter((id) => id !== "gateway");
  const selector = { kind: "resource_type", resource_type: "entity" } as const;
  requiredMapValue(clients, "asset-alpha").subscribe(
    { type: "subscription", action: "add", selector },
    { role: "gateway", id: "gateway" },
    "subscription-alpha"
  );
  await clock.runUntilIdle();
  requiredMapValue(clients, "asset-bravo").subscribe(
    { type: "subscription", action: "add", selector },
    { role: "gateway", id: "gateway" },
    "subscription-bravo"
  );
  await clock.runUntilIdle();

  const taskOrder: string[] = [];
  requiredMapValue(transports, "asset-delta").onEvent((event) => {
    if (event.type === "message" && event.addressed_to_local && event.message.type === "task_delivery") {
      taskOrder.push(event.message.task.task_id);
      const operationPrefix = `report-${event.message.task.task_id}`;
      const client = requiredMapValue(clients, "asset-delta");
      const gatewayNode = { role: "gateway", id: "gateway" } as const;
      client.reportTask(
        {
          type: "task_report",
          action: "acknowledge",
          task_id: event.message.task.task_id,
          runtime_id: "runtime-asset-delta",
          body: {}
        },
        gatewayNode,
        `${operationPrefix}-acknowledge`
      );
      client.reportTask(
        {
          type: "task_report",
          action: "start",
          task_id: event.message.task.task_id,
          runtime_id: "runtime-asset-delta",
          body: {}
        },
        gatewayNode,
        `${operationPrefix}-start`
      );
      client.reportTask(
        {
          type: "task_report",
          action: "progress",
          task_id: event.message.task.task_id,
          runtime_id: "runtime-asset-delta",
          body: { progress: 0.5 }
        },
        gatewayNode,
        `${operationPrefix}-progress`
      );
      client.reportTask(
        {
          type: "task_report",
          action: "complete",
          task_id: event.message.task.task_id,
          runtime_id: "runtime-asset-delta",
          body: { output: { surveyed: true } }
        },
        gatewayNode,
        `${operationPrefix}-complete`
      );
    }
  });
  const dispatcher = new OrderedTaskDispatcher(gateway);
  dispatcher.enqueueAssignments("asset-delta", [
    taskFixture("task-later", "2026-09-02T11:59:00Z"),
    taskFixture("task-earlier", "2026-09-02T11:58:00Z")
  ]);

  const startedAt = clock.now();
  let pictureAt30Seconds: PictureBenchmarkSummary | undefined;
  let pictureAt60Seconds: PictureBenchmarkSummary | undefined;
  for (let second = 0; second < 60; second++) {
    clock.schedule(second * 1_000, () => {
      for (const [assetIndex, assetID] of assetIDs.entries()) {
        const positionVersion = second * 2 + 1;
        const position = positionFixtureFor(assetID, positionVersion);
        requiredMapValue(clients, assetID).publish({
          type: "state",
          resource_type: "entity",
          resource: position,
          observation_time: position.metadata.updated_at,
          path: "field",
          confirmation: "awaiting_core",
          operation_id: `position-${assetID}-${second}`,
          runtime_id: `runtime-${assetID}`
        });
        if (second % 10 === 0) {
          const telemetry = positionFixtureFor(assetID, positionVersion + 1);
          requiredMapValue(clients, assetID).publish({
            type: "state",
            resource_type: "entity",
            resource: telemetry,
            observation_time: telemetry.metadata.updated_at,
            path: "field",
            confirmation: "awaiting_core",
            operation_id: `telemetry-${assetID}-${second}`,
            runtime_id: `runtime-${assetID}`
          });
        }
        if (assetIndex === 0) {
          for (let trackIndex = 1; trackIndex <= 5; trackIndex++) {
            const publisher = assetIDs[(trackIndex - 1) % assetIDs.length] ?? "asset-alpha";
            const track = trackFixture(trackIndex, second + 1);
            requiredMapValue(clients, publisher).publish({
              type: "state",
              resource_type: "entity",
              resource: track,
              observation_time: track.metadata.updated_at,
              path: "field",
              confirmation: "awaiting_core",
              operation_id: `track-${trackIndex}-${second}`,
              runtime_id: `runtime-${publisher}`
            });
          }
        }
      }
    });
  }
  for (const second of [0, 30]) {
    clock.schedule(second * 1_000, () => {
      requiredMapValue(clients, "asset-bravo").request(
        {
          type: "data_request",
          request_id: `canonical-request-${second}`,
          operation: "entity.get",
          target_id: "asset-alpha"
        },
        { role: "gateway", id: "gateway" }
      );
    });
  }
  clock.schedule(30_000, () => {
    pictureAt30Seconds = summarizePictures(pictures, clock.now());
  });
  clock.schedule(60_000, () => {
    pictureAt60Seconds = summarizePictures(pictures, clock.now());
  });
  await clock.runUntilIdle(1_000_000);
  const elapsed = clock.now() - startedAt;
  const finalPicture = summarizePictures(pictures, clock.now());
  const at30Seconds = pictureAt30Seconds ?? emptyPictureSummary();
  const at60Seconds = pictureAt60Seconds ?? emptyPictureSummary();

  const result: CanonicalBaselineResult = {
    scenario: "canonical_five_radio_normal",
    scenario_revision: 1,
    seed,
    semantic_result: {
      gateway_field_records: finalPicture.gateway_records,
      minimum_asset_picture_records: finalPicture.minimum_asset_records,
      aggregate_subscription_feeds: aggregateFeedActivations,
      task_delivery_order: taskOrder,
      data_request_completed: dataRequestsCompleted === 2,
      task_reports_received: taskReportsReceived
    },
    transport_metrics: aggregateTransportMetrics([...transports.values()]),
    network_metrics: network.metrics(),
    picture_metrics: { at_30_seconds: at30Seconds, at_60_seconds: at60Seconds, final: finalPicture },
    elapsed_ms: elapsed
  };
  dispatcher.close();
  for (const transport of transports.values()) transport.stop();
  return result;
}

export async function runStressBaseline(seed = 42): Promise<StressBaselineResult> {
  const clock = new VirtualClock(SCENARIO_START_MS);
  const network = new SimulatedPacketNetwork({ seed, clock, duplicateChance: 0.02 });
  const radioIDs = ["gateway", "asset-alpha", "asset-bravo", "asset-charlie", "asset-delta"] as const;
  const radios = new Map(radioIDs.map((id, index) => [id, network.addRadio(id, 300 + index)]));
  network.connect("gateway", "asset-alpha");
  network.connect("gateway", "asset-bravo");
  network.connect("asset-alpha", "asset-charlie");
  network.connect("asset-bravo", "asset-charlie");
  network.connect("asset-charlie", "asset-delta");
  const pictures = new Map(radioIDs.map((id) => [id, new SharedPicture(`stress-picture-${id}`)]));
  const transports = new Map<string, LinkTransport>();
  for (const id of radioIDs) {
    transports.set(
      id,
      new LinkTransport({
        node: id === "gateway" ? { role: "gateway", id } : { role: "asset", id },
        sourceGeneration: 1,
        serviceSession: `stress-session-${id}`,
        radio: requiredMapValue(radios, id),
        clock,
        picture: requiredMapValue(pictures, id)
      })
    );
  }

  const gateway = requiredMapValue(transports, "gateway");
  const delta = requiredMapValue(transports, "asset-delta");
  const clients = new Map([...transports].map(([id, transport]) => [id, new AtlasRadioSDK(transport)]));
  let objectCompleted = false;
  let cancellationReceived = false;
  let objectCompletedAt: number | undefined;
  let cancellationSubmittedAt: number | undefined;
  let cancellationReceivedAt: number | undefined;
  delta.onEvent((event) => {
    if (event.type !== "message" || !event.addressed_to_local) return;
    if (event.message.type === "object_content") {
      objectCompleted = Buffer.from(event.message.content_base64, "base64").byteLength === 32 * 1024;
      if (objectCompleted) objectCompletedAt = clock.now();
      delta.settleInbound(event.settlement_id, objectCompleted, objectCompleted ? undefined : "Object length mismatch");
    } else if (event.message.type === "task_delivery" && event.message.delivery === "cancellation") {
      cancellationReceived = true;
      cancellationReceivedAt = clock.now();
      delta.settleInbound(event.settlement_id, true);
    }
  });

  const sendOrder: string[] = [];
  gateway.onEvent((event) => {
    if (event.type === "packet_sent") sendOrder.push(event.operation_id);
  });
  const content = Buffer.alloc(32 * 1024, 0x5a);
  requiredMapValue(clients, "gateway").transferObject(
    {
      type: "object_content",
      object_id: "stress-object",
      content_base64: content.toString("base64"),
      sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`
    },
    { role: "asset", id: "asset-delta" },
    "stress-object-transfer"
  );

  const assets = radioIDs.filter((id) => id !== "gateway");
  for (let index = 0; index < 20; index++) {
    const publisher = assets[index % assets.length] ?? "asset-alpha";
    const track = trackFixture(index + 1);
    clock.schedule(index * 250, () => {
      requiredMapValue(clients, publisher).publish(
        {
          type: "state",
          resource_type: "entity",
          resource: track,
          observation_time: track.metadata.updated_at,
          path: "field",
          confirmation: "awaiting_core",
          operation_id: `stress-track-${index + 1}`,
          runtime_id: `runtime-${publisher}`
        },
        `stress-track-${index + 1}`
      );
    });
  }
  clock.schedule(500, () => {
    cancellationSubmittedAt = clock.now();
    requiredMapValue(clients, "gateway").deliverTask(
      { type: "task_delivery", delivery: "cancellation", task: cancelledTaskFixture() },
      { role: "asset", id: "asset-delta" },
      "stress-cancellation"
    );
  });

  const startedAt = clock.now();
  await clock.runUntilIdle(250_000);
  const firstObjectChunk = sendOrder.indexOf("stress-object-transfer");
  const cancellationChunk = sendOrder.indexOf("stress-cancellation");
  const lastObjectChunk = sendOrder.lastIndexOf("stress-object-transfer");
  const pictureMetrics = summarizePictures(pictures, clock.now());
  const gatewayTrackRecords = requiredMapValue(pictures, "gateway")
    .snapshot()
    .records.filter(
      (record) => record.resource_type === "entity" && (record.state as EntityResource).entity_type === "track"
    ).length;
  const result: StressBaselineResult = {
    scenario: "canonical_five_radio_stress",
    scenario_revision: 1,
    seed,
    semantic_result: {
      object_completed: objectCompleted,
      cancellation_received: cancellationReceived,
      object_content_bytes: content.byteLength,
      priority_preempted_object:
        firstObjectChunk >= 0 && cancellationChunk > firstObjectChunk && cancellationChunk < lastObjectChunk,
      gateway_track_records: gatewayTrackRecords
    },
    transport_metrics: aggregateTransportMetrics([...transports.values()]),
    network_metrics: network.metrics(),
    picture_metrics: pictureMetrics,
    timing: {
      object_completion_ms: objectCompletedAt === undefined ? null : objectCompletedAt - startedAt,
      cancellation_delivery_ms:
        cancellationSubmittedAt === undefined || cancellationReceivedAt === undefined
          ? null
          : cancellationReceivedAt - cancellationSubmittedAt
    },
    elapsed_ms: clock.now() - startedAt
  };
  for (const transport of transports.values()) transport.stop();
  return result;
}

function positionFixture(): EntityResource {
  const timestamp = "2026-09-02T12:00:00Z";
  return {
    alias: "Alpha",
    entity_id: "asset-alpha",
    entity_type: "asset",
    subtype: null,
    components: {
      geometry: { type: "Point", coordinates: [-71.8023, 42.2746, 110] },
      telemetry: { speed_m_s: 4.5, heading_deg: 82 }
    },
    metadata: {
      created_at: timestamp,
      updated_at: timestamp,
      version: 1
    }
  };
}

function positionFixtureFor(assetID: string, version: number): EntityResource {
  const fixture = positionFixture();
  return {
    ...fixture,
    alias: assetID,
    entity_id: assetID,
    components: {
      ...fixture.components,
      geometry: { type: "Point", coordinates: [-71.8023 + version / 1_000, 42.2746, 110] }
    },
    metadata: { ...fixture.metadata, version }
  };
}

function trackFixture(index: number, version = index): EntityResource {
  const fixture = positionFixtureFor(`track-${index}`, version);
  return { ...fixture, entity_type: "track", alias: `Track ${index}` };
}

function taskFixture(taskID: string, createdAt: string): TaskResource {
  return {
    asset_id: "asset-delta",
    command: "atlas.survey",
    created_at: createdAt,
    input: { area: "north" },
    status: "pending",
    task_id: taskID,
    updated_at: createdAt
  };
}

function cancelledTaskFixture(): TaskResource {
  const createdAt = "2026-09-02T12:00:00Z";
  return {
    asset_id: "asset-delta",
    cancellation: { code: "requested", message: "Return immediately" },
    command: "atlas.survey",
    created_at: createdAt,
    finished_at: "2026-09-02T12:00:01Z",
    input: { area: "north" },
    status: "cancelled",
    task_id: "task-cancelled",
    updated_at: "2026-09-02T12:00:01Z"
  };
}

function aggregateTransportMetrics(transports: readonly LinkTransport[]): LinkMetrics {
  const aggregate: LinkMetrics = {
    application_bytes: 0,
    packets_sent: 0,
    transmitted_bytes: 0,
    packets_received: 0,
    duplicate_packets_suppressed: 0,
    stale_messages_rejected: 0,
    incomplete_reassemblies: 0,
    best_effort_replaced: 0,
    confirmed_rejected_overload: 0,
    retry_exhausted: 0,
    retransmitted_packets: 0,
    fragment_repair_requests_sent: 0,
    fragment_repair_requests_received: 0,
    radio_send_failures: 0,
    inbound_settlement_expired: 0,
    peak_queue_depth: 0,
    packets_sent_by_message_type: {
      state: 0,
      task_delivery: 0,
      task_report: 0,
      data_request: 0,
      data_response: 0,
      resource_operation: 0,
      subscription: 0,
      object_content: 0,
      control: 0
    },
    transmitted_bytes_by_priority: {
      safety: 0,
      task: 0,
      request: 0,
      live_state: 0,
      resource: 0,
      object_content: 0
    },
    queue_wait_ms_by_priority: emptyPriorityTimings(),
    operation_latency_ms_by_priority: emptyPriorityTimings(),
    operation_outcomes: { sent: 0, confirmed: 0, responded: 0, rejected: 0, failed: 0 }
  };
  for (const transport of transports) {
    const metrics = transport.metrics();
    aggregate.application_bytes += metrics.application_bytes;
    aggregate.packets_sent += metrics.packets_sent;
    aggregate.transmitted_bytes += metrics.transmitted_bytes;
    aggregate.packets_received += metrics.packets_received;
    aggregate.duplicate_packets_suppressed += metrics.duplicate_packets_suppressed;
    aggregate.stale_messages_rejected += metrics.stale_messages_rejected;
    aggregate.incomplete_reassemblies += metrics.incomplete_reassemblies;
    aggregate.best_effort_replaced += metrics.best_effort_replaced;
    aggregate.confirmed_rejected_overload += metrics.confirmed_rejected_overload;
    aggregate.retry_exhausted += metrics.retry_exhausted;
    aggregate.retransmitted_packets += metrics.retransmitted_packets;
    aggregate.fragment_repair_requests_sent += metrics.fragment_repair_requests_sent;
    aggregate.fragment_repair_requests_received += metrics.fragment_repair_requests_received;
    aggregate.radio_send_failures += metrics.radio_send_failures;
    aggregate.inbound_settlement_expired += metrics.inbound_settlement_expired;
    aggregate.peak_queue_depth = Math.max(aggregate.peak_queue_depth, metrics.peak_queue_depth);
    for (const key of Object.keys(
      aggregate.packets_sent_by_message_type
    ) as (keyof LinkMetrics["packets_sent_by_message_type"])[]) {
      aggregate.packets_sent_by_message_type[key] += metrics.packets_sent_by_message_type[key];
    }
    for (const priority of Object.keys(
      aggregate.transmitted_bytes_by_priority
    ) as (keyof LinkMetrics["transmitted_bytes_by_priority"])[]) {
      aggregate.transmitted_bytes_by_priority[priority] += metrics.transmitted_bytes_by_priority[priority];
      mergeTiming(aggregate.queue_wait_ms_by_priority[priority], metrics.queue_wait_ms_by_priority[priority]);
      mergeTiming(
        aggregate.operation_latency_ms_by_priority[priority],
        metrics.operation_latency_ms_by_priority[priority]
      );
    }
    for (const outcome of Object.keys(aggregate.operation_outcomes) as (keyof LinkMetrics["operation_outcomes"])[]) {
      aggregate.operation_outcomes[outcome] += metrics.operation_outcomes[outcome];
    }
  }
  return aggregate;
}

function emptyPriorityTimings(): LinkMetrics["queue_wait_ms_by_priority"] {
  const empty = () => ({ samples: 0, total_ms: 0, maximum_ms: 0 });
  return {
    safety: empty(),
    task: empty(),
    request: empty(),
    live_state: empty(),
    resource: empty(),
    object_content: empty()
  };
}

function mergeTiming(
  target: { samples: number; total_ms: number; maximum_ms: number },
  source: { samples: number; total_ms: number; maximum_ms: number }
): void {
  target.samples += source.samples;
  target.total_ms += source.total_ms;
  target.maximum_ms = Math.max(target.maximum_ms, source.maximum_ms);
}

function summarizePictures(pictures: ReadonlyMap<string, SharedPicture>, now: number): PictureBenchmarkSummary {
  const records = [...pictures.entries()].flatMap(([id, picture]) => {
    picture.refresh(now);
    return picture.snapshot().records.map((record) => ({ id, record }));
  });
  const gatewayRecords = records.filter(({ id }) => id === "gateway").length;
  const assetCounts = [...pictures.keys()]
    .filter((id) => id !== "gateway")
    .map((id) => records.filter((entry) => entry.id === id).length);
  return {
    total_records: records.length,
    gateway_records: gatewayRecords,
    minimum_asset_records: assetCounts.length === 0 ? 0 : Math.min(...assetCounts),
    fresh_records: records.filter(({ record }) => record.freshness === "fresh").length,
    stale_records: records.filter(({ record }) => record.freshness === "stale").length,
    degraded_records: records.filter(({ record }) => record.freshness === "degraded").length
  };
}

function emptyPictureSummary(): PictureBenchmarkSummary {
  return {
    total_records: 0,
    gateway_records: 0,
    minimum_asset_records: 0,
    fresh_records: 0,
    stale_records: 0,
    degraded_records: 0
  };
}

function requiredMapValue<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`missing benchmark fixture ${String(key)}`);
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJSON(left) === canonicalJSON(right);
}
