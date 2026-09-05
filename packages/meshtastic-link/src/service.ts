import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isTaskResource, type TaskResource } from "@the-drunken-coder/atlas-sdk";
import type { Clock, TimerHandle } from "./clock.js";
import { isFeedSelector, isLinkMessage } from "./contract.js";
import { OrderedTaskDispatcher, TaskQueueCapacityError } from "./gateway.js";
import type { AssetJoinStatus } from "./joining.js";
import { PictureCursorError, type PictureEvent, type PictureSnapshot, SharedPicture } from "./picture.js";
import {
  type ConfigurationEvidence,
  type RadioProfile,
  type RadioProfileInspection,
  type RadioProfileManager,
  validateRadioProfile
} from "./profile.js";
import { type LinkRadioTransmissionGate, RadioUnavailableError } from "./radio.js";
import {
  LocalSubscriptionDemand,
  SUBSCRIPTION_LEASE_MS,
  SUBSCRIPTION_RENEWAL_MS,
  type SubscriptionTransition
} from "./subscriptions.js";
import {
  LinkTransport,
  type TransportDiagnostics,
  type TransportEvent,
  type TransportMessageEvent
} from "./transport.js";
import type { FeedSelector, LinkMessage, LinkMetrics, LinkNode, LinkOperationResult, LinkRole } from "./types.js";

const MAX_REQUEST_BYTES = 128 * 1024;
const SERVICE_EVENT_LIMIT = 1024;
const CLIENT_CLEANUP_MS = 5_000;
const PICTURE_REFRESH_MS = 1_000;
const LOCAL_OPERATION_LIMIT = 4_096;
const SSE_MAX_PENDING_EVENTS = SERVICE_EVENT_LIMIT;
const SSE_MAX_PENDING_BYTES = 16 * 1024 * 1024;

export type LinkLifecycle = "configuring" | "discovering" | "active" | "stopped" | "error";

export type LinkServiceStatus = {
  mode: LinkRole;
  node: LinkNode;
  lifecycle: LinkLifecycle;
  service_session: string;
  gateway_available: boolean;
  detail?: string;
  joining?: AssetJoinStatus;
  picture: { session: string; revision: number; records: number };
  transport?: TransportDiagnostics;
};

export type LinkServiceEvent =
  | { sequence: number; type: "transport"; event: TransportEvent }
  | { sequence: number; type: "status"; status: LinkServiceStatus };

export type RadioProfileStatus = { available: false } | ({ available: true } & RadioProfileInspection);

type LinkServiceEventInput =
  | { type: "transport"; event: TransportEvent }
  | { type: "status"; status: LinkServiceStatus };

export type LinkServiceOptions = {
  mode: LinkRole;
  nodeID: string;
  clock: Clock;
  picture?: SharedPicture;
  profileManager?: RadioProfileManager;
  radioGate?: LinkRadioTransmissionGate;
  gatewayNode?: LinkNode;
  onGatewaySubscriptionTransition?: (transition: SubscriptionTransition) => void;
};

export class LinkService {
  readonly picture: SharedPicture;
  readonly node: LinkNode;
  readonly serviceSession = randomBytes(12).toString("base64url");
  private readonly clock: Clock;
  private readonly profileManager: RadioProfileManager | undefined;
  private readonly radioGate: LinkRadioTransmissionGate | undefined;
  private readonly subscriptions = new LocalSubscriptionDemand();
  private readonly eventListeners = new Set<(event: LinkServiceEvent) => void>();
  private readonly eventBuffer: LinkServiceEvent[] = [];
  private readonly localOperations = new Map<string, LinkOperationResult>();
  private readonly clientLeaseTimers = new Map<string, TimerHandle>();
  private transport: LinkTransport | undefined;
  private taskDispatcher: OrderedTaskDispatcher | undefined;
  private unsubscribeTransport: (() => void) | undefined;
  private gatewayNode: LinkNode | undefined;
  private lifecycle: LinkLifecycle = "configuring";
  private statusDetail: string | undefined;
  private joiningStatus: AssetJoinStatus | undefined;
  private eventSequence = 0;
  private renewalTimer: TimerHandle | undefined;
  private pictureRefreshTimer: TimerHandle | undefined;
  private profileApplyTail: Promise<void> = Promise.resolve();
  private profileApplyActive = false;
  private profileApplyGeneration = 0;
  private transportSubscriptionsDispatched = false;

  constructor(private readonly options: LinkServiceOptions) {
    if (!options.nodeID || options.nodeID.includes(":")) throw new TypeError("Link node ID is invalid");
    this.clock = options.clock;
    this.picture = options.picture ?? new SharedPicture(this.serviceSession);
    this.node = { role: options.mode, id: options.nodeID };
    this.profileManager = options.profileManager;
    this.radioGate = options.radioGate;
    this.gatewayNode = options.gatewayNode;
    this.schedulePictureRefresh();
  }

  attachTransport(transport: LinkTransport, gatewayNode?: LinkNode): void {
    if (this.transport) throw new Error("Link transport is already attached");
    if (transport.node.role !== this.node.role || transport.node.id !== this.node.id) {
      throw new Error("Link transport identity does not match the service");
    }
    this.transport = transport;
    if (this.node.role === "gateway") this.taskDispatcher = new OrderedTaskDispatcher(transport);
    if (gatewayNode) this.gatewayNode = gatewayNode;
    this.unsubscribeTransport = transport.onEvent((event) => this.handleTransportEvent(event));
    if (this.profileApplyActive || this.lifecycle === "error" || this.lifecycle === "stopped") void transport.pause();
    if (!this.profileApplyActive && this.lifecycle !== "error" && this.lifecycle !== "stopped") {
      this.activateTransport();
    }
  }

  setLifecycle(lifecycle: LinkLifecycle, detail?: string): void {
    if (this.lifecycle === "stopped") return;
    if (this.lifecycle === "error" && lifecycle !== "error" && lifecycle !== "stopped" && !this.profileApplyActive)
      return;
    this.lifecycle = lifecycle;
    this.statusDetail = detail;
    if (lifecycle === "configuring" || lifecycle === "error" || lifecycle === "stopped") {
      if (this.renewalTimer) this.clock.cancel(this.renewalTimer);
      this.renewalTimer = undefined;
    }
    this.emit({ type: "status", status: this.status() });
  }

  setJoiningStatus(status: AssetJoinStatus): void {
    this.joiningStatus = status;
  }

  setJoiningLifecycle(lifecycle: "discovering" | "active", detail?: string): void {
    if (this.lifecycle === "stopped" || this.lifecycle === "error" || this.profileApplyActive) return;
    this.setLifecycle(lifecycle, detail);
  }

  isRadioProfileApplying(): boolean {
    return this.profileApplyActive;
  }

  status(): LinkServiceStatus {
    const snapshot = this.snapshot();
    return {
      mode: this.options.mode,
      node: this.node,
      lifecycle: this.lifecycle,
      service_session: this.serviceSession,
      gateway_available: this.options.mode === "gateway" || this.gatewayNode !== undefined,
      ...(this.statusDetail === undefined ? {} : { detail: this.statusDetail }),
      ...(this.joiningStatus === undefined ? {} : { joining: structuredClone(this.joiningStatus) }),
      picture: { session: snapshot.session, revision: snapshot.revision, records: snapshot.records.length },
      ...(this.transport === undefined ? {} : { transport: this.transport.diagnostics() })
    };
  }

  snapshot(): PictureSnapshot {
    this.picture.refresh(this.clock.now());
    return this.picture.snapshot();
  }

  metrics(): LinkMetrics | undefined {
    return this.transport?.metrics();
  }

  taskState(assetID: string): ReturnType<OrderedTaskDispatcher["state"]> | undefined {
    validateTaskAssetID(assetID);
    return this.taskDispatcher?.state(assetID);
  }

  taskMutationFailure(): string | undefined {
    if (this.node.role !== "gateway") return "Task dispatch requires Gateway mode";
    if (this.lifecycle !== "active") return "Task dispatch requires an active Link service";
    if (!this.transport || !this.taskDispatcher) return "Gateway Task dispatcher is unavailable";
    return undefined;
  }

  enqueueTask(
    assetID: string,
    task: TaskResource,
    delivery: "assignment" | "cancellation"
  ): ReturnType<OrderedTaskDispatcher["state"]> {
    validateTaskForAsset(assetID, task);
    const dispatcher = this.requireTaskDispatcher();
    dispatcher.enqueue(assetID, task, delivery);
    return dispatcher.state(assetID);
  }

  enqueueTaskAssignments(assetID: string, tasks: readonly TaskResource[]): ReturnType<OrderedTaskDispatcher["state"]> {
    validateTaskAssetID(assetID);
    if (tasks.length === 0) throw new TypeError("Task assignment batch must not be empty");
    const seen = new Set<string>();
    for (const task of tasks) {
      validateTaskForAsset(assetID, task);
      if (seen.has(task.task_id)) throw new TypeError("Task assignment batch contains a duplicate Task ID");
      seen.add(task.task_id);
    }
    const dispatcher = this.requireTaskDispatcher();
    dispatcher.enqueueAssignments(assetID, tasks);
    return dispatcher.state(assetID);
  }

  observeAuthoritativeTask(assetID: string, task: TaskResource): ReturnType<OrderedTaskDispatcher["state"]> {
    validateTaskForAsset(assetID, task);
    if (!isTerminalTask(task)) throw new TypeError("authoritative Task observation must be terminal");
    const dispatcher = this.requireTaskDispatcher();
    dispatcher.observeAuthoritativeTask(assetID, task);
    return dispatcher.state(assetID);
  }

  submit(message: LinkMessage, destination?: LinkNode, operationIDValue?: string): LinkOperationResult {
    if (!isLinkMessage(message)) throw new TypeError("invalid Radio contract message");
    const stableOperationID = operationIDValue ?? operationID(message);
    if (this.node.role === "gateway" && message.type === "task_delivery") {
      return this.failLocal(stableOperationID, "Gateway task_delivery must use the /v1/tasks routes");
    }
    if (this.lifecycle === "configuring" || this.lifecycle === "error") {
      return this.failLocal(stableOperationID, "Link service is not transmitting");
    }
    if (!this.transport) return this.failLocal(stableOperationID, "Link transport is unavailable");
    const target = destination ?? this.defaultDestination(message);
    if (this.node.role === "asset" && requiresGateway(message)) {
      if (target === undefined || this.gatewayNode === undefined) {
        return this.failLocal(stableOperationID, "Gateway is unavailable");
      }
      if (!sameNode(target, this.gatewayNode)) {
        return this.failLocal(stableOperationID, "Gateway-required message must target the active Gateway");
      }
    }
    return this.transport.submit(message, {
      ...(target === undefined ? {} : { destination: target }),
      operationID: stableOperationID
    });
  }

  settleInbound(settlementID: string, accepted: boolean, reason?: string): boolean {
    return this.transport?.settleInbound(settlementID, accepted, reason) ?? false;
  }

  operation(operationID: string): LinkOperationResult | undefined {
    const local = this.localOperations.get(operationID);
    if (local !== undefined && local.status !== "failed") return structuredClone(local);
    const transport = this.transport?.status(operationID);
    if (transport !== undefined) return transport;
    return local === undefined ? undefined : structuredClone(local);
  }

  updateLocalSubscription(
    clientID: string,
    action: "add" | "renew" | "remove",
    selector: FeedSelector
  ): { changed: boolean; active: number; reason?: string } {
    if (!clientID) throw new TypeError("client ID must not be empty");
    if (this.node.role === "asset" && (!this.transport || !this.gatewayNode)) {
      return { changed: false, active: this.subscriptions.aggregate().size, reason: "Gateway is unavailable" };
    }
    if (this.node.role === "gateway" && !this.options.onGatewaySubscriptionTransition) {
      return {
        changed: false,
        active: this.subscriptions.aggregate().size,
        reason: "Gateway feed bridge is unavailable"
      };
    }
    const transition =
      action === "remove" ? this.subscriptions.remove(clientID, selector) : this.subscriptions.add(clientID, selector);
    if (transition) {
      const failure = this.dispatchSubscription(transition.action, transition.selector);
      if (failure !== undefined) {
        if (transition.action === "add") this.subscriptions.remove(clientID, selector);
        else this.subscriptions.add(clientID, selector);
        return { changed: false, active: this.subscriptions.aggregate().size, reason: failure };
      }
    }
    if (action === "remove") {
      if (!this.subscriptions.hasClient(clientID)) this.cancelClientLease(clientID);
    } else {
      this.renewClientLease(clientID);
    }
    this.scheduleRenewalIfNeeded();
    return { changed: transition !== undefined, active: this.subscriptions.aggregate().size };
  }

  disconnectClient(clientID: string): void {
    this.cancelClientLease(clientID);
    for (const transition of this.subscriptions.disconnect(clientID)) {
      this.dispatchSubscription(transition.action, transition.selector);
    }
    this.scheduleRenewalIfNeeded();
  }

  profile(): RadioProfile | undefined {
    return this.profileManager?.profile();
  }

  replaceProfile(profile: RadioProfile): void {
    if (!this.profileManager) throw new Error("Radio profile management is unavailable");
    this.profileManager.replaceProfile(profile);
  }

  async radioStatus(): Promise<RadioProfileStatus> {
    if (!this.profileManager) return { available: false };
    try {
      return { available: true, ...(await this.profileManager.inspect()) };
    } catch (error) {
      if (error instanceof RadioUnavailableError) return { available: false };
      throw error;
    }
  }

  async applyRadioProfile(): Promise<ConfigurationEvidence> {
    if (!this.profileManager) throw new Error("Radio profile management is unavailable");
    const previous = this.profileApplyTail;
    let release!: () => void;
    this.profileApplyTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.applyRadioProfileOnce();
    } finally {
      release();
    }
  }

  onEvent(listener: (event: LinkServiceEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  eventsAfter(sequence: number): LinkServiceEvent[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.eventSequence) {
      throw new RangeError("service event cursor is invalid");
    }
    const earliest = this.eventBuffer[0]?.sequence ?? this.eventSequence + 1;
    if (sequence < earliest - 1) throw new RangeError("service event cursor expired");
    return this.eventBuffer.filter((event) => event.sequence > sequence);
  }

  stop(): void {
    if (this.lifecycle === "stopped") return;
    this.taskDispatcher?.close();
    this.profileApplyGeneration++;
    this.profileApplyActive = false;
    if (this.renewalTimer) this.clock.cancel(this.renewalTimer);
    if (this.pictureRefreshTimer) this.clock.cancel(this.pictureRefreshTimer);
    for (const timer of this.clientLeaseTimers.values()) this.clock.cancel(timer);
    this.clientLeaseTimers.clear();
    if (this.node.role === "gateway") {
      for (const transition of this.subscriptions.clear()) {
        this.dispatchSubscription(transition.action, transition.selector);
      }
    } else {
      this.subscriptions.clear();
    }
    this.transport?.stop();
    this.radioGate?.abort(new Error("Link service stopped"));
    this.unsubscribeTransport?.();
    this.setLifecycle("stopped");
    this.eventListeners.clear();
  }

  private defaultDestination(message: LinkMessage): LinkNode | undefined {
    if (message.type === "state") return undefined;
    if (this.node.role === "asset") return this.gatewayNode;
    return undefined;
  }

  private requireTaskDispatcher(): OrderedTaskDispatcher {
    const failure = this.taskMutationFailure();
    if (failure) throw new Error(failure);
    if (!this.taskDispatcher) throw new Error("Gateway Task dispatcher is unavailable");
    return this.taskDispatcher;
  }

  private dispatchSubscription(action: "add" | "renew" | "remove", selector: FeedSelector): string | undefined {
    if (this.node.role === "gateway") {
      try {
        this.options.onGatewaySubscriptionTransition?.({ action, selector });
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
    if (this.lifecycle === "configuring" || this.lifecycle === "error" || this.profileApplyActive) {
      return "Link service is not transmitting";
    }
    if (!this.transport || !this.gatewayNode) return "Gateway is unavailable";
    const result = this.transport.submit({ type: "subscription", action, selector }, { destination: this.gatewayNode });
    return result.status === "failed" ? (result.reason ?? "subscription delivery failed") : undefined;
  }

  private renewClientLease(clientID: string): void {
    this.cancelClientLease(clientID);
    this.clientLeaseTimers.set(
      clientID,
      this.clock.schedule(SUBSCRIPTION_LEASE_MS, () => {
        this.clientLeaseTimers.delete(clientID);
        this.disconnectClient(clientID);
      })
    );
  }

  private cancelClientLease(clientID: string): void {
    const timer = this.clientLeaseTimers.get(clientID);
    if (timer) this.clock.cancel(timer);
    this.clientLeaseTimers.delete(clientID);
  }

  private scheduleRenewalIfNeeded(): void {
    if (
      this.lifecycle === "stopped" ||
      (this.node.role === "asset" && (this.lifecycle === "configuring" || this.lifecycle === "error"))
    ) {
      if (this.renewalTimer) this.clock.cancel(this.renewalTimer);
      this.renewalTimer = undefined;
      return;
    }
    const canDispatch =
      this.node.role === "gateway"
        ? this.options.onGatewaySubscriptionTransition !== undefined
        : this.transport !== undefined && this.gatewayNode !== undefined;
    if (!canDispatch || this.subscriptions.aggregate().size === 0) {
      if (this.renewalTimer) this.clock.cancel(this.renewalTimer);
      this.renewalTimer = undefined;
      return;
    }
    if (this.renewalTimer) return;
    this.renewalTimer = this.clock.schedule(SUBSCRIPTION_RENEWAL_MS, () => {
      this.renewalTimer = undefined;
      for (const transition of this.subscriptions.renewals()) {
        this.dispatchSubscription("renew", transition.selector);
      }
      this.scheduleRenewalIfNeeded();
    });
  }

  private schedulePictureRefresh(): void {
    this.pictureRefreshTimer = this.clock.schedule(PICTURE_REFRESH_MS, () => {
      this.pictureRefreshTimer = undefined;
      this.picture.refresh(this.clock.now());
      if (this.lifecycle !== "stopped") this.schedulePictureRefresh();
    });
  }

  private handleTransportEvent(event: TransportEvent): void {
    if (event.type === "link_error") {
      this.profileApplyGeneration++;
      this.profileApplyActive = false;
      this.radioGate?.abort(new Error(event.reason));
      this.setLifecycle("error", event.reason);
    }
    if (event.type === "message" && event.message.type === "task_delivery" && !event.addressed_to_local) return;
    if (
      event.type === "message" &&
      event.addressed_to_local &&
      event.requires_settlement &&
      event.message.type === "data_response"
    ) {
      this.recordLocalOperation({
        operation_id: event.message.request_id,
        status: "responded",
        ...(event.message.output === undefined ? {} : { output: event.message.output }),
        ...(event.message.next_cursor === undefined ? {} : { next_cursor: event.message.next_cursor }),
        completed_at: this.clock.now()
      });
      this.transport?.settleInbound(event.settlement_id, true);
    }
    if (
      event.type === "message" &&
      event.addressed_to_local &&
      event.requires_settlement &&
      event.message.type === "object_content"
    ) {
      if (event.message.request_id) {
        this.recordLocalOperation({
          operation_id: event.message.request_id,
          status: "responded",
          output: {
            object_id: event.message.object_id,
            content_base64: event.message.content_base64,
            sha256: event.message.sha256
          },
          completed_at: this.clock.now()
        });
      }
      this.transport?.settleInbound(event.settlement_id, true);
    }
    this.emit({ type: "transport", event });
  }

  private activateTransport(): void {
    if (!this.transport || this.lifecycle === "stopped" || this.lifecycle === "error" || this.profileApplyActive)
      return;
    this.setLifecycle("active");
    for (const selector of this.subscriptions.aggregate().values()) this.dispatchSubscription("add", selector);
    this.transportSubscriptionsDispatched = true;
    this.scheduleRenewalIfNeeded();
  }

  private async applyRadioProfileOnce(): Promise<ConfigurationEvidence> {
    if (this.lifecycle === "stopped") throw new Error("Link service is stopped");
    const profileManager = this.profileManager;
    if (!profileManager) throw new Error("Radio profile management is unavailable");
    if (!this.radioGate) {
      this.setLifecycle("error", "radio transmission gate is unavailable");
      throw new Error("radio transmission gate is unavailable");
    }
    const generation = ++this.profileApplyGeneration;
    const previousLifecycle = this.lifecycle;
    const hadTransport = this.transport !== undefined;
    const selectedProfile = profileManager.profile();
    this.profileApplyActive = true;
    this.setLifecycle("configuring", "applying and verifying the radio profile");
    try {
      await this.transport?.pause();
      await this.radioGate.suspend();
      if (generation !== this.profileApplyGeneration) {
        throw new Error("Link service stopped during radio profile apply");
      }
      const evidence = await profileManager.apply(selectedProfile);
      if (generation !== this.profileApplyGeneration) {
        throw new Error("Link service stopped during radio profile apply");
      }
      this.profileApplyActive = false;
      this.radioGate.resume();
      this.transport?.resume();
      const resumedLifecycle = hadTransport
        ? "active"
        : previousLifecycle === "discovering"
          ? "discovering"
          : previousLifecycle === "error"
            ? "discovering"
            : previousLifecycle;
      this.setLifecycle(resumedLifecycle, undefined);
      if (this.transport && !this.transportSubscriptionsDispatched) this.activateTransport();
      this.scheduleRenewalIfNeeded();
      return evidence;
    } catch (error) {
      this.profileApplyActive = false;
      if (generation === this.profileApplyGeneration) {
        this.setLifecycle("error", error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  private failLocal(operationIDValue: string, reason: string): LinkOperationResult {
    const result: LinkOperationResult = {
      operation_id: operationIDValue,
      status: "failed",
      reason,
      completed_at: this.clock.now()
    };
    this.recordLocalOperation(result);
    this.emit({ type: "transport", event: { type: "operation", result } });
    return result;
  }

  private recordLocalOperation(result: LinkOperationResult): void {
    this.localOperations.set(result.operation_id, result);
    while (this.localOperations.size > LOCAL_OPERATION_LIMIT) {
      const first = this.localOperations.keys().next().value as string | undefined;
      if (first === undefined) return;
      this.localOperations.delete(first);
    }
  }

  private emit(event: LinkServiceEventInput): void {
    const complete = { ...event, sequence: ++this.eventSequence } as LinkServiceEvent;
    this.eventBuffer.push(complete);
    if (this.eventBuffer.length > SERVICE_EVENT_LIMIT) this.eventBuffer.shift();
    for (const listener of this.eventListeners) {
      try {
        listener(complete);
      } catch (error) {
        console.error("Link service event listener failed; removing listener", error);
        this.eventListeners.delete(listener);
      }
    }
  }
}

export class LinkHTTPServer {
  private readonly server: Server;
  private readonly clientStreams = new Map<string, number>();
  private readonly cleanupTimers = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(private readonly service: LinkService) {
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<{ host: string; port: number }> {
    if (!isLoopbackHost(host)) throw new Error("Link service HTTP interface must bind to loopback");
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Link service did not obtain a TCP address");
    return { host, port: (address as AddressInfo).port };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const clients = new Set([...this.clientStreams.keys(), ...this.cleanupTimers.keys()]);
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
    this.clientStreams.clear();
    for (const clientID of clients) this.service.disconnectClient(clientID);
    const closed = new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve()))
    );
    this.server.closeAllConnections();
    await closed;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (isCrossOriginMutation(request)) {
        return json(response, 403, { error: "browser-originated mutations are not allowed" });
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/status") return json(response, 200, this.service.status());
      if (request.method === "GET" && url.pathname === "/v1/picture")
        return json(response, 200, this.service.snapshot());
      if (request.method === "GET" && url.pathname === "/v1/metrics")
        return json(response, 200, this.service.metrics() ?? {});
      if (request.method === "GET" && url.pathname === "/v1/radio/profile") {
        return json(response, 200, await this.service.radioStatus());
      }
      if (request.method === "GET" && url.pathname === "/v1/picture/events") {
        return this.streamPicture(url, request, response);
      }
      if (request.method === "GET" && url.pathname === "/v1/events") return this.streamEvents(url, request, response);
      const taskMatch = /^\/v1\/tasks\/([^/]+)(?:\/(assignments|authoritative))?$/.exec(url.pathname);
      if (request.method === "GET" && taskMatch?.[1] && taskMatch[2] === undefined) {
        const state = this.service.taskState(decodeURIComponent(taskMatch[1]));
        return state === undefined
          ? json(response, 503, { error: "Gateway Task dispatcher is unavailable" })
          : json(response, 200, state);
      }
      if (request.method === "POST" && taskMatch?.[1]) {
        const assetID = decodeURIComponent(taskMatch[1]);
        const unavailable = this.service.taskMutationFailure();
        if (unavailable) return json(response, 503, { error: unavailable });
        const body = await readJSONObject(request);
        if (taskMatch[2] === undefined) {
          if (!isTaskResource(body.task) || !isTaskDelivery(body.delivery)) {
            return json(response, 400, { error: "invalid Task dispatch request" });
          }
          return json(response, 202, this.service.enqueueTask(assetID, body.task, body.delivery));
        }
        if (taskMatch[2] === "assignments") {
          if (!Array.isArray(body.tasks) || !body.tasks.every(isTaskResource)) {
            return json(response, 400, { error: "invalid Task assignment batch" });
          }
          return json(response, 202, this.service.enqueueTaskAssignments(assetID, body.tasks));
        }
        if (!isTaskResource(body.task)) return json(response, 400, { error: "invalid authoritative Task observation" });
        return json(response, 200, this.service.observeAuthoritativeTask(assetID, body.task));
      }
      const operationMatch = /^\/v1\/operations\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && operationMatch?.[1]) {
        const operation = this.service.operation(decodeURIComponent(operationMatch[1]));
        return operation ? json(response, 200, operation) : json(response, 404, { error: "operation not found" });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        const body = await readJSONObject(request);
        if (
          !isLinkMessage(body.message) ||
          (body.destination !== undefined && !isLinkNode(body.destination)) ||
          (body.operation_id !== undefined &&
            (typeof body.operation_id !== "string" || body.operation_id.trim().length === 0))
        ) {
          return json(response, 400, { error: "invalid Link message request" });
        }
        if (body.message.type === "task_delivery" && this.service.node.role === "gateway") {
          return json(response, 400, { error: "Gateway task_delivery must use the /v1/tasks routes" });
        }
        return json(
          response,
          202,
          this.service.submit(body.message, body.destination, body.operation_id as string | undefined)
        );
      }
      const settleMatch = /^\/v1\/inbound\/([^/]+)\/settle$/.exec(url.pathname);
      if (request.method === "POST" && settleMatch?.[1]) {
        const body = await readJSONObject(request);
        if (typeof body.accepted !== "boolean" || (body.reason !== undefined && typeof body.reason !== "string")) {
          return json(response, 400, { error: "invalid settlement" });
        }
        const settled = this.service.settleInbound(decodeURIComponent(settleMatch[1]), body.accepted, body.reason);
        return json(response, settled ? 200 : 404, { settled });
      }
      if (request.method === "POST" && url.pathname === "/v1/subscriptions") {
        const body = await readJSONObject(request);
        if (
          typeof body.client_id !== "string" ||
          !["add", "renew", "remove"].includes(String(body.action)) ||
          !isFeedSelector(body.selector)
        ) {
          return json(response, 400, { error: "invalid subscription request" });
        }
        const result = this.service.updateLocalSubscription(
          body.client_id,
          body.action as "add" | "renew" | "remove",
          body.selector
        );
        return json(response, result.reason === undefined ? 200 : 503, result);
      }
      const clientMatch = /^\/v1\/clients\/([^/]+)$/.exec(url.pathname);
      if (request.method === "DELETE" && clientMatch?.[1]) {
        this.service.disconnectClient(decodeURIComponent(clientMatch[1]));
        response.writeHead(204).end();
        return;
      }
      if (request.method === "PUT" && url.pathname === "/v1/radio/profile") {
        const body = await readJSONObject(request);
        validateRadioProfile(body);
        this.service.replaceProfile(body);
        return json(response, 200, await this.service.radioStatus());
      }
      if (request.method === "POST" && url.pathname === "/v1/radio/profile/apply") {
        return json(response, 200, await this.service.applyRadioProfile());
      }
      json(response, 404, { error: "route not found" });
    } catch (error) {
      json(
        response,
        error instanceof TaskQueueCapacityError
          ? 503
          : error instanceof PictureCursorError ||
              error instanceof TypeError ||
              error instanceof SyntaxError ||
              error instanceof RangeError ||
              error instanceof URIError
            ? 400
            : 500,
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  private streamPicture(url: URL, request: IncomingMessage, response: ServerResponse): void {
    const session = url.searchParams.get("session") ?? "";
    const revision = Number(url.searchParams.get("after"));
    let unsubscribe: () => void = () => undefined;
    let writer!: SSEWriter;
    const subscription = this.service.picture.subscribeAfter(session, revision, (event) => writer.write(event));
    unsubscribe = subscription.unsubscribe;
    writer = new SSEWriter(response, () => unsubscribe());
    initializeSSE(response);
    for (const event of subscription.replay) writer.write(event);
    request.once("close", () => writer.close());
  }

  private streamEvents(url: URL, request: IncomingMessage, response: ServerResponse): void {
    const after = url.searchParams.get("after");
    const clientID = url.searchParams.get("client_id") ?? randomUUID();
    const replay = after === null ? [] : this.service.eventsAfter(Number(after));
    let unsubscribe: () => void = () => undefined;
    const writer = new SSEWriter(response, () => {
      unsubscribe();
      this.releaseClient(clientID);
    });
    unsubscribe = this.service.onEvent((event) => writer.write(event));
    this.connectClient(clientID);
    initializeSSE(response);
    for (const event of replay) writer.write(event);
    request.once("close", () => writer.close());
  }

  private connectClient(clientID: string): void {
    if (this.closed) return;
    const timer = this.cleanupTimers.get(clientID);
    if (timer) clearTimeout(timer);
    this.cleanupTimers.delete(clientID);
    this.clientStreams.set(clientID, (this.clientStreams.get(clientID) ?? 0) + 1);
  }

  private releaseClient(clientID: string): void {
    if (this.closed) return;
    const remaining = (this.clientStreams.get(clientID) ?? 1) - 1;
    if (remaining > 0) {
      this.clientStreams.set(clientID, remaining);
      return;
    }
    this.clientStreams.delete(clientID);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(clientID);
      if (!this.clientStreams.has(clientID)) this.service.disconnectClient(clientID);
    }, CLIENT_CLEANUP_MS);
    timer.unref();
    this.cleanupTimers.set(clientID, timer);
  }
}

function requiresGateway(message: LinkMessage): boolean {
  return message.type !== "state" && message.type !== "control";
}

function sameNode(left: LinkNode, right: LinkNode): boolean {
  return left.role === right.role && left.id === right.id;
}

function operationID(message: LinkMessage): string {
  if (message.type === "data_request" || message.type === "data_response") return message.request_id;
  if (message.type === "object_content") return message.request_id;
  if (message.type === "control") return message.operation_id;
  if (message.type === "state" && message.operation_id) return message.operation_id;
  return randomUUID().replaceAll("-", "");
}

function isLinkNode(value: unknown): value is LinkNode {
  return (
    isRecord(value) &&
    (value.role === "asset" || value.role === "gateway") &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    !value.id.includes(":")
  );
}

async function readJSONObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_REQUEST_BYTES) throw new RangeError("request body is too large");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(value)) throw new TypeError("request body must be a JSON object");
  return value;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function initializeSSE(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  response.flushHeaders();
}

class SSEWriter {
  private readonly pending: Array<{ data: string; bytes: number }> = [];
  private pendingBytes = 0;
  private waitingForDrain = false;
  private closed = false;

  private readonly onDrain = (): void => {
    this.waitingForDrain = false;
    this.flush();
  };

  private readonly onClose = (): void => {
    this.finish();
  };

  private readonly onError = (): void => {
    this.finish();
  };

  constructor(
    private readonly response: ServerResponse,
    private readonly cleanup: () => void
  ) {
    response.once("close", this.onClose);
    response.once("error", this.onError);
  }

  write(event: PictureEvent | LinkServiceEvent): void {
    if (this.closed) return;
    const data = `id: ${"revision" in event ? event.revision : event.sequence}\ndata: ${JSON.stringify(event)}\n\n`;
    const bytes = Buffer.byteLength(data);
    if (
      this.pending.length >= SSE_MAX_PENDING_EVENTS ||
      (this.pending.length > 0 && this.pendingBytes + bytes > SSE_MAX_PENDING_BYTES)
    ) {
      this.close(new Error("slow Link service event client exceeded its pending event limit"));
      return;
    }
    this.pending.push({ data, bytes });
    this.pendingBytes += bytes;
    this.flush();
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.finish();
    if (reason && !this.response.destroyed && !this.response.writableEnded) this.response.destroy();
  }

  private flush(): void {
    if (this.closed || this.waitingForDrain || this.response.destroyed || this.response.writableEnded) return;
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) continue;
      this.pendingBytes -= next.bytes;
      try {
        if (!this.response.write(next.data)) {
          this.waitingForDrain = true;
          this.response.once("drain", this.onDrain);
          return;
        }
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.response.off("drain", this.onDrain);
    this.response.off("close", this.onClose);
    this.response.off("error", this.onError);
    this.cleanup();
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isCrossOriginMutation(request: IncomingMessage): boolean {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return false;
  return request.headers.origin !== undefined || request.headers["sec-fetch-site"] === "cross-site";
}

function validateTaskAssetID(assetID: string): void {
  if (!assetID.trim() || assetID.includes(":")) throw new TypeError("Task Asset ID is invalid");
}

function validateTaskForAsset(assetID: string, task: TaskResource): void {
  validateTaskAssetID(assetID);
  if (!isTaskResource(task)) throw new TypeError("invalid Task resource");
  if (task.asset_id !== assetID) throw new TypeError("Task asset_id must match the route Asset ID");
}

function isTerminalTask(task: TaskResource): boolean {
  return task.status === "cancelled" || task.status === "completed" || task.status === "failed";
}

function isTaskDelivery(value: unknown): value is "assignment" | "cancellation" {
  return value === "assignment" || value === "cancellation";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isTransportMessageEvent(event: TransportEvent): event is TransportMessageEvent {
  return event.type === "message";
}
