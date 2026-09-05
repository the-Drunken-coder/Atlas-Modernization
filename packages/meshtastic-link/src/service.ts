import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Clock, TimerHandle } from "./clock.js";
import { isFeedSelector, isLinkMessage } from "./contract.js";
import type { AssetJoinStatus } from "./joining.js";
import { PictureCursorError, type PictureEvent, type PictureSnapshot, SharedPicture } from "./picture.js";
import { type RadioProfile, type RadioProfileManager, validateRadioProfile } from "./profile.js";
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

type LinkServiceEventInput =
  | { type: "transport"; event: TransportEvent }
  | { type: "status"; status: LinkServiceStatus };

export type LinkServiceOptions = {
  mode: LinkRole;
  nodeID: string;
  clock: Clock;
  picture?: SharedPicture;
  profileManager?: RadioProfileManager;
  gatewayNode?: LinkNode;
  onGatewaySubscriptionTransition?: (transition: SubscriptionTransition) => void;
};

export class LinkService {
  readonly picture: SharedPicture;
  readonly node: LinkNode;
  readonly serviceSession = randomBytes(12).toString("base64url");
  private readonly clock: Clock;
  private readonly profileManager: RadioProfileManager | undefined;
  private readonly subscriptions = new LocalSubscriptionDemand();
  private readonly eventListeners = new Set<(event: LinkServiceEvent) => void>();
  private readonly eventBuffer: LinkServiceEvent[] = [];
  private readonly localOperations = new Map<string, LinkOperationResult>();
  private readonly clientLeaseTimers = new Map<string, TimerHandle>();
  private transport: LinkTransport | undefined;
  private unsubscribeTransport: (() => void) | undefined;
  private gatewayNode: LinkNode | undefined;
  private lifecycle: LinkLifecycle = "configuring";
  private statusDetail: string | undefined;
  private joiningStatus: AssetJoinStatus | undefined;
  private eventSequence = 0;
  private renewalTimer: TimerHandle | undefined;
  private pictureRefreshTimer: TimerHandle | undefined;

  constructor(private readonly options: LinkServiceOptions) {
    if (!options.nodeID || options.nodeID.includes(":")) throw new TypeError("Link node ID is invalid");
    this.clock = options.clock;
    this.picture = options.picture ?? new SharedPicture(this.serviceSession);
    this.node = { role: options.mode, id: options.nodeID };
    this.profileManager = options.profileManager;
    this.gatewayNode = options.gatewayNode;
    this.schedulePictureRefresh();
  }

  attachTransport(transport: LinkTransport, gatewayNode?: LinkNode): void {
    if (this.transport) throw new Error("Link transport is already attached");
    if (transport.node.role !== this.node.role || transport.node.id !== this.node.id) {
      throw new Error("Link transport identity does not match the service");
    }
    this.transport = transport;
    if (gatewayNode) this.gatewayNode = gatewayNode;
    this.unsubscribeTransport = transport.onEvent((event) => this.handleTransportEvent(event));
    this.setLifecycle("active");
    for (const selector of this.subscriptions.aggregate().values()) this.dispatchSubscription("add", selector);
    this.scheduleRenewalIfNeeded();
  }

  setLifecycle(lifecycle: LinkLifecycle, detail?: string): void {
    if (this.lifecycle === "stopped") return;
    if (this.lifecycle === "error" && lifecycle !== "error" && lifecycle !== "stopped") return;
    this.lifecycle = lifecycle;
    this.statusDetail = detail;
    this.emit({ type: "status", status: this.status() });
  }

  setJoiningStatus(status: AssetJoinStatus): void {
    this.joiningStatus = status;
  }

  status(): LinkServiceStatus {
    const snapshot = this.snapshot();
    return {
      mode: this.options.mode,
      node: this.node,
      lifecycle: this.lifecycle,
      service_session: this.serviceSession,
      gateway_available:
        this.options.mode === "gateway" || (this.transport !== undefined && this.gatewayNode !== undefined),
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

  submit(message: LinkMessage, destination?: LinkNode, operationIDValue?: string): LinkOperationResult {
    if (!isLinkMessage(message)) throw new TypeError("invalid Radio contract message");
    const stableOperationID = operationIDValue ?? operationID(message);
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

  async radioStatus(): Promise<unknown> {
    if (!this.profileManager) return { available: false };
    return { available: true, ...(await this.profileManager.inspect()) };
  }

  async applyRadioProfile(): Promise<unknown> {
    if (!this.profileManager) throw new Error("Radio profile management is unavailable");
    return this.profileManager.apply();
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
    this.unsubscribeTransport?.();
    this.setLifecycle("stopped");
    this.eventListeners.clear();
  }

  private defaultDestination(message: LinkMessage): LinkNode | undefined {
    if (message.type === "state") return undefined;
    if (this.node.role === "asset") return this.gatewayNode;
    return undefined;
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
    if (event.type === "link_error") this.setLifecycle("error", event.reason);
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
      } catch {
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
        error instanceof PictureCursorError ||
          error instanceof TypeError ||
          error instanceof SyntaxError ||
          error instanceof RangeError
          ? 400
          : 500,
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  private streamPicture(url: URL, request: IncomingMessage, response: ServerResponse): void {
    const session = url.searchParams.get("session") ?? "";
    const revision = Number(url.searchParams.get("after"));
    const subscription = this.service.picture.subscribeAfter(session, revision, (event) => sendSSE(response, event));
    initializeSSE(response);
    for (const event of subscription.replay) sendSSE(response, event);
    request.once("close", subscription.unsubscribe);
  }

  private streamEvents(url: URL, request: IncomingMessage, response: ServerResponse): void {
    const after = url.searchParams.get("after");
    const clientID = url.searchParams.get("client_id") ?? randomUUID();
    const replay = after === null ? [] : this.service.eventsAfter(Number(after));
    initializeSSE(response);
    for (const event of replay) sendSSE(response, event);
    const unsubscribe = this.service.onEvent((event) => sendSSE(response, event));
    this.connectClient(clientID);
    request.once("close", () => {
      unsubscribe();
      this.releaseClient(clientID);
    });
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

function sendSSE(response: ServerResponse, event: PictureEvent | LinkServiceEvent): void {
  if (
    !response.destroyed &&
    !response.write(`id: ${"revision" in event ? event.revision : event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
  ) {
    response.destroy(new Error("slow Link service event client exceeded its response buffer"));
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isCrossOriginMutation(request: IncomingMessage): boolean {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return false;
  return request.headers.origin !== undefined || request.headers["sec-fetch-site"] === "cross-site";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isTransportMessageEvent(event: TransportEvent): event is TransportMessageEvent {
  return event.type === "message";
}
