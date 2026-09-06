import { deliveryClass, isLinkMessage } from "../contract.js";
import type { FrameEncoding } from "../frame.js";
import type { LinkMessage, LinkNode, TaskReport } from "../types.js";

export type ExperimentNode = LinkNode & { port: number };
export type ExperimentMessage = {
  id: string;
  source: string;
  receivers: string[];
  destination?: string;
  at_ms: number;
  deadline_ms: number;
  message: LinkMessage;
  expect: "delivered" | "not_delivered" | "delivered_unconfirmed";
  response?: { id: string; deadline_ms: number; message: TaskReport };
};
export type ReceiveFault = {
  receiver: string;
  source: string;
  message_type: LinkMessage["type"];
  operation_id?: string;
  action: "drop" | "duplicate";
  count: number;
  after_ms: number;
  before_ms: number;
};
export type LinkChange = { at_ms: number; from: string; to: string; enabled: boolean };
export type ExperimentConfig = {
  schema_version: 1;
  name: string;
  lab_url: string;
  preset: "SHORT_FAST" | "SHORT_TURBO";
  topology: "full-mesh" | "line";
  settle_ms: number;
  duration_ms: number;
  max_payload_bytes: number;
  retry_jitter_ms?: number;
  frame_encoding?: FrameEncoding;
  adaptive_retries?: boolean;
  state_deltas?: boolean;
  nodes: ExperimentNode[];
  messages: ExperimentMessage[];
  faults: ReceiveFault[];
  link_changes: LinkChange[];
};

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function bounded(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,23}$/.test(value);
}

/** Reject ambiguous identities and incomplete observation windows before touching the lab. */
export function parseExperiment(value: unknown): ExperimentConfig {
  if (!record(value) || value.schema_version !== 1 || !identifier(value.name))
    throw new Error("Invalid experiment identity");
  if (typeof value.lab_url !== "string") throw new Error("lab_url is required");
  const url = new URL(value.lab_url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("lab_url must be an HTTP origin at 127.0.0.1");
  }
  if (value.preset !== "SHORT_FAST" && value.preset !== "SHORT_TURBO") throw new Error("Invalid experiment preset");
  if (value.topology !== "full-mesh" && value.topology !== "line") throw new Error("Invalid topology");
  if (!bounded(value.duration_ms, 1_000, 600_000) || !bounded(value.settle_ms, 0, 60_000))
    throw new Error("Invalid experiment duration");
  if (value.retry_jitter_ms !== undefined && !bounded(value.retry_jitter_ms, 0, 1000))
    throw new Error("Invalid retry_jitter_ms");
  if (value.adaptive_retries !== undefined && typeof value.adaptive_retries !== "boolean")
    throw new Error("Invalid adaptive_retries");
  if (value.state_deltas !== undefined && typeof value.state_deltas !== "boolean")
    throw new Error("Invalid state_deltas");
  if (
    value.frame_encoding !== undefined &&
    value.frame_encoding !== "canonical-json" &&
    value.frame_encoding !== "deflate-v1" &&
    value.frame_encoding !== "deflate-v2" &&
    value.frame_encoding !== "deflate-v3" &&
    value.frame_encoding !== "binary-v1" &&
    value.frame_encoding !== "message-v1" &&
    value.frame_encoding !== "message-v2"
  )
    throw new Error("Invalid frame_encoding");
  if (!bounded(value.max_payload_bytes, 180, 227))
    throw new Error("max_payload_bytes must be 180–227 (native SIMULATOR_APP wrapper reserves 6 bytes)");
  if (!Array.isArray(value.nodes) || value.nodes.length < 2 || value.nodes.length > 10)
    throw new Error("Expected 2–10 nodes");
  const nodes: ExperimentNode[] = value.nodes.map((node: unknown) => {
    if (
      !record(node) ||
      !identifier(node.id) ||
      (node.role !== "asset" && node.role !== "gateway") ||
      !bounded(node.port, 45001, 45010)
    )
      throw new Error("Invalid experiment node");
    return { id: node.id, role: node.role, port: node.port };
  });
  const ids = new Set(nodes.map((node) => node.id));
  if (
    ids.size !== nodes.length ||
    new Set(nodes.map((node) => node.port)).size !== nodes.length ||
    nodes.filter((node) => node.role === "gateway").length !== 1
  )
    throw new Error("Nodes need unique identities and ports, and exactly one Gateway");
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 1000)
    throw new Error("Expected 1–1000 messages");
  const duration = value.duration_ms;
  const messages: ExperimentMessage[] = value.messages.map((message: unknown) => {
    if (
      !record(message) ||
      !identifier(message.id) ||
      typeof message.source !== "string" ||
      !ids.has(message.source) ||
      !bounded(message.at_ms, 0, duration) ||
      !bounded(message.deadline_ms, 1, duration) ||
      message.at_ms + message.deadline_ms > duration ||
      !isLinkMessage(message.message)
    )
      throw new Error("Invalid message or observation deadline");
    if (
      !Array.isArray(message.receivers) ||
      message.receivers.length === 0 ||
      !message.receivers.every(
        (id: unknown): id is string => typeof id === "string" && ids.has(id) && id !== message.source
      ) ||
      new Set(message.receivers).size !== message.receivers.length
    )
      throw new Error("Invalid expected receivers");
    if (
      message.destination !== undefined &&
      (typeof message.destination !== "string" ||
        message.receivers.length !== 1 ||
        message.receivers[0] !== message.destination)
    )
      throw new Error("Addressed messages must name their destination as the only expected receiver");
    if (
      message.expect !== "delivered" &&
      message.expect !== "not_delivered" &&
      message.expect !== "delivered_unconfirmed"
    )
      throw new Error("Invalid delivery expectation");
    if (
      message.message.type === "control" ||
      message.message.type === "data_request" ||
      message.message.type === "data_response" ||
      message.message.type === "object_content"
    )
      throw new Error(
        "Use state, Task, subscription, or mutation workloads; request/response application handlers are not provided by this runner"
      );
    if (deliveryClass(message.message) === "confirmed" && message.destination === undefined)
      throw new Error("Confirmed experiments require a destination");
    if (deliveryClass(message.message) === "best_effort" && message.expect === "delivered_unconfirmed")
      throw new Error("Best-effort messages do not require confirmation");
    let response: ExperimentMessage["response"];
    if (message.response !== undefined) {
      const reply = message.response;
      if (
        !record(reply) ||
        !identifier(reply.id) ||
        !bounded(reply.deadline_ms, message.deadline_ms, duration - message.at_ms) ||
        !isLinkMessage(reply.message) ||
        reply.message.type !== "task_report" ||
        message.message.type !== "task_delivery" ||
        message.message.delivery !== "assignment" ||
        nodes.find((node) => node.id === message.source)?.role !== "gateway" ||
        nodes.find((node) => node.id === message.destination)?.role !== "asset" ||
        message.message.task.asset_id !== message.destination ||
        reply.message.task_id !== message.message.task.task_id
      )
        throw new Error("A response must be a matching Asset Task report with an observed round-trip deadline");
      response = { id: reply.id, deadline_ms: reply.deadline_ms, message: reply.message };
    }
    return {
      ...(response === undefined ? {} : { response }),
      id: message.id,
      source: message.source,
      receivers: message.receivers,
      at_ms: message.at_ms,
      deadline_ms: message.deadline_ms,
      message: message.message,
      expect: message.expect,
      ...(message.destination === undefined ? {} : { destination: message.destination })
    };
  });
  const allMessages = messages.flatMap((message) => {
    const reply = responseWorkload(message);
    return reply ? [message, reply] : [message];
  });
  if (new Set(allMessages.map((message) => `${message.source}:${message.id}`)).size !== allMessages.length)
    throw new Error("Operation identities must be unique per source");
  if (
    !Array.isArray(value.faults) ||
    value.faults.length > 100 ||
    !Array.isArray(value.link_changes) ||
    value.link_changes.length > 100
  )
    throw new Error("faults and link_changes must be bounded arrays");
  const messageTypes = new Set([
    "state",
    "task_delivery",
    "task_report",
    "resource_operation",
    "subscription",
    "control"
  ]);
  const faults: ReceiveFault[] = value.faults.map((fault: unknown) => {
    if (
      !record(fault) ||
      typeof fault.receiver !== "string" ||
      !ids.has(fault.receiver) ||
      typeof fault.source !== "string" ||
      !ids.has(fault.source) ||
      typeof fault.message_type !== "string" ||
      !messageTypes.has(fault.message_type) ||
      (fault.action !== "drop" && fault.action !== "duplicate") ||
      !bounded(fault.count, 1, 10000) ||
      !bounded(fault.after_ms, 0, duration) ||
      !bounded(fault.before_ms, 1, duration) ||
      fault.before_ms <= fault.after_ms ||
      (fault.operation_id !== undefined && !identifier(fault.operation_id))
    )
      throw new Error("Invalid receive fault");
    // Narrow through the same contract discriminator used by the packet matcher.
    const message_type = fault.message_type as ReceiveFault["message_type"];
    return {
      receiver: fault.receiver,
      source: fault.source,
      message_type,
      action: fault.action,
      count: fault.count,
      after_ms: fault.after_ms,
      before_ms: fault.before_ms,
      ...(fault.operation_id === undefined ? {} : { operation_id: fault.operation_id })
    };
  });
  const link_changes: LinkChange[] = value.link_changes.map((change: unknown) => {
    if (
      !record(change) ||
      !bounded(change.at_ms, 0, duration) ||
      typeof change.from !== "string" ||
      !ids.has(change.from) ||
      typeof change.to !== "string" ||
      !ids.has(change.to) ||
      change.from === change.to ||
      typeof change.enabled !== "boolean"
    )
      throw new Error("Invalid directed link change");
    return { at_ms: change.at_ms, from: change.from, to: change.to, enabled: change.enabled };
  });
  return {
    schema_version: 1,
    name: value.name,
    lab_url: value.lab_url,
    preset: value.preset,
    topology: value.topology,
    settle_ms: value.settle_ms,
    duration_ms: value.duration_ms,
    max_payload_bytes: value.max_payload_bytes,
    ...(value.retry_jitter_ms === undefined ? {} : { retry_jitter_ms: value.retry_jitter_ms }),
    ...(value.frame_encoding === undefined ? {} : { frame_encoding: value.frame_encoding }),
    ...(value.adaptive_retries === undefined ? {} : { adaptive_retries: value.adaptive_retries }),
    ...(value.state_deltas === undefined ? {} : { state_deltas: value.state_deltas }),
    nodes,
    messages,
    faults,
    link_changes
  };
}

export function labScenario(config: ExperimentConfig) {
  return {
    schemaVersion: 1,
    name: config.name,
    seed: 42,
    nodeCount: config.nodes.length,
    rf: { region: "US", modemPreset: config.preset, frequencySlot: 20, hopLimit: 3, collisionMode: "native" },
    channel: { name: "AtlasLab", psk: "AQ==" },
    freshState: true,
    nodes: config.nodes.map((node) => ({ id: node.id, displayName: node.id, role: "CLIENT", apiPort: node.port })),
    links: config.nodes.flatMap((source, i) =>
      config.nodes.flatMap((receiver, j) =>
        i === j
          ? []
          : [
              {
                from: source.id,
                to: receiver.id,
                enabled: config.topology === "full-mesh" || Math.abs(i - j) === 1,
                rssiDbm: -85,
                snrDb: 8
              }
            ]
      )
    )
  };
}

/** Response deadlines are measured from the command schedule, including outbound delivery time. */
export function responseWorkload(command: ExperimentMessage): ExperimentMessage | undefined {
  if (!command.response || !command.destination) return undefined;
  return {
    id: command.response.id,
    source: command.destination,
    destination: command.source,
    receivers: [command.source],
    at_ms: command.at_ms,
    deadline_ms: command.response.deadline_ms,
    message: command.response.message,
    expect: "delivered"
  };
}
