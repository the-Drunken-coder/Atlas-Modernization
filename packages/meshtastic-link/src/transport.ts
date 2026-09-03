import { createHash, randomBytes } from "node:crypto";
import {
  type EntityResource,
  isChangedSinceResponse,
  isEntityCheckInResponse,
  isEntityResource,
  isFullDatasetResponse,
  isObjectDetailResource,
  isRuntimeTaskDeliveryResponse,
  isTaskResource,
  type ObjectDetailResource,
  type ObjectResource,
  type TaskResource
} from "@the-drunken-coder/atlas-sdk";
import type { Clock, TimerHandle } from "./clock.js";
import {
  coalescingKey,
  deliveryClass,
  deserializeLinkMessage,
  messagePriority,
  serializeLinkMessage
} from "./contract.js";
import { decodeFrame, type FrameIdentity, fragmentPayload, type LinkFrame, MAX_LINK_MESSAGE_BYTES } from "./frame.js";
import type { PictureApplyContext, SharedPicture } from "./picture.js";
import type { LinkRadio, RadioPacket } from "./radio.js";
import type {
  ControlMessage,
  DataResponse,
  DeliveryClass,
  LinkMessage,
  LinkMetrics,
  LinkNode,
  LinkOperationResult,
  LinkOperationStatus,
  MessagePriority,
  StatePublication,
  TaskDelivery,
  TaskReport
} from "./types.js";

const PRIORITY_ORDER: Record<MessagePriority, number> = {
  safety: 0,
  task: 1,
  request: 2,
  live_state: 3,
  resource: 4,
  object_content: 5
};

const DEADLINE_MS: Record<MessagePriority, number> = {
  safety: 15_000,
  task: 15_000,
  request: 30_000,
  live_state: 30_000,
  resource: 30_000,
  object_content: 5 * 60_000
};

const RETRY_MS: Record<MessagePriority, number> = {
  safety: 5_000,
  task: 5_000,
  request: 10_000,
  live_state: 10_000,
  resource: 10_000,
  object_content: 15_000
};
const OPERATION_RESULT_LIMIT = 4_096;
const SETTLED_INBOUND_LIMIT = 4_096;

export type TransportMessageEvent = {
  type: "message";
  message: LinkMessage;
  operation_id: string;
  settlement_id: string;
  source: LinkNode;
  destination?: LinkNode;
  source_generation: number;
  service_session: string;
  source_sequence: number;
  received_at: number;
  addressed_to_local: boolean;
  requires_settlement: boolean;
};

export type TransportEvent =
  | TransportMessageEvent
  | { type: "operation"; result: LinkOperationResult }
  | { type: "packet_sent"; message_id: string; operation_id: string; bytes: number; sent_at: number };

export type TransportDiagnostics = {
  queue_depth: number;
  confirmed_pending: number;
  inbound_awaiting_settlement: number;
  incomplete_reassemblies: number;
  stopped: boolean;
};

export type TransportOptions = {
  node: LinkNode;
  sourceGeneration: number;
  serviceSession?: string;
  radio: LinkRadio;
  clock: Clock;
  picture?: SharedPicture;
  privateChannel?: number;
  queueLimit?: number;
  confirmedLimit?: number;
  reassemblyLimit?: number;
  reassemblyTimeoutMs?: number;
  retryIntervalMs?: number;
};

export type SubmitOptions = {
  destination?: LinkNode;
  operationID?: string;
};

type Outbound = {
  message: LinkMessage;
  identity: FrameIdentity;
  frames: Uint8Array[];
  pendingChunks: number[];
  delivery: DeliveryClass;
  coalescingKey?: string;
  retryTimer?: TimerHandle;
  deadlineTimer?: TimerHandle;
  started: boolean;
  order: number;
  queuedAt: number;
  firstSentAt?: number;
  chunkSendCounts: number[];
};

type Reassembly = {
  identity: FrameIdentity;
  chunks: Map<number, Uint8Array>;
  chunkCount: number;
  byteLength: number;
  expiresAt: number;
  lastReceivedAt: number;
  timer: TimerHandle;
};

type SourceFence = {
  generation: number;
  session: string;
};

type PendingInbound = {
  source: LinkNode;
  operationID: string;
  messageID: string;
  timer: TimerHandle;
};

export class LinkTransport {
  readonly node: LinkNode;
  readonly sourceGeneration: number;
  readonly serviceSession: string;
  private readonly radio: LinkRadio;
  private readonly clock: Clock;
  private readonly picture: SharedPicture | undefined;
  private readonly privateChannel: number;
  private readonly queueLimit: number;
  private readonly confirmedLimit: number;
  private readonly reassemblyLimit: number;
  private readonly reassemblyTimeoutMs: number;
  private readonly retryIntervalMs: number | undefined;
  private readonly queue: Outbound[] = [];
  private readonly outboundByOperation = new Map<string, Outbound>();
  private readonly pendingDataRequests = new Map<string, Outbound>();
  private readonly reassemblies = new Map<string, Reassembly>();
  private readonly sourceFences = new Map<string, SourceFence>();
  private readonly pendingInbound = new Map<string, PendingInbound>();
  private readonly settledInbound = new Map<string, "confirmed" | "rejected">();
  private readonly operationResults = new Map<string, LinkOperationResult>();
  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private readonly capacityListeners = new Set<() => void>();
  private readonly unsubscribeRadio: () => void;
  private sourceSequence = 0;
  private nextOrder = 0;
  private pumping = false;
  private pumpRequested = false;
  private activeOutbound: Outbound | undefined;
  private stopped = false;
  private activeObjectMessageID: string | undefined;
  private readonly mutableMetrics: LinkMetrics = {
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
    packets_sent_by_message_type: emptyMessageTypeCounter(),
    transmitted_bytes_by_priority: emptyPriorityCounter(),
    queue_wait_ms_by_priority: emptyPriorityTimings(),
    operation_latency_ms_by_priority: emptyPriorityTimings(),
    operation_outcomes: { sent: 0, confirmed: 0, rejected: 0, failed: 0 }
  };

  constructor(options: TransportOptions) {
    validateNode(options.node);
    if (!Number.isSafeInteger(options.sourceGeneration) || options.sourceGeneration < 0) {
      throw new RangeError("source generation must be a non-negative safe integer");
    }
    this.node = options.node;
    this.sourceGeneration = options.sourceGeneration;
    this.serviceSession = options.serviceSession ?? compactID();
    if (!this.serviceSession.trim()) throw new TypeError("service session must not be blank");
    this.radio = options.radio;
    this.clock = options.clock;
    this.picture = options.picture;
    this.privateChannel = positiveBoundedInteger(options.privateChannel ?? 1, 0, 7, "private channel");
    this.queueLimit = positiveBoundedInteger(options.queueLimit ?? 64, 1, 4096, "queue limit");
    this.confirmedLimit = positiveBoundedInteger(options.confirmedLimit ?? 64, 1, 4096, "confirmed limit");
    this.reassemblyLimit = positiveBoundedInteger(options.reassemblyLimit ?? 64, 1, 4096, "reassembly limit");
    this.reassemblyTimeoutMs = positiveBoundedInteger(
      options.reassemblyTimeoutMs ?? 10_000,
      1,
      300_000,
      "reassembly timeout"
    );
    this.retryIntervalMs =
      options.retryIntervalMs === undefined
        ? undefined
        : positiveBoundedInteger(options.retryIntervalMs, 1, 60_000, "retry interval");
    this.unsubscribeRadio = this.radio.onPacket((packet) => this.receive(packet));
  }

  submit(message: LinkMessage, options: SubmitOptions = {}): LinkOperationResult {
    return this.submitWithCapacity(message, options, false);
  }

  private submitWithCapacity(
    message: LinkMessage,
    options: SubmitOptions,
    useInboundReservation: boolean
  ): LinkOperationResult {
    if (this.stopped) return this.failedResult(options.operationID ?? compactID(), "link service is stopped");
    if (!validStateSource(message, this.node)) {
      return this.failedResult(
        options.operationID ?? operationIDFor(message),
        "Asset state must use the field path without claiming Core authority"
      );
    }
    const delivery = deliveryClass(message);
    if (delivery === "confirmed" && options.destination === undefined) {
      return this.failedResult(options.operationID ?? compactID(), "confirmed operations require a destination");
    }
    const operationID = options.operationID ?? operationIDFor(message);
    if (!operationID.trim()) throw new TypeError("operation ID must not be blank");
    const existing = this.operationResults.get(operationID);
    if (existing) {
      if (existing.status !== "failed") return { ...existing };
      this.operationResults.delete(operationID);
    }
    if (message.type === "data_request" && this.pendingDataRequests.has(message.request_id)) {
      return this.failedResult(operationID, "data request ID is already pending");
    }
    if (delivery === "confirmed" && this.confirmedCount() >= this.confirmedLimit) {
      this.mutableMetrics.confirmed_rejected_overload++;
      return this.failedResult(operationID, "confirmed operation capacity is exhausted");
    }

    let payload: Uint8Array;
    try {
      payload = serializeLinkMessage(message);
    } catch (error) {
      return this.failedResult(operationID, `Radio contract encoding failed: ${asErrorMessage(error)}`);
    }
    const identity: FrameIdentity = {
      revision: 1,
      message_type: message.type,
      source: this.node,
      ...(options.destination === undefined ? {} : { destination: options.destination }),
      source_generation: this.sourceGeneration,
      service_session: this.serviceSession,
      source_sequence: ++this.sourceSequence,
      operation_id: operationID,
      message_id: compactID(),
      priority: messagePriority(message)
    };
    const replaceKey = coalescingKey(message);
    let frames: Uint8Array[];
    try {
      frames = fragmentPayload(payload, identity, this.radio.max_payload_bytes);
    } catch (error) {
      return this.failedResult(operationID, `Link framing failed: ${asErrorMessage(error)}`);
    }
    const outbound: Outbound = {
      message,
      identity,
      frames,
      pendingChunks: [],
      delivery,
      ...(replaceKey === undefined ? {} : { coalescingKey: replaceKey }),
      started: false,
      order: this.nextOrder++,
      queuedAt: this.clock.now(),
      chunkSendCounts: []
    };
    outbound.pendingChunks = outbound.frames.map((_, index) => index);
    outbound.chunkSendCounts = outbound.frames.map(() => 0);

    if (delivery === "best_effort" && outbound.coalescingKey !== undefined) this.replaceQueuedBestEffort(outbound);
    const occupancy = this.outboundOccupancy();
    const capacityExhausted = useInboundReservation
      ? occupancy >= this.queueLimit + this.confirmedLimit
      : occupancy + this.pendingInbound.size >= this.queueLimit;
    if (capacityExhausted) return this.failedResult(operationID, "outbound queue capacity is exhausted");
    this.queue.push(outbound);
    if (delivery === "confirmed") {
      this.outboundByOperation.set(operationID, outbound);
      if (message.type === "data_request") this.pendingDataRequests.set(message.request_id, outbound);
      outbound.deadlineTimer = this.clock.schedule(DEADLINE_MS[identity.priority], () => {
        const awaitingConfirmation = this.outboundByOperation.has(operationID);
        const requestID = dataRequestID(outbound);
        const awaitingResponse = requestID !== undefined && this.pendingDataRequests.get(requestID) === outbound;
        if (!awaitingConfirmation && !awaitingResponse) return;
        this.mutableMetrics.retry_exhausted++;
        this.completeOutbound(
          outbound,
          "failed",
          awaitingConfirmation ? "confirmation deadline expired" : "response deadline expired"
        );
      });
    }
    this.mutableMetrics.application_bytes += payload.byteLength;
    this.mutableMetrics.peak_queue_depth = Math.max(this.mutableMetrics.peak_queue_depth, this.queue.length);
    const result: LinkOperationResult = { operation_id: operationID, status: "queued" };
    this.recordOperation(result);
    this.requestPump();
    return result;
  }

  settleInbound(settlementID: string, accepted: boolean, reason?: string): boolean {
    const pending = this.pendingInbound.get(settlementID);
    if (!pending) return false;
    const control = accepted ? "confirmed" : "rejected";
    const result = this.sendControl(
      pending.source,
      {
        type: "control",
        control,
        operation_id: pending.operationID,
        message_id: pending.messageID,
        ...(reason === undefined ? {} : { reason })
      },
      true
    );
    if (result.status === "failed") return false;
    this.pendingInbound.delete(settlementID);
    this.clock.cancel(pending.timer);
    this.recordSettledInbound(settlementID, control);
    return true;
  }

  cancel(operationID: string, reason = "operation cancelled locally"): boolean {
    const outbound =
      this.outboundByOperation.get(operationID) ??
      [...this.pendingDataRequests.values()].find((candidate) => candidate.identity.operation_id === operationID);
    if (!outbound) return false;
    this.completeOutbound(outbound, "failed", reason);
    return true;
  }

  announceSourceActivation(source: LinkNode, generation: number, session: string): LinkOperationResult {
    if (this.node.role !== "gateway" || source.role !== "asset") {
      throw new Error("only a Gateway may announce an Asset source activation");
    }
    const operationID = `source_active_${source.id}_${generation}`;
    return this.submit({
      type: "control",
      control: "source_active",
      operation_id: operationID,
      active_source: source,
      active_generation: generation,
      active_session: session
    });
  }

  status(operationID: string): LinkOperationResult | undefined {
    const result = this.operationResults.get(operationID);
    return result === undefined ? undefined : structuredClone(result);
  }

  metrics(): LinkMetrics {
    return structuredClone(this.mutableMetrics);
  }

  diagnostics(): TransportDiagnostics {
    return {
      queue_depth: this.queue.length,
      confirmed_pending: this.confirmedCount(),
      inbound_awaiting_settlement: this.pendingInbound.size,
      incomplete_reassemblies: this.reassemblies.size,
      stopped: this.stopped
    };
  }

  onEvent(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onCapacityAvailable(listener: () => void): () => void {
    this.capacityListeners.add(listener);
    return () => this.capacityListeners.delete(listener);
  }

  stop(reason = "link service stopped"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeRadio();
    for (const reassembly of this.reassemblies.values()) this.clock.cancel(reassembly.timer);
    this.reassemblies.clear();
    const pending = new Set(this.queue);
    for (const outbound of this.outboundByOperation.values()) pending.add(outbound);
    for (const outbound of this.pendingDataRequests.values()) pending.add(outbound);
    if (this.activeOutbound) pending.add(this.activeOutbound);
    for (const outbound of pending) {
      if (outbound.delivery === "confirmed") this.completeOutbound(outbound, "failed", reason);
      else this.failBestEffort(outbound, reason);
    }
    this.queue.length = 0;
    for (const pending of this.pendingInbound.values()) this.clock.cancel(pending.timer);
    this.pendingInbound.clear();
  }

  private requestPump(delayMs = 0): void {
    if (this.pumping || this.pumpRequested || this.stopped) return;
    this.pumpRequested = true;
    this.clock.schedule(delayMs, async () => {
      this.pumpRequested = false;
      await this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    let nextDelayMs = 0;
    try {
      const outbound = this.takeNextOutbound();
      if (!outbound) return;
      this.activeOutbound = outbound;
      const chunkIndex = outbound.pendingChunks.shift();
      if (chunkIndex === undefined) return;
      const frame = outbound.frames[chunkIndex];
      if (!frame) return;
      outbound.started = true;
      if (outbound.firstSentAt === undefined) {
        outbound.firstSentAt = this.clock.now();
        observeTiming(
          this.mutableMetrics.queue_wait_ms_by_priority[outbound.identity.priority],
          outbound.firstSentAt - outbound.queuedAt
        );
      }
      try {
        await this.radio.send(frame, { channel: this.privateChannel });
      } catch (error) {
        if (this.stopped) return;
        this.mutableMetrics.radio_send_failures++;
        if (outbound.delivery === "confirmed") {
          if (this.outboundByOperation.has(outbound.identity.operation_id)) {
            outbound.pendingChunks.unshift(chunkIndex);
            this.deferRadioSendRetry(outbound);
          }
          return;
        }
        this.failBestEffort(outbound, `radio send failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (this.stopped) return;
      if (outbound.delivery === "confirmed" && !this.outboundByOperation.has(outbound.identity.operation_id)) return;
      nextDelayMs = this.radio.pacingDelayMs?.(frame) ?? 0;
      if ((outbound.chunkSendCounts[chunkIndex] ?? 0) > 0) this.mutableMetrics.retransmitted_packets++;
      outbound.chunkSendCounts[chunkIndex] = (outbound.chunkSendCounts[chunkIndex] ?? 0) + 1;
      this.mutableMetrics.packets_sent++;
      this.mutableMetrics.transmitted_bytes += frame.byteLength;
      this.mutableMetrics.packets_sent_by_message_type[outbound.identity.message_type]++;
      this.mutableMetrics.transmitted_bytes_by_priority[outbound.identity.priority] += frame.byteLength;
      this.emit({
        type: "packet_sent",
        message_id: outbound.identity.message_id,
        operation_id: outbound.identity.operation_id,
        bytes: frame.byteLength,
        sent_at: this.clock.now()
      });
      if (outbound.pendingChunks.length > 0) {
        this.queue.push(outbound);
      } else {
        this.afterAllChunksSent(outbound);
      }
    } finally {
      this.activeOutbound = undefined;
      this.pumping = false;
      if (this.outboundOccupancy() + this.pendingInbound.size < this.queueLimit) {
        this.emitCapacityAvailable();
      }
      if (this.queue.length > 0) this.requestPump(nextDelayMs);
    }
  }

  private takeNextOutbound(): Outbound | undefined {
    let bestIndex = -1;
    for (let index = 0; index < this.queue.length; index++) {
      const candidate = this.queue[index];
      if (!candidate || !this.objectEligible(candidate)) continue;
      const best = bestIndex < 0 ? undefined : this.queue[bestIndex];
      if (
        !best ||
        PRIORITY_ORDER[candidate.identity.priority] < PRIORITY_ORDER[best.identity.priority] ||
        (candidate.identity.priority === best.identity.priority && candidate.order < best.order)
      ) {
        bestIndex = index;
      }
    }
    if (bestIndex < 0) return undefined;
    return this.queue.splice(bestIndex, 1)[0];
  }

  private objectEligible(outbound: Outbound): boolean {
    if (outbound.message.type !== "object_content") return true;
    if (this.activeObjectMessageID === undefined) this.activeObjectMessageID = outbound.identity.message_id;
    return this.activeObjectMessageID === outbound.identity.message_id;
  }

  private afterAllChunksSent(outbound: Outbound): void {
    if (outbound.message.type === "object_content" && this.activeObjectMessageID === outbound.identity.message_id) {
      this.activeObjectMessageID = undefined;
    }
    if (outbound.delivery === "best_effort") {
      const result: LinkOperationResult = {
        operation_id: outbound.identity.operation_id,
        status: "sent",
        completed_at: this.clock.now()
      };
      this.recordOperationTiming(outbound);
      this.recordOperation(result);
      this.emit({ type: "operation", result });
      return;
    }
    this.scheduleRetry(outbound);
  }

  private scheduleRetry(outbound: Outbound): void {
    if (outbound.retryTimer) this.clock.cancel(outbound.retryTimer);
    outbound.retryTimer = this.clock.schedule(this.retryIntervalMs ?? RETRY_MS[outbound.identity.priority], () =>
      this.retryOutbound(outbound)
    );
  }

  private deferRadioSendRetry(outbound: Outbound): void {
    if (outbound.retryTimer) this.clock.cancel(outbound.retryTimer);
    outbound.retryTimer = this.clock.schedule(this.retryIntervalMs ?? RETRY_MS[outbound.identity.priority], () => {
      delete outbound.retryTimer;
      if (!this.outboundByOperation.has(outbound.identity.operation_id) || this.stopped) return;
      outbound.order = this.nextOrder++;
      this.queue.push(outbound);
      this.requestPump();
    });
  }

  private retryOutbound(outbound: Outbound): void {
    if (!this.outboundByOperation.has(outbound.identity.operation_id) || this.stopped) return;
    outbound.pendingChunks = outbound.frames.map((_, index) => index);
    outbound.order = this.nextOrder++;
    this.queue.push(outbound);
    this.requestPump();
  }

  private receive(packet: RadioPacket): void {
    if (this.stopped || packet.channel !== this.privateChannel) return;
    this.mutableMetrics.packets_received++;
    let frame: LinkFrame;
    try {
      frame = decodeFrame(packet.payload);
    } catch {
      return;
    }
    if (sameNode(frame.source, this.node) || !this.acceptFrameSource(frame)) return;
    if (
      frame.message_type === "object_content" &&
      frame.destination !== undefined &&
      !sameNode(frame.destination, this.node)
    ) {
      return;
    }
    const key = `${frame.source.role}:${frame.source.id}:${frame.source_generation}:${frame.service_session}:${frame.message_id}`;
    let reassembly = this.reassemblies.get(key);
    if (!reassembly) {
      this.makeReassemblyRoom();
      const timer = this.clock.schedule(this.reassemblyTimeoutMs, () => this.expireReassembly(key));
      reassembly = {
        identity: frameIdentity(frame),
        chunks: new Map(),
        chunkCount: frame.chunk_count,
        byteLength: 0,
        expiresAt: this.clock.now() + DEADLINE_MS[frame.priority],
        lastReceivedAt: packet.received_at,
        timer
      };
      this.reassemblies.set(key, reassembly);
    }
    if (!sameFrameSet(reassembly, frame)) return;
    if (reassembly.chunks.has(frame.chunk_index)) {
      this.mutableMetrics.duplicate_packets_suppressed++;
      return;
    }
    if (reassembly.byteLength + frame.payload.byteLength > MAX_LINK_MESSAGE_BYTES) {
      this.clock.cancel(reassembly.timer);
      this.reassemblies.delete(key);
      this.mutableMetrics.incomplete_reassemblies++;
      return;
    }
    reassembly.chunks.set(frame.chunk_index, frame.payload);
    reassembly.byteLength += frame.payload.byteLength;
    reassembly.lastReceivedAt = packet.received_at;
    this.clock.cancel(reassembly.timer);
    if (reassembly.chunks.size !== reassembly.chunkCount) {
      reassembly.timer = this.clock.schedule(this.reassemblyTimeoutMs, () => this.expireReassembly(key));
      return;
    }
    this.reassemblies.delete(key);
    this.handleCompleteMessage(reassembly.identity, joinChunks(reassembly));
  }

  private acceptFrameSource(frame: LinkFrame): boolean {
    const current = this.sourceFences.get(`${frame.source.role}:${frame.source.id}`);
    const accepted =
      current === undefined ||
      frame.source_generation > current.generation ||
      (frame.source_generation === current.generation && frame.service_session === current.session);
    if (!accepted) this.mutableMetrics.stale_messages_rejected++;
    return accepted;
  }

  private handleCompleteMessage(identity: FrameIdentity, bytes: Uint8Array): void {
    let message: LinkMessage;
    try {
      message = deserializeLinkMessage(bytes);
    } catch {
      return;
    }
    if (message.type !== identity.message_type || messagePriority(message) !== identity.priority) return;
    if (!validStateSource(message, identity.source)) return;
    if (!this.activateSourceFence(identity.source, identity.source_generation, identity.service_session)) return;
    if (message.type === "control") {
      if (identity.destination !== undefined && !sameNode(identity.destination, this.node)) return;
      this.handleControl(message, identity);
      return;
    }
    if (deliveryClass(message) === "confirmed" && identity.destination === undefined) return;
    const addressed = identity.destination !== undefined && sameNode(identity.destination, this.node);
    if (message.type === "task_delivery" && identity.source.role !== "gateway") {
      if (addressed) {
        const settlementID = inboundSettlementID(identity);
        this.recordSettledInbound(settlementID, "rejected");
        this.sendControl(
          identity.source,
          {
            type: "control",
            control: "rejected",
            operation_id: identity.operation_id,
            message_id: identity.message_id,
            reason: "Task delivery source is not the Gateway"
          },
          true
        );
      }
      return;
    }
    this.updatePicture(message, identity);
    const requiresSettlement = deliveryClass(message) === "confirmed" && addressed;
    const settlementID = inboundSettlementID(identity);
    if (requiresSettlement) {
      const settled = this.settledInbound.get(settlementID);
      if (settled) {
        this.mutableMetrics.duplicate_packets_suppressed++;
        this.sendControl(
          identity.source,
          {
            type: "control",
            control: settled,
            operation_id: identity.operation_id,
            message_id: identity.message_id
          },
          true
        );
        return;
      }
      if (this.pendingInbound.has(settlementID)) {
        this.mutableMetrics.duplicate_packets_suppressed++;
        return;
      }
      if (
        this.pendingInbound.size >= this.confirmedLimit ||
        this.outboundOccupancy() + this.pendingInbound.size >= this.queueLimit
      ) {
        this.rejectInboundCapacity(identity, settlementID);
        return;
      }
      this.pendingInbound.set(settlementID, {
        source: identity.source,
        operationID: identity.operation_id,
        messageID: identity.message_id,
        timer: this.clock.schedule(DEADLINE_MS[identity.priority], () => this.expirePendingInbound(settlementID))
      });
    }
    if (addressed && (message.type === "data_response" || message.type === "object_content")) {
      this.completeDataRequest(message, identity);
    }
    this.emit({
      type: "message",
      message,
      operation_id: identity.operation_id,
      settlement_id: settlementID,
      source: identity.source,
      ...(identity.destination === undefined ? {} : { destination: identity.destination }),
      source_generation: identity.source_generation,
      service_session: identity.service_session,
      source_sequence: identity.source_sequence,
      received_at: this.clock.now(),
      addressed_to_local: addressed,
      requires_settlement: requiresSettlement
    });
  }

  private updatePicture(message: LinkMessage, identity: FrameIdentity): void {
    if (!this.picture) return;
    let publications: StatePublication[] = [];
    if (message.type === "state") publications = [message];
    else if (message.type === "task_delivery") publications = [taskDeliveryPublication(message)];
    else if (message.type === "task_report") {
      const publication = taskReportPublication(
        message,
        this.picture,
        new Date(this.clock.now()).toISOString(),
        identity
      );
      if (publication) publications = [publication];
    } else if (message.type === "data_response") {
      publications = responsePublications(message, new Date(this.clock.now()).toISOString());
    }
    if (publications.length === 0) return;
    const context: PictureApplyContext = {
      source: identity.source,
      source_generation: identity.source_generation,
      service_session: identity.service_session,
      source_sequence: identity.source_sequence,
      received_at: this.clock.now()
    };
    for (const publication of publications) {
      if (!this.picture.apply(publication, context)) this.mutableMetrics.stale_messages_rejected++;
    }
  }

  private handleControl(message: ControlMessage, identity: FrameIdentity): void {
    if (message.control === "source_active") {
      if (identity.source.role !== "gateway") return;
      const accepted = this.activateSourceFence(
        message.active_source,
        message.active_generation,
        message.active_session
      );
      if (accepted)
        this.picture?.activateSource(message.active_source, message.active_generation, message.active_session);
      return;
    }
    if (identity.destination === undefined || !sameNode(identity.destination, this.node)) return;
    const outbound = this.outboundByOperation.get(message.operation_id);
    if (
      !outbound ||
      outbound.identity.destination === undefined ||
      !sameNode(outbound.identity.destination, identity.source) ||
      message.message_id !== outbound.identity.message_id
    ) {
      return;
    }
    if (message.control === "missing_chunks") {
      if (!message.missing_chunks) return;
      outbound.pendingChunks = message.missing_chunks.filter((index) => outbound.frames[index] !== undefined);
      if (outbound.retryTimer) this.clock.cancel(outbound.retryTimer);
      if (outbound.pendingChunks.length > 0) {
        this.mutableMetrics.fragment_repair_requests_received++;
        removeAll(this.queue, outbound);
        this.queue.push(outbound);
        this.requestPump();
      } else {
        this.scheduleRetry(outbound);
      }
      return;
    }
    if (message.control === "confirmed" && outbound.message.type === "data_request") {
      this.confirmDataRequestTransport(outbound);
    } else {
      this.completeOutbound(outbound, message.control === "confirmed" ? "confirmed" : "rejected", message.reason);
    }
  }

  private activateSourceFence(source: LinkNode, generation: number, session: string): boolean {
    const key = `${source.role}:${source.id}`;
    const current = this.sourceFences.get(key);
    if (
      current &&
      (generation < current.generation || (generation === current.generation && session !== current.session))
    ) {
      this.mutableMetrics.stale_messages_rejected++;
      return false;
    }
    this.sourceFences.set(key, { generation, session });
    return true;
  }

  private expireReassembly(key: string): void {
    const reassembly = this.reassemblies.get(key);
    if (!reassembly) return;
    const addressed =
      reassembly.identity.destination !== undefined && sameNode(reassembly.identity.destination, this.node);
    if (
      reassembly.identity.message_type !== "state" &&
      addressed &&
      this.clock.now() + this.reassemblyTimeoutMs < reassembly.expiresAt
    ) {
      const missing = Array.from({ length: reassembly.chunkCount }, (_, index) => index).filter(
        (index) => !reassembly.chunks.has(index)
      );
      this.sendControl(reassembly.identity.source, {
        type: "control",
        control: "missing_chunks",
        operation_id: reassembly.identity.operation_id,
        message_id: reassembly.identity.message_id,
        missing_chunks: missing
      });
      this.mutableMetrics.fragment_repair_requests_sent++;
      reassembly.timer = this.clock.schedule(this.reassemblyTimeoutMs, () => this.expireReassembly(key));
      return;
    }
    this.reassemblies.delete(key);
    this.mutableMetrics.incomplete_reassemblies++;
  }

  private sendControl(
    destination: LinkNode,
    message: ControlMessage,
    useInboundReservation = false
  ): LinkOperationResult {
    return this.submitWithCapacity(
      message,
      { destination, operationID: `control_${compactID()}` },
      useInboundReservation
    );
  }

  private rejectInboundCapacity(identity: FrameIdentity, settlementID: string): void {
    this.mutableMetrics.confirmed_rejected_overload++;
    this.recordSettledInbound(settlementID, "rejected");
    this.sendControl(
      identity.source,
      {
        type: "control",
        control: "rejected",
        operation_id: identity.operation_id,
        message_id: identity.message_id,
        reason: "inbound confirmed operation capacity is exhausted"
      },
      true
    );
  }

  private expirePendingInbound(settlementID: string): void {
    const pending = this.pendingInbound.get(settlementID);
    if (!pending) return;
    this.sendControl(
      pending.source,
      {
        type: "control",
        control: "rejected",
        operation_id: pending.operationID,
        message_id: pending.messageID,
        reason: "application settlement deadline expired"
      },
      true
    );
    this.pendingInbound.delete(settlementID);
    this.mutableMetrics.inbound_settlement_expired++;
    this.recordSettledInbound(settlementID, "rejected");
  }

  private completeOutbound(outbound: Outbound, status: "confirmed" | "rejected" | "failed", reason?: string): void {
    if (outbound.retryTimer) this.clock.cancel(outbound.retryTimer);
    if (outbound.deadlineTimer) this.clock.cancel(outbound.deadlineTimer);
    this.outboundByOperation.delete(outbound.identity.operation_id);
    const requestID = dataRequestID(outbound);
    if (requestID !== undefined && this.pendingDataRequests.get(requestID) === outbound) {
      this.pendingDataRequests.delete(requestID);
    }
    removeAll(this.queue, outbound);
    if (this.activeObjectMessageID === outbound.identity.message_id) this.activeObjectMessageID = undefined;
    const result: LinkOperationResult = {
      operation_id: outbound.identity.operation_id,
      status,
      ...(reason === undefined ? {} : { reason }),
      completed_at: this.clock.now()
    };
    this.recordOperationTiming(outbound);
    this.recordOperation(result);
    this.emit({ type: "operation", result });
  }

  private confirmDataRequestTransport(outbound: Outbound): void {
    if (outbound.retryTimer) this.clock.cancel(outbound.retryTimer);
    delete outbound.retryTimer;
    this.outboundByOperation.delete(outbound.identity.operation_id);
    removeAll(this.queue, outbound);
    const result: LinkOperationResult = {
      operation_id: outbound.identity.operation_id,
      status: "confirmed"
    };
    this.recordOperation(result);
    this.emit({ type: "operation", result });
  }

  private completeDataRequest(
    message: DataResponse | (LinkMessage & { type: "object_content" }),
    identity: FrameIdentity
  ): void {
    const requestID = message.request_id;
    if (requestID === undefined) return;
    const outbound = this.pendingDataRequests.get(requestID);
    if (
      !outbound ||
      outbound.message.type !== "data_request" ||
      outbound.identity.destination === undefined ||
      !sameNode(outbound.identity.destination, identity.source) ||
      (message.type === "data_response" && message.operation !== outbound.message.operation) ||
      (message.type === "object_content" && outbound.message.operation !== "object.content")
    ) {
      return;
    }
    if (outbound.retryTimer) this.clock.cancel(outbound.retryTimer);
    if (outbound.deadlineTimer) this.clock.cancel(outbound.deadlineTimer);
    this.pendingDataRequests.delete(requestID);
    this.outboundByOperation.delete(outbound.identity.operation_id);
    removeAll(this.queue, outbound);
    const result: LinkOperationResult = {
      operation_id: outbound.identity.operation_id,
      status: "responded",
      ...(message.type === "data_response" && message.output !== undefined ? { output: message.output } : {}),
      ...(message.type === "data_response" && message.next_cursor !== undefined
        ? { next_cursor: message.next_cursor }
        : {}),
      ...(message.type === "object_content"
        ? {
            output: {
              object_id: message.object_id,
              content_base64: message.content_base64,
              sha256: message.sha256
            }
          }
        : {}),
      completed_at: this.clock.now()
    };
    this.recordOperationTiming(outbound);
    this.recordOperation(result);
    this.emit({ type: "operation", result });
  }

  private failBestEffort(outbound: Outbound, reason: string): void {
    removeAll(this.queue, outbound);
    if (this.activeObjectMessageID === outbound.identity.message_id) this.activeObjectMessageID = undefined;
    const result: LinkOperationResult = {
      operation_id: outbound.identity.operation_id,
      status: "failed",
      reason,
      completed_at: this.clock.now()
    };
    this.recordOperationTiming(outbound);
    this.recordOperation(result);
    this.emit({ type: "operation", result });
  }

  private replaceQueuedBestEffort(replacement: Outbound): void {
    const previous = this.queue.find(
      (item) => !item.started && item.delivery === "best_effort" && item.coalescingKey === replacement.coalescingKey
    );
    if (!previous) return;
    removeAll(this.queue, previous);
    const result: LinkOperationResult = {
      operation_id: previous.identity.operation_id,
      status: "failed",
      reason: "replaced by newer unsent state",
      completed_at: this.clock.now()
    };
    this.recordOperation(result);
    this.emit({ type: "operation", result });
    this.mutableMetrics.best_effort_replaced++;
  }

  private makeReassemblyRoom(): void {
    if (this.reassemblies.size < this.reassemblyLimit) return;
    const oldest = [...this.reassemblies.entries()].sort(
      ([, left], [, right]) => left.lastReceivedAt - right.lastReceivedAt
    )[0];
    if (!oldest) return;
    this.clock.cancel(oldest[1].timer);
    this.reassemblies.delete(oldest[0]);
    this.mutableMetrics.incomplete_reassemblies++;
  }

  private confirmedCount(): number {
    return new Set([...this.outboundByOperation.values(), ...this.pendingDataRequests.values()]).size;
  }

  private outboundOccupancy(): number {
    return this.queue.length + (this.activeOutbound && !this.queue.includes(this.activeOutbound) ? 1 : 0);
  }

  private failedResult(operationID: string, reason: string): LinkOperationResult {
    const result: LinkOperationResult = {
      operation_id: operationID,
      status: "failed",
      reason,
      completed_at: this.clock.now()
    };
    this.recordOperation(result);
    this.emit({ type: "operation", result });
    return result;
  }

  private recordOperation(result: LinkOperationResult): void {
    const previous = this.operationResults.get(result.operation_id);
    if (isCountedOutcome(result.status) && (previous === undefined || !isCountedOutcome(previous.status))) {
      this.mutableMetrics.operation_outcomes[result.status]++;
    }
    this.operationResults.set(result.operation_id, result);
    while (this.operationResults.size > OPERATION_RESULT_LIMIT) {
      const removable = [...this.operationResults].find(([, candidate]) => candidate.status !== "queued");
      if (!removable) return;
      this.operationResults.delete(removable[0]);
    }
  }

  private recordSettledInbound(settlementID: string, result: "confirmed" | "rejected"): void {
    this.settledInbound.set(settlementID, result);
    while (this.settledInbound.size > SETTLED_INBOUND_LIMIT) {
      const oldest = this.settledInbound.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.settledInbound.delete(oldest);
    }
  }

  private recordOperationTiming(outbound: Outbound): void {
    observeTiming(
      this.mutableMetrics.operation_latency_ms_by_priority[outbound.identity.priority],
      this.clock.now() - outbound.queuedAt
    );
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  private emitCapacityAvailable(): void {
    for (const listener of this.capacityListeners) {
      try {
        listener();
      } catch {
        this.capacityListeners.delete(listener);
      }
    }
  }
}

function frameIdentity(frame: LinkFrame): FrameIdentity {
  return {
    revision: frame.revision,
    message_type: frame.message_type,
    source: frame.source,
    ...(frame.destination === undefined ? {} : { destination: frame.destination }),
    source_generation: frame.source_generation,
    service_session: frame.service_session,
    source_sequence: frame.source_sequence,
    operation_id: frame.operation_id,
    message_id: frame.message_id,
    priority: frame.priority
  };
}

function inboundSettlementID(identity: FrameIdentity): string {
  return createHash("sha256")
    .update(identity.source.role)
    .update("\0")
    .update(identity.source.id)
    .update("\0")
    .update(String(identity.source_generation))
    .update("\0")
    .update(identity.service_session)
    .update("\0")
    .update(identity.operation_id)
    .digest("base64url");
}

function sameFrameSet(reassembly: Reassembly, frame: LinkFrame): boolean {
  const identity = reassembly.identity;
  return (
    reassembly.chunkCount === frame.chunk_count &&
    identity.message_type === frame.message_type &&
    sameNode(identity.source, frame.source) &&
    sameOptionalNode(identity.destination, frame.destination) &&
    identity.source_generation === frame.source_generation &&
    identity.service_session === frame.service_session &&
    identity.source_sequence === frame.source_sequence &&
    identity.operation_id === frame.operation_id &&
    identity.priority === frame.priority
  );
}

function joinChunks(reassembly: Reassembly): Uint8Array {
  const ordered = Array.from({ length: reassembly.chunkCount }, (_, index) => reassembly.chunks.get(index));
  if (ordered.some((chunk) => chunk === undefined)) throw new Error("cannot join incomplete reassembly");
  const chunks = ordered as Uint8Array[];
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function taskDeliveryPublication(message: TaskDelivery): StatePublication {
  return {
    type: "state",
    resource_type: "task",
    resource: message.task,
    observation_time: message.task.updated_at,
    path: "gateway_feed",
    confirmation: "core_confirmed"
  };
}

function responsePublications(response: DataResponse, observedAt: string): StatePublication[] {
  const { operation, output, request_id: operationID } = response;
  switch (operation) {
    case "entity.get":
    case "entity.create":
    case "entity.update":
      return isEntityResource(output) ? [entityPublication(output, operationID)] : [];
    case "entity.check_in":
      return isEntityCheckInResponse(output) ? [entityPublication(output.entity, operationID)] : [];
    case "task.get":
    case "task.create":
    case "task.acknowledge":
    case "task.start":
    case "task.progress":
    case "task.complete":
    case "task.fail":
    case "task.cancel":
      return isTaskResource(output) ? [taskPublication(output, operationID)] : [];
    case "runtime.tasks":
      return isRuntimeTaskDeliveryResponse(output)
        ? output.tasks.map((task) => taskPublication(task, operationID))
        : [];
    case "object.get":
    case "object.create":
    case "object.update":
      return isObjectDetailResource(output) ? [objectPublication(objectSummary(output), operationID)] : [];
    case "query.full":
      return isFullDatasetResponse(output)
        ? [
            ...output.entities.map((entity) => entityPublication(entity, operationID)),
            ...output.tasks.map((task) => taskPublication(task, operationID)),
            ...output.objects.map((object) => objectPublication(objectSummary(object), operationID))
          ]
        : [];
    case "query.changed_since":
      return isChangedSinceResponse(output)
        ? output.events.flatMap((event) => {
            if (event.event !== "delete") {
              switch (event.resource_type) {
                case "entity":
                  return [entityPublication(event.resource, operationID)];
                case "task":
                  return [taskPublication(event.resource, operationID)];
                case "object":
                  return [objectPublication(event.resource, operationID)];
              }
            }
            return [deletedPublication(event.resource_type, event.id, event.version, operationID, observedAt)];
          })
        : [];
    case "object.content":
    case "entity.delete":
    case "runtime.begin":
    case "runtime.stop":
    case "runtime.ready":
    case "object.delete":
    case "command_catalog.get":
    case "plugin.list":
    case "plugin.invoke":
    case "plugin.invoke_spatial":
      return [];
  }
}

function entityPublication(resource: EntityResource, operationID: string): StatePublication {
  return {
    type: "state",
    resource_type: "entity",
    resource,
    observation_time: resource.metadata.updated_at,
    path: "gateway_feed",
    confirmation: "core_confirmed",
    operation_id: operationID
  };
}

function taskPublication(resource: TaskResource, operationID: string): StatePublication {
  return {
    type: "state",
    resource_type: "task",
    resource,
    observation_time: resource.updated_at,
    path: "gateway_feed",
    confirmation: "core_confirmed",
    operation_id: operationID
  };
}

function objectPublication(resource: ObjectResource, operationID: string): StatePublication {
  return {
    type: "state",
    resource_type: "object",
    resource,
    observation_time: resource.metadata.updated_at,
    path: "gateway_feed",
    confirmation: "core_confirmed",
    operation_id: operationID
  };
}

function deletedPublication(
  resourceType: "entity" | "object",
  resourceIDValue: string,
  atlasVersion: number,
  operationID: string,
  observedAt: string
): StatePublication {
  return {
    type: "state",
    resource_type: resourceType,
    resource_id: resourceIDValue,
    deleted: true,
    atlas_version: atlasVersion,
    observation_time: observedAt,
    path: "gateway_feed",
    confirmation: "core_confirmed",
    operation_id: operationID
  };
}

function objectSummary(resource: ObjectDetailResource): ObjectResource {
  return {
    object_id: resource.object_id,
    type: resource.type,
    content_type: resource.content_type,
    size_bytes: resource.size_bytes,
    bucket: resource.bucket,
    path: resource.path,
    usage_hints: resource.usage_hints,
    ...(resource.referenced_by === undefined ? {} : { referenced_by: resource.referenced_by }),
    metadata: resource.metadata
  };
}

function taskReportPublication(
  message: TaskReport,
  picture: SharedPicture,
  observedAt: string,
  identity: FrameIdentity
): StatePublication | undefined {
  const current = picture
    .snapshot()
    .records.find((record) => record.resource_type === "task" && record.id === message.task_id)?.state as
    | TaskResource
    | undefined;
  if (!current || current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
    return undefined;
  }
  const acknowledgedAt = current.acknowledged_at ?? observedAt;
  const startedAt = current.started_at ?? observedAt;
  const common = {
    asset_id: current.asset_id,
    command: current.command,
    created_at: current.created_at,
    input: current.input,
    task_id: current.task_id,
    updated_at: observedAt
  };
  let task: TaskResource;
  switch (message.action) {
    case "acknowledge":
      task = { ...common, acknowledged_at: acknowledgedAt, status: "acknowledged" };
      break;
    case "start":
      task = { ...common, acknowledged_at: acknowledgedAt, started_at: startedAt, status: "in_progress" };
      break;
    case "progress":
      task = {
        ...common,
        acknowledged_at: acknowledgedAt,
        started_at: startedAt,
        status: "in_progress",
        progress: message.body.progress
      };
      break;
    case "complete":
      task = {
        ...common,
        acknowledged_at: acknowledgedAt,
        started_at: startedAt,
        finished_at: observedAt,
        status: "completed",
        progress: 1,
        ...(message.body.output === undefined ? {} : { output: message.body.output })
      };
      break;
    case "fail":
      task = {
        ...common,
        ...(current.acknowledged_at === undefined ? {} : { acknowledged_at: current.acknowledged_at }),
        ...(current.started_at === undefined ? {} : { started_at: current.started_at }),
        finished_at: observedAt,
        status: "failed",
        failure: message.body.failure
      };
      break;
    case "cancel":
      task = {
        ...common,
        ...(current.acknowledged_at === undefined ? {} : { acknowledged_at: current.acknowledged_at }),
        ...(current.started_at === undefined ? {} : { started_at: current.started_at }),
        finished_at: observedAt,
        status: "cancelled",
        cancellation: message.body.cancellation
      };
      break;
  }
  return {
    type: "state",
    resource_type: "task",
    resource: task,
    observation_time: observedAt,
    path: "field",
    confirmation: "awaiting_core",
    operation_id: identity.operation_id,
    runtime_id: message.runtime_id
  };
}

function operationIDFor(message: LinkMessage): string {
  if (message.type === "data_request" || message.type === "data_response") return message.request_id;
  if (message.type === "control") return message.operation_id;
  if (message.type === "state" && message.operation_id) return message.operation_id;
  return compactID();
}

function dataRequestID(outbound: Outbound): string | undefined {
  return outbound.message.type === "data_request" ? outbound.message.request_id : undefined;
}

function validStateSource(message: LinkMessage, source: LinkNode): boolean {
  if (message.type !== "state" || source.role !== "asset") return true;
  return (
    message.path === "field" && (message.confirmation === "awaiting_core" || message.confirmation === "not_required")
  );
}

function compactID(): string {
  return randomBytes(8).toString("base64url");
}

function validateNode(node: LinkNode): void {
  if ((node.role !== "asset" && node.role !== "gateway") || !node.id.trim() || node.id.includes(":")) {
    throw new TypeError("invalid Link node");
  }
}

function sameNode(left: LinkNode, right: LinkNode): boolean {
  return left.role === right.role && left.id === right.id;
}

function sameOptionalNode(left: LinkNode | undefined, right: LinkNode | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && sameNode(left, right);
}

function positiveBoundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function removeAll<T>(values: T[], target: T): void {
  for (let index = values.length - 1; index >= 0; index--) if (values[index] === target) values.splice(index, 1);
}

function emptyMessageTypeCounter(): Record<LinkMessage["type"], number> {
  return {
    state: 0,
    task_delivery: 0,
    task_report: 0,
    data_request: 0,
    data_response: 0,
    resource_operation: 0,
    subscription: 0,
    object_content: 0,
    control: 0
  };
}

function emptyPriorityCounter(): Record<MessagePriority, number> {
  return { safety: 0, task: 0, request: 0, live_state: 0, resource: 0, object_content: 0 };
}

function emptyPriorityTimings(): Record<MessagePriority, { samples: number; total_ms: number; maximum_ms: number }> {
  return {
    safety: emptyTiming(),
    task: emptyTiming(),
    request: emptyTiming(),
    live_state: emptyTiming(),
    resource: emptyTiming(),
    object_content: emptyTiming()
  };
}

function emptyTiming(): { samples: number; total_ms: number; maximum_ms: number } {
  return { samples: 0, total_ms: 0, maximum_ms: 0 };
}

function observeTiming(metric: { samples: number; total_ms: number; maximum_ms: number }, durationMs: number): void {
  metric.samples++;
  metric.total_ms += durationMs;
  metric.maximum_ms = Math.max(metric.maximum_ms, durationMs);
}

function isCountedOutcome(status: LinkOperationStatus): status is "sent" | "confirmed" | "rejected" | "failed" {
  return status === "sent" || status === "confirmed" || status === "rejected" || status === "failed";
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
