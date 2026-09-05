import { createHash } from "node:crypto";
import type { EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { canonicalJSON } from "./canonical-json.js";
import { VirtualClock } from "./clock.js";
import { GatewayFeedDemand, OrderedTaskDispatcher } from "./gateway.js";
import { SharedPicture } from "./picture.js";
import { AtlasRadioSDK } from "./sdk.js";
import { type PacketNetworkMetrics, SHORT_FAST_MODEM, SimulatedPacketNetwork } from "./simulation.js";
import { SUBSCRIPTION_LEASE_MS, SUBSCRIPTION_RENEWAL_MS } from "./subscriptions.js";
import { LinkTransport } from "./transport.js";
import type { FeedSelector, LinkMetrics, LinkOperationResult, StatePublication } from "./types.js";

const SCENARIO_START_MS = Date.parse("2026-09-02T12:00:00Z");
const NORMAL_MEASUREMENT_WINDOW_MS = 60_000;
const POSITION_AND_TRACK_INTERVAL_MS = 1_000;
const NORMAL_MEASUREMENT_TICKS = NORMAL_MEASUREMENT_WINDOW_MS / POSITION_AND_TRACK_INTERVAL_MS;
const NORMAL_SUBSCRIPTION_RENEWAL_MS = SUBSCRIPTION_RENEWAL_MS;

type ScenarioNetworkManifest = {
  packet_loss: number;
  duplicate_chance: number;
  propagation_delay_ms: number;
  relay_delay_ms: number;
  contention_window_airtimes: number;
  carrier_sense: boolean;
};

type NormalWorkloadManifest = {
  position_publications: number;
  telemetry_publications: number;
  track_publications: number;
  task_assignments: number;
  task_reports_expected: number;
  subscription_adds: number;
  subscription_renewals: number;
  small_data_requests: number;
};

type StressWorkloadManifest = {
  additional_track_publications: number;
  object_requests: number;
  object_transfers: number;
  cancellations: number;
};

type WorkloadScheduleManifest = {
  position_interval_ms: number;
  telemetry_interval_ms: number;
  track_interval_ms: number;
  task_interval_ms: number;
  subscription_renewal_interval_ms: number;
  subscription_setup_spacing_ms: number;
  small_data_request_interval_ms: number;
  stress_track_interval_ms: number;
  object_size_bytes: number;
  cancellation_delay_after_object_send_ms: number;
  payload_fixture_revision: number;
};

export type ScenarioManifest = {
  scenario: string;
  scenario_revision: number;
  seed: number;
  measurement_window_ms: number;
  regulatory_region: "US";
  radio_profile: typeof SHORT_FAST_MODEM;
  topology: {
    hop_limit: number;
    radios: Array<{ id: string; role: "gateway" | "asset"; radio_node_number: number }>;
    links: Array<[string, string]>;
  };
  network: ScenarioNetworkManifest;
  transport: {
    queue_limit: number;
    confirmed_limit: number;
    reassembly_limit: number;
    reassembly_timeout_ms: number;
    deadline_ms_by_priority: Record<string, number>;
    retry_interval_ms_by_priority: Record<string, number>;
  };
  gateway_limits: {
    task_queue_limit: number;
    feed_transition_fence_limit: number;
  };
  workload_schedule: WorkloadScheduleManifest;
  production_path: readonly ["AtlasRadioSDK", "LinkTransport", "SimulatedPacketNetwork", "SharedPicture"];
  normal_workload: NormalWorkloadManifest;
  success_criteria: {
    preserve_delivered_atlas_semantics: boolean;
    performance_gate: boolean;
  };
  stress_additions?: StressWorkloadManifest;
  configuration_sha256: string;
};

export type WorkloadCounts = {
  normal: {
    position_publications: number;
    telemetry_publications: number;
    track_publications: number;
    task_assignments: number;
    task_reports_submitted: number;
    subscription_adds: number;
    subscription_renewals: number;
    small_data_requests: number;
  };
  stress_additions: {
    track_publications: number;
    object_requests: number;
    object_transfers: number;
    cancellations: number;
  };
};

export type FeedBenchmarkMetrics = {
  active_subscriptions_at_window: number;
  active_subscriptions_after_drain: number;
  subscriber_count_at_window: number;
  subscriber_count_after_drain: number;
  core_publish_count: number;
  gateway_publish_count: number;
  receiver_delivery_count: number;
};

export type BaselineBenchmarkResult = {
  scenario: "first_position_vertical_slice";
  scenario_revision: 1;
  seed: number;
  scenario_manifest: ScenarioManifest;
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
  scenario_revision: 4;
  seed: number;
  scenario_manifest: ScenarioManifest;
  workload_counts: WorkloadCounts;
  semantic_result: {
    gateway_field_records: number;
    minimum_asset_picture_records: number;
    aggregate_subscription_feeds: number;
    task_delivery_order: string[];
    data_request_completed: boolean;
    task_reports_received: number;
  };
  feed_metrics: FeedBenchmarkMetrics;
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
  scenario_revision: 3;
  seed: number;
  scenario_manifest: ScenarioManifest;
  workload_counts: WorkloadCounts;
  semantic_result: {
    object_completed: boolean;
    cancellation_received: boolean;
    object_content_bytes: number;
    priority_preempted_object: boolean;
    gateway_track_records: number;
    normal_task_delivery_count: number;
    normal_task_reports_received: number;
    normal_data_requests_completed: number;
  };
  feed_metrics: FeedBenchmarkMetrics;
  transport_metrics: LinkMetrics;
  network_metrics: PacketNetworkMetrics;
  picture_metrics: PictureBenchmarkSummary;
  post_drain_picture_metrics: PictureBenchmarkSummary;
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

type ScenarioManifestConfig = Omit<ScenarioManifest, "configuration_sha256">;

const PRODUCTION_PATH: ScenarioManifest["production_path"] = [
  "AtlasRadioSDK",
  "LinkTransport",
  "SimulatedPacketNetwork",
  "SharedPicture"
];

const NORMAL_WORKLOAD: NormalWorkloadManifest = {
  position_publications: 240,
  telemetry_publications: 24,
  track_publications: 300,
  task_assignments: 1,
  task_reports_expected: 4,
  subscription_adds: 2,
  subscription_renewals: 2,
  small_data_requests: 2
};

const WORKLOAD_SCHEDULE: WorkloadScheduleManifest = {
  position_interval_ms: POSITION_AND_TRACK_INTERVAL_MS,
  telemetry_interval_ms: 10_000,
  track_interval_ms: POSITION_AND_TRACK_INTERVAL_MS,
  task_interval_ms: NORMAL_MEASUREMENT_WINDOW_MS,
  subscription_renewal_interval_ms: SUBSCRIPTION_RENEWAL_MS,
  subscription_setup_spacing_ms: 30_000,
  small_data_request_interval_ms: 30_000,
  stress_track_interval_ms: 1_000,
  object_size_bytes: 32 * 1024,
  cancellation_delay_after_object_send_ms: 500,
  payload_fixture_revision: 1
};

const CANONICAL_NETWORK: ScenarioNetworkManifest = {
  packet_loss: 0,
  duplicate_chance: 0,
  propagation_delay_ms: 2,
  relay_delay_ms: 20,
  contention_window_airtimes: 4,
  carrier_sense: true
};

const TRANSPORT_ASSUMPTIONS = {
  queue_limit: 64,
  confirmed_limit: 64,
  reassembly_limit: 64,
  reassembly_timeout_ms: 10_000,
  deadline_ms_by_priority: {
    safety: 15_000,
    task: 15_000,
    request: 30_000,
    live_state: 30_000,
    resource: 30_000,
    object_content: 300_000
  },
  retry_interval_ms_by_priority: {
    safety: 5_000,
    task: 5_000,
    request: 10_000,
    live_state: 10_000,
    resource: 10_000,
    object_content: 15_000
  }
} as const;

const GATEWAY_LIMITS = {
  task_queue_limit: 4_096,
  feed_transition_fence_limit: 4_096
} as const;

const CANONICAL_TOPOLOGY_LINKS: readonly [string, string][] = [
  ["gateway", "asset-alpha"],
  ["gateway", "asset-bravo"],
  ["asset-alpha", "asset-charlie"],
  ["asset-bravo", "asset-charlie"],
  ["asset-charlie", "asset-delta"]
];

const STRESS_ADDITIONS: StressWorkloadManifest = {
  additional_track_publications: 1_200,
  object_requests: 1,
  object_transfers: 1,
  cancellations: 1
};

const SUCCESS_CRITERIA = {
  preserve_delivered_atlas_semantics: true,
  performance_gate: false
} as const;

function createScenarioManifest(config: ScenarioManifestConfig): ScenarioManifest {
  return {
    ...config,
    configuration_sha256: `sha256:${createHash("sha256").update(canonicalJSON(config)).digest("hex")}`
  };
}

function emptyWorkloadCounts(): WorkloadCounts {
  return {
    normal: {
      position_publications: 0,
      telemetry_publications: 0,
      track_publications: 0,
      task_assignments: 0,
      task_reports_submitted: 0,
      subscription_adds: 0,
      subscription_renewals: 0,
      small_data_requests: 0
    },
    stress_additions: {
      track_publications: 0,
      object_requests: 0,
      object_transfers: 0,
      cancellations: 0
    }
  };
}

function verticalManifest(seed: number): ScenarioManifest {
  return createScenarioManifest({
    scenario: "first_position_vertical_slice",
    scenario_revision: 1,
    seed,
    measurement_window_ms: 0,
    regulatory_region: "US",
    radio_profile: { ...SHORT_FAST_MODEM },
    topology: {
      hop_limit: 3,
      radios: [
        { id: "asset-alpha", role: "asset", radio_node_number: 101 },
        { id: "gateway", role: "gateway", radio_node_number: 201 },
        { id: "asset-bravo", role: "asset", radio_node_number: 102 }
      ],
      links: [
        ["asset-alpha", "gateway"],
        ["gateway", "asset-bravo"]
      ]
    },
    network: { ...CANONICAL_NETWORK, propagation_delay_ms: 2, relay_delay_ms: 20 },
    transport: TRANSPORT_ASSUMPTIONS,
    gateway_limits: GATEWAY_LIMITS,
    workload_schedule: WORKLOAD_SCHEDULE,
    production_path: PRODUCTION_PATH,
    normal_workload: {
      ...NORMAL_WORKLOAD,
      position_publications: 1,
      telemetry_publications: 0,
      track_publications: 0,
      task_assignments: 0,
      task_reports_expected: 0,
      subscription_adds: 0,
      subscription_renewals: 0,
      small_data_requests: 0
    },
    success_criteria: SUCCESS_CRITERIA
  });
}

function normalManifest(
  scenario: string,
  scenarioRevision: number,
  seed: number,
  stressAdditions?: StressWorkloadManifest
) {
  const network = stressAdditions === undefined ? CANONICAL_NETWORK : { ...CANONICAL_NETWORK, duplicate_chance: 0.02 };
  return createScenarioManifest({
    scenario,
    scenario_revision: scenarioRevision,
    seed,
    measurement_window_ms: NORMAL_MEASUREMENT_WINDOW_MS,
    regulatory_region: "US",
    radio_profile: { ...SHORT_FAST_MODEM },
    topology: {
      hop_limit: 3,
      radios: [
        { id: "gateway", role: "gateway", radio_node_number: stressAdditions === undefined ? 200 : 300 },
        { id: "asset-alpha", role: "asset", radio_node_number: stressAdditions === undefined ? 201 : 301 },
        { id: "asset-bravo", role: "asset", radio_node_number: stressAdditions === undefined ? 202 : 302 },
        { id: "asset-charlie", role: "asset", radio_node_number: stressAdditions === undefined ? 203 : 303 },
        { id: "asset-delta", role: "asset", radio_node_number: stressAdditions === undefined ? 204 : 304 }
      ],
      links: CANONICAL_TOPOLOGY_LINKS.map(([left, right]) => [left, right])
    },
    network,
    transport: TRANSPORT_ASSUMPTIONS,
    gateway_limits: GATEWAY_LIMITS,
    workload_schedule: WORKLOAD_SCHEDULE,
    production_path: PRODUCTION_PATH,
    normal_workload: NORMAL_WORKLOAD,
    success_criteria: SUCCESS_CRITERIA,
    ...(stressAdditions === undefined ? {} : { stress_additions: stressAdditions })
  });
}

type FakeCoreFeedListener = (publication: StatePublication, publishNumber: number) => void;
type TaskReportAction = "acknowledge" | "start" | "progress" | "complete";

/** A deterministic change-feed seam for exercising the Gateway application's production path. */
export class FakeCoreFeed {
  private readonly listeners = new Map<string, FakeCoreFeedListener>();
  private publishCount = 0;
  private deliveryCount = 0;

  subscribe(selector: FeedSelector, listener: FakeCoreFeedListener): () => void {
    const key = canonicalJSON(selector);
    if (this.listeners.has(key)) throw new Error(`fake Core feed is already subscribed: ${key}`);
    this.listeners.set(key, listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(key);
    };
  }

  publish(selector: FeedSelector, publication: StatePublication): void {
    const publishNumber = ++this.publishCount;
    const listener = this.listeners.get(canonicalJSON(selector));
    if (listener === undefined) return;
    this.deliveryCount++;
    listener(structuredClone(publication), publishNumber);
  }

  metrics(): { active_subscriptions: number; publish_count: number; delivery_count: number } {
    return {
      active_subscriptions: this.listeners.size,
      publish_count: this.publishCount,
      delivery_count: this.deliveryCount
    };
  }
}

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
    scenario_manifest: verticalManifest(seed),
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

type NormalWorkloadOptions = {
  clock: VirtualClock;
  clients: ReadonlyMap<string, AtlasRadioSDK>;
  assetIDs: readonly string[];
  dispatcher: OrderedTaskDispatcher;
  workloadCounts: WorkloadCounts;
  requestPrefix: string;
  taskID: string;
};

/** Schedule the normal operating workload shared by the canonical and stress scenarios. */
function scheduleNormalWorkload({
  clock,
  clients,
  assetIDs,
  dispatcher,
  workloadCounts,
  requestPrefix,
  taskID
}: NormalWorkloadOptions): void {
  const normalCounts = workloadCounts.normal;
  const destination = { role: "gateway", id: "gateway" } as const;
  clock.schedule(0, () => {
    normalCounts.task_assignments++;
    dispatcher.enqueue("asset-delta", taskFixture(taskID, new Date(clock.now()).toISOString()));
  });
  for (let second = 0; second < NORMAL_MEASUREMENT_TICKS; second++) {
    clock.schedule(second * WORKLOAD_SCHEDULE.position_interval_ms, () => {
      for (const [assetIndex, assetID] of assetIDs.entries()) {
        const client = requiredMapValue(clients, assetID);
        const positionVersion = second * 2 + 1;
        const position = positionFixtureFor(assetID, positionVersion);
        normalCounts.position_publications++;
        client.publish({
          type: "state",
          resource_type: "entity",
          resource: position,
          observation_time: position.metadata.updated_at,
          path: "field",
          confirmation: "awaiting_core",
          operation_id: `position-${assetID}-${second}`,
          runtime_id: `runtime-${assetID}`
        });
        if ((second * WORKLOAD_SCHEDULE.position_interval_ms) % WORKLOAD_SCHEDULE.telemetry_interval_ms === 0) {
          const telemetry = positionFixtureFor(assetID, positionVersion + 1);
          normalCounts.telemetry_publications++;
          client.publish({
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
            normalCounts.track_publications++;
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
  for (
    let elapsed = 0;
    elapsed < NORMAL_MEASUREMENT_WINDOW_MS;
    elapsed += WORKLOAD_SCHEDULE.small_data_request_interval_ms
  ) {
    clock.schedule(elapsed, () => {
      normalCounts.small_data_requests++;
      requiredMapValue(clients, "asset-bravo").request(
        {
          type: "data_request",
          request_id: `${requestPrefix}-${elapsed / 1_000}`,
          operation: "entity.get",
          target_id: "asset-alpha"
        },
        destination
      );
    });
  }
}

/** The stress scenario adds traffic to the same fleet, application handlers, and normal schedule. */
async function runFleetScenario(seed: number, stress: boolean) {
  const manifest = normalManifest(
    stress ? "canonical_five_radio_stress" : "canonical_five_radio_normal",
    stress ? 3 : 4,
    seed,
    stress ? STRESS_ADDITIONS : undefined
  );
  const clock = new VirtualClock(SCENARIO_START_MS);
  const network = new SimulatedPacketNetwork({
    seed,
    clock,
    modem: manifest.radio_profile,
    hopLimit: manifest.topology.hop_limit,
    packetLoss: manifest.network.packet_loss,
    duplicateChance: manifest.network.duplicate_chance,
    propagationDelayMs: manifest.network.propagation_delay_ms,
    relayDelayMs: manifest.network.relay_delay_ms,
    contentionWindowAirtimes: manifest.network.contention_window_airtimes,
    carrierSense: manifest.network.carrier_sense
  });
  const pictures = new Map<string, SharedPicture>();
  const transports = new Map<string, LinkTransport>();
  const clients = new Map<string, AtlasRadioSDK>();
  for (const { id, role, radio_node_number } of manifest.topology.radios) {
    const picture = new SharedPicture(`picture-${id}`);
    const transport = new LinkTransport({
      node: { id, role },
      sourceGeneration: 1,
      serviceSession: `session-${id}`,
      radio: network.addRadio(id, radio_node_number),
      clock,
      picture,
      queueLimit: manifest.transport.queue_limit,
      confirmedLimit: manifest.transport.confirmed_limit,
      reassemblyLimit: manifest.transport.reassembly_limit,
      reassemblyTimeoutMs: manifest.transport.reassembly_timeout_ms
    });
    pictures.set(id, picture);
    transports.set(id, transport);
    clients.set(id, new AtlasRadioSDK(transport));
  }
  for (const [left, right] of manifest.topology.links) network.connect(left, right);
  const gateway = requiredMapValue(transports, "gateway");
  const gatewayClient = requiredMapValue(clients, "gateway");
  const delta = requiredMapValue(transports, "asset-delta");
  const deltaClient = requiredMapValue(clients, "asset-delta");
  const assetIDs = manifest.topology.radios.filter((radio) => radio.role === "asset").map((radio) => radio.id);
  const dispatcher = new OrderedTaskDispatcher(gateway);
  const workloadCounts = emptyWorkloadCounts();
  const feedDemand = new GatewayFeedDemand();
  const coreFeed = new FakeCoreFeed();
  const selector = { kind: "resource_type", resource_type: "entity" } as const;
  const feedOperationIDs = new Set<string>();
  let unsubscribeCoreFeed: (() => void) | undefined;
  let gatewayFeedPublications = 0;
  let feedReceiverDeliveries = 0;
  let dataRequestsCompleted = 0;
  let taskReportsReceived = 0;
  let activeSubscriptionsAtWindow = 0;
  let subscribersAtWindow = 0;
  const taskOrder: string[] = [];
  const content = Buffer.alloc(WORKLOAD_SCHEDULE.object_size_bytes, 0x5a);
  let objectCompletedAt: number | undefined;
  let cancellationSubmittedAt: number | undefined;
  let cancellationReceivedAt: number | undefined;
  let objectTransferStarted = false;
  const sendOrder: string[] = [];
  let startedAt: number | undefined;
  let pictureAt30Seconds: PictureBenchmarkSummary | undefined;
  let pictureAt60Seconds: PictureBenchmarkSummary | undefined;
  let gatewayTrackRecordsAtWindow = 0;

  // Each accepted lease schedules its own expiry. A later renewal keeps demand active at an older timer.
  const expireFeeds = (): void => {
    feedDemand.expire(clock.now());
    if (feedDemand.active(clock.now()).length === 0) {
      unsubscribeCoreFeed?.();
      unsubscribeCoreFeed = undefined;
    }
  };
  const taskReportAction: Record<TaskReportAction, TaskReportAction | undefined> = {
    acknowledge: "start",
    start: "progress",
    progress: "complete",
    complete: undefined
  };
  const pendingTaskReports = new Map<string, { taskID: string; nextAction?: TaskReportAction }>();
  const submitTaskReport = (taskID: string, action: TaskReportAction): void => {
    const operationID = `report-${taskID}-${action}`;
    const context = {
      type: "task_report" as const,
      task_id: taskID,
      runtime_id: "runtime-asset-delta",
      observation_time: new Date(clock.now()).toISOString()
    };
    const destination = { role: "gateway", id: "gateway" } as const;
    workloadCounts.normal.task_reports_submitted++;
    let result: LinkOperationResult;
    switch (action) {
      case "acknowledge":
      case "start":
        result = deltaClient.reportTask({ ...context, action, body: {} }, destination, operationID);
        break;
      case "progress":
        result = deltaClient.reportTask({ ...context, action, body: { progress: 0.5 } }, destination, operationID);
        break;
      case "complete":
        result = deltaClient.reportTask(
          { ...context, action, body: { output: { surveyed: true } } },
          destination,
          operationID
        );
        break;
    }
    if (result.status !== "failed") {
      const nextAction = taskReportAction[action];
      pendingTaskReports.set(operationID, { taskID, ...(nextAction === undefined ? {} : { nextAction }) });
    }
  };
  const startWindow = (): void => {
    if (startedAt !== undefined) return;
    startedAt = clock.now();
    scheduleNormalWorkload({
      clock,
      clients,
      assetIDs,
      dispatcher,
      workloadCounts,
      requestPrefix: "canonical-request",
      taskID: "task-minute-1"
    });
    clock.schedule(NORMAL_SUBSCRIPTION_RENEWAL_MS, () => {
      for (const id of ["asset-alpha", "asset-bravo"]) {
        workloadCounts.normal.subscription_renewals++;
        requiredMapValue(clients, id).subscribe(
          { type: "subscription", action: "renew", selector },
          { role: "gateway", id: "gateway" },
          `subscription-renew-${id}`
        );
      }
    });
    coreFeed.publish(selector, {
      type: "state",
      resource_type: "entity",
      resource: positionFixtureFor("asset-alpha", 1),
      observation_time: new Date(clock.now()).toISOString(),
      path: "gateway_feed",
      confirmation: "core_confirmed"
    });
    if (stress) {
      for (
        let second = 0;
        second < NORMAL_MEASUREMENT_WINDOW_MS / WORKLOAD_SCHEDULE.stress_track_interval_ms;
        second++
      ) {
        clock.schedule(second * WORKLOAD_SCHEDULE.stress_track_interval_ms, () => {
          for (let index = 6; index <= 25; index++) {
            const publisher = assetIDs[(index - 6) % assetIDs.length] ?? "asset-alpha";
            const track = trackFixture(index, second + 1);
            workloadCounts.stress_additions.track_publications++;
            requiredMapValue(clients, publisher).publish({
              type: "state",
              resource_type: "entity",
              resource: track,
              observation_time: track.metadata.updated_at,
              path: "field",
              confirmation: "awaiting_core",
              operation_id: `stress-track-${index}-${second}`,
              runtime_id: `runtime-${publisher}`
            });
          }
        });
      }
      clock.schedule(WORKLOAD_SCHEDULE.cancellation_delay_after_object_send_ms, () => {
        cancellationSubmittedAt = clock.now();
        workloadCounts.stress_additions.cancellations++;
        gatewayClient.deliverTask(
          { type: "task_delivery", delivery: "cancellation", task: cancelledTaskFixture() },
          { role: "asset", id: "asset-delta" },
          "stress-cancellation"
        );
      });
    }
    clock.schedule(30_000, () => {
      pictureAt30Seconds = summarizePictures(pictures, clock.now());
    });
    clock.schedule(NORMAL_MEASUREMENT_WINDOW_MS, () => {
      pictureAt60Seconds = summarizePictures(pictures, clock.now());
      gatewayTrackRecordsAtWindow = countTrackRecords(requiredMapValue(pictures, "gateway"));
      activeSubscriptionsAtWindow = coreFeed.metrics().active_subscriptions;
      subscribersAtWindow = feedDemand.subscriberCount(clock.now());
    });
  };
  gateway.onEvent((event) => {
    if (event.type === "packet_sent") {
      sendOrder.push(event.operation_id);
      if (stress && event.operation_id === "stress-object-transfer") startWindow();
    }
    if (event.type !== "message" || !event.addressed_to_local) return;
    if (event.message.type === "subscription") {
      expireFeeds();
      const transition = feedDemand.apply(event, clock.now());
      if (transition && "rejected" in transition) {
        gateway.settleInbound(event.settlement_id, false, transition.reason);
        return;
      }
      if (event.message.action !== "remove") clock.schedule(SUBSCRIPTION_LEASE_MS, expireFeeds);
      if (feedDemand.active(clock.now()).length > 0 && !unsubscribeCoreFeed) {
        unsubscribeCoreFeed = coreFeed.subscribe(selector, (publication, publishNumber) => {
          const operationID = `canonical-feed-${publishNumber}`;
          feedOperationIDs.add(operationID);
          gatewayFeedPublications++;
          gatewayClient.publish(
            { ...publication, operation_id: operationID, path: "gateway_feed", confirmation: "core_confirmed" },
            operationID
          );
        });
      }
      expireFeeds();
      gateway.settleInbound(event.settlement_id, true);
    } else if (event.message.type === "data_request") {
      if (stress && event.message.operation === "object.content") {
        gateway.settleInbound(event.settlement_id, true);
        if (!objectTransferStarted) {
          objectTransferStarted = true;
          workloadCounts.stress_additions.object_transfers++;
          gatewayClient.transferObject(
            {
              type: "object_content",
              object_id: "stress-object",
              request_id: event.message.request_id,
              content_base64: content.toString("base64"),
              sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`
            },
            event.source,
            event.message.request_id
          );
        }
      } else {
        gatewayClient.respond(
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
      }
    } else if (event.message.type === "task_report") {
      taskReportsReceived++;
      gateway.settleInbound(event.settlement_id, true);
    }
  });
  for (const id of assetIDs) {
    const transport = requiredMapValue(transports, id);
    transport.onEvent((event) => {
      if (event.type !== "message") return;
      if (event.source.role === "gateway" && event.message.type === "state" && feedOperationIDs.has(event.operation_id))
        feedReceiverDeliveries++;
      if (!event.addressed_to_local) return;
      if (event.message.type === "data_response" && event.message.request_id.startsWith("canonical-request-"))
        dataRequestsCompleted++;
      if (event.message.type === "task_delivery") {
        if (event.message.delivery === "cancellation") cancellationReceivedAt = clock.now();
        else {
          taskOrder.push(event.message.task.task_id);
          submitTaskReport(event.message.task.task_id, "acknowledge");
        }
      }
      if (event.message.type === "object_content") {
        const received = Buffer.from(event.message.content_base64, "base64");
        const valid = received.equals(content);
        if (valid) objectCompletedAt = clock.now();
        transport.settleInbound(event.settlement_id, valid, valid ? undefined : "Object content mismatch");
      } else if (event.requires_settlement) transport.settleInbound(event.settlement_id, true);
    });
  }
  delta.onEvent((event) => {
    if (event.type !== "operation") return;
    const pending = pendingTaskReports.get(event.result.operation_id);
    if (!pending) return;
    if (event.result.status === "confirmed") {
      pendingTaskReports.delete(event.result.operation_id);
      if (pending.nextAction) submitTaskReport(pending.taskID, pending.nextAction);
    } else if (event.result.status === "failed" || event.result.status === "rejected")
      pendingTaskReports.delete(event.result.operation_id);
  });
  try {
    // Establish demand through the radio during a declared quiet setup phase; expiry remains active throughout.
    for (const id of ["asset-alpha", "asset-bravo"]) {
      workloadCounts.normal.subscription_adds++;
      requiredMapValue(clients, id).subscribe(
        { type: "subscription", action: "add", selector },
        { role: "gateway", id: "gateway" },
        `subscription-${id}`
      );
      await clock.advanceBy(WORKLOAD_SCHEDULE.subscription_setup_spacing_ms);
    }
    if (stress) {
      workloadCounts.stress_additions.object_requests++;
      deltaClient.request(
        {
          type: "data_request",
          request_id: "stress-object-transfer",
          operation: "object.content",
          target_id: "stress-object"
        },
        { role: "gateway", id: "gateway" }
      );
    } else startWindow();
    await clock.runUntilIdle(1_000_000);
    if (startedAt === undefined) throw new Error("stress setup did not start an Object transfer through the radio");
    const feedMetrics = coreFeed.metrics();
    const firstObject = sendOrder.indexOf("stress-object-transfer");
    const cancellation = sendOrder.indexOf("stress-cancellation");
    return {
      base: {
        seed,
        scenario_manifest: manifest,
        workload_counts: workloadCounts,
        feed_metrics: {
          active_subscriptions_at_window: activeSubscriptionsAtWindow,
          active_subscriptions_after_drain: feedMetrics.active_subscriptions,
          subscriber_count_at_window: subscribersAtWindow,
          subscriber_count_after_drain: feedDemand.subscriberCount(clock.now()),
          core_publish_count: feedMetrics.publish_count,
          gateway_publish_count: gatewayFeedPublications,
          receiver_delivery_count: feedReceiverDeliveries
        },
        transport_metrics: aggregateTransportMetrics([...transports.values()]),
        network_metrics: network.metrics(),
        elapsed_ms: clock.now() - startedAt
      },
      taskOrder,
      dataRequestsCompleted,
      taskReportsReceived,
      at30Seconds: pictureAt30Seconds ?? emptyPictureSummary(),
      at60Seconds: pictureAt60Seconds ?? emptyPictureSummary(),
      finalPicture: summarizePictures(pictures, clock.now()),
      gatewayTrackRecordsAtWindow,
      objectCompleted: objectCompletedAt !== undefined,
      cancellationReceived: cancellationReceivedAt !== undefined,
      priorityPreemptedObject:
        firstObject >= 0 &&
        cancellation > firstObject &&
        cancellation < sendOrder.lastIndexOf("stress-object-transfer"),
      timing: {
        object_completion_ms: objectCompletedAt === undefined ? null : objectCompletedAt - startedAt,
        cancellation_delivery_ms:
          cancellationSubmittedAt === undefined || cancellationReceivedAt === undefined
            ? null
            : cancellationReceivedAt - cancellationSubmittedAt
      }
    };
  } finally {
    unsubscribeCoreFeed?.();
    dispatcher.close();
    for (const transport of transports.values()) transport.stop();
  }
}

export async function runCanonicalBaseline(seed = 42): Promise<CanonicalBaselineResult> {
  const run = await runFleetScenario(seed, false);
  return {
    ...run.base,
    scenario: "canonical_five_radio_normal",
    scenario_revision: 4,
    semantic_result: {
      gateway_field_records: run.at60Seconds.gateway_records,
      minimum_asset_picture_records: run.at60Seconds.minimum_asset_records,
      aggregate_subscription_feeds: run.base.feed_metrics.active_subscriptions_at_window,
      task_delivery_order: run.taskOrder,
      data_request_completed: run.dataRequestsCompleted === NORMAL_WORKLOAD.small_data_requests,
      task_reports_received: run.taskReportsReceived
    },
    picture_metrics: { at_30_seconds: run.at30Seconds, at_60_seconds: run.at60Seconds, final: run.finalPicture }
  };
}

export async function runStressBaseline(seed = 42): Promise<StressBaselineResult> {
  const run = await runFleetScenario(seed, true);
  return {
    ...run.base,
    scenario: "canonical_five_radio_stress",
    scenario_revision: 3,
    semantic_result: {
      object_completed: run.objectCompleted,
      cancellation_received: run.cancellationReceived,
      object_content_bytes: WORKLOAD_SCHEDULE.object_size_bytes,
      priority_preempted_object: run.priorityPreemptedObject,
      gateway_track_records: run.gatewayTrackRecordsAtWindow,
      normal_task_delivery_count: run.taskOrder.length,
      normal_task_reports_received: run.taskReportsReceived,
      normal_data_requests_completed: run.dataRequestsCompleted
    },
    picture_metrics: run.at60Seconds,
    post_drain_picture_metrics: run.finalPicture,
    timing: run.timing
  };
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
    malformed_frames: 0,
    invalid_messages: 0,
    duplicate_packets_suppressed: 0,
    stale_messages_rejected: 0,
    picture_rejected_capacity: 0,
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
    aggregate.malformed_frames += metrics.malformed_frames;
    aggregate.invalid_messages += metrics.invalid_messages;
    aggregate.duplicate_packets_suppressed += metrics.duplicate_packets_suppressed;
    aggregate.stale_messages_rejected += metrics.stale_messages_rejected;
    aggregate.picture_rejected_capacity += metrics.picture_rejected_capacity;
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

function countTrackRecords(picture: SharedPicture): number {
  return picture
    .snapshot()
    .records.filter(
      (record) => record.resource_type === "entity" && (record.state as EntityResource).entity_type === "track"
    ).length;
}

function requiredMapValue<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`missing benchmark fixture ${String(key)}`);
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJSON(left) === canonicalJSON(right);
}
