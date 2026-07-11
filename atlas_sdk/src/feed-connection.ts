import { ATLAS_PROTOCOL_REVISION, type FeedEvent } from "./protocol.js";
import { subscriptionMessage } from "./subscriptions.js";
import type { AtlasSubscription, WebSocketCtor, WebSocketEventType, WebSocketLike, WebSocketListener } from "./types.js";
import { isInboundFeedEvent, isInboundFeedHandshake } from "./validation.js";

const WS_OPEN = 1;
const WS_CLOSED = 3;

type ActiveFeedConnection = {
  socket: WebSocketLike;
  controller: AbortController;
};

export type FeedConnectOptions = {
  subscriptions: AtlasSubscription[];
  onEvent(event: FeedEvent): void | Promise<void>;
  onEventError(): void;
  onClose(): void;
};

export class ProtocolMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(`Atlas protocol revision mismatch: SDK ${expected}, Core ${actual}`);
    this.name = "ProtocolMismatchError";
  }
}

export class FeedConnectionManager {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly WebSocketImpl?: WebSocketCtor;
  private readonly feedHandshakeTimeoutMs: number;
  private socket: WebSocketLike | undefined;
  private connection: ActiveFeedConnection | undefined;

  constructor(options: { baseUrl: string; apiKey?: string; WebSocketImpl?: WebSocketCtor; feedHandshakeTimeoutMs: number }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.WebSocketImpl = options.WebSocketImpl;
    this.feedHandshakeTimeoutMs = options.feedHandshakeTimeoutMs;
  }

  get available(): boolean {
    return this.WebSocketImpl !== undefined;
  }

  get connected(): boolean {
    return this.socket?.readyState === WS_OPEN;
  }

  async connect(options: FeedConnectOptions): Promise<void> {
    if (!this.WebSocketImpl) {
      throw new Error("AtlasClient requires a WebSocket implementation");
    }
    const socket = new this.WebSocketImpl(feedUrl(this.baseUrl));
    const previousConnection = this.connection;
    const previousSocket = this.socket;
    const connection: ActiveFeedConnection = { socket, controller: new AbortController() };
    this.connection = connection;
    this.socket = undefined;
    previousConnection?.controller.abort();
    if (previousConnection && previousConnection.socket.readyState !== WS_CLOSED) {
      previousConnection.socket.close();
    }
    if (previousSocket && previousSocket !== previousConnection?.socket && previousSocket.readyState !== WS_CLOSED) {
      previousSocket.close();
    }

    const ensureCurrent = () => {
      if (this.connection !== connection || connection.controller.signal.aborted) {
        throw new Error("feed connection was replaced");
      }
    };
    const startupCleanups: Array<() => void> = [];
    const onStartup = (type: WebSocketEventType, listener: WebSocketListener) => {
      socket.addEventListener(type, listener);
      startupCleanups.push(() => removeSocketListener(socket, type, listener));
    };
    const onAbort = (listener: () => void) => {
      connection.controller.signal.addEventListener("abort", listener, { once: true });
      startupCleanups.push(() => connection.controller.signal.removeEventListener("abort", listener));
    };
    const cleanupStartup = () => {
      for (const cleanup of startupCleanups.splice(0)) {
        cleanup();
      }
    };
    const hello = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error("feed protocol hello timed out"))), this.feedHandshakeTimeoutMs);
      const onMessage: WebSocketListener = (message) => {
        if (settled) {
          return;
        }
        try {
          const data: unknown = JSON.parse(String(message.data));
          if (!isInboundFeedHandshake(data)) {
            finish(() => reject(new TypeError("feed did not send a valid protocol hello")));
            return;
          }
          assertRevision(data.protocol_revision);
          finish(resolve);
        } catch (error) {
          finish(() => reject(error));
        }
      };
      const onClose = () => finish(() => reject(new Error("feed websocket closed before protocol hello")));
      const onError = () => finish(() => reject(new Error("feed websocket failed before protocol hello")));
      const abortHello = () => finish(() => reject(new Error("feed connection was replaced")));
      onStartup("message", onMessage);
      onStartup("close", onClose);
      onStartup("error", onError);
      onAbort(abortHello);
    });
    void hello.catch(() => undefined);

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          fn();
        };
        const timer = setTimeout(() => finish(() => reject(new Error("feed websocket open timed out"))), this.feedHandshakeTimeoutMs);
        const onOpen = () => finish(resolve);
        const onClose = () => finish(() => reject(new Error("feed websocket closed before opening")));
        const onError = () => finish(() => reject(new Error("feed websocket failed to open")));
        const abortOpen = () => finish(() => reject(new Error("feed connection was replaced")));
        onStartup("open", onOpen);
        onStartup("close", onClose);
        onStartup("error", onError);
        onAbort(abortOpen);
      });
      ensureCurrent();
      if (this.apiKey) {
        socket.send(JSON.stringify({ action: "auth", api_key: this.apiKey }));
      }
      await hello;
      ensureCurrent();
      cleanupStartup();
    } catch (error) {
      cleanupStartup();
      if (this.connection === connection) {
        this.connection = undefined;
      }
      socket.close();
      throw error;
    }

    ensureCurrent();
    this.socket = socket;
    const reportEventError = () => {
      try {
        options.onEventError();
      } catch {
        // The feed manager should not let an error callback poison ordered delivery.
      }
    };
    for (const filter of options.subscriptions) {
      socket.send(JSON.stringify(subscriptionMessage("subscribe", filter)));
    }
    let eventChain = Promise.resolve();
    socket.addEventListener("message", (message) => {
      if (this.connection !== connection || this.socket !== socket) {
        return;
      }
      try {
        const data: unknown = JSON.parse(String(message.data));
        if (isInboundFeedHandshake(data)) {
          assertRevision(data.protocol_revision);
          return;
        }
        if (!isInboundFeedEvent(data)) {
          throw new TypeError("feed sent an invalid event");
        }
        eventChain = eventChain.then(async () => {
          try {
            await options.onEvent(data);
          } catch {
            reportEventError();
          }
        });
      } catch {
        reportEventError();
        socket.close();
      }
    });
    socket.addEventListener("close", () => {
      if (this.connection !== connection) {
        return;
      }
      this.connection = undefined;
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      try {
        options.onClose();
      } catch {
        // Close notifications should not make the underlying socket dispatch throw.
      }
    });
  }

  sendSubscription(action: "subscribe" | "unsubscribe", filter: AtlasSubscription): void {
    this.socket?.send(JSON.stringify(subscriptionMessage(action, filter)));
  }

  close(): void {
    const connection = this.connection;
    this.connection = undefined;
    connection?.controller.abort();
    const socket = this.socket ?? connection?.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WS_CLOSED) {
      socket.close();
    }
  }
}

export function assertRevision(actual: string): void {
  if (actual !== ATLAS_PROTOCOL_REVISION) {
    throw new ProtocolMismatchError(ATLAS_PROTOCOL_REVISION, actual);
  }
}

function removeSocketListener(socket: WebSocketLike, type: WebSocketEventType, listener: WebSocketListener): void {
  if (socket.removeEventListener) {
    socket.removeEventListener(type, listener);
    return;
  }
  if (socket.off) {
    socket.off(type, listener);
    return;
  }
  if (socket.removeListener) {
    socket.removeListener(type, listener);
    return;
  }
  if (shouldWarnForSocketCleanup()) {
    console.warn(`AtlasClient could not remove ${type} websocket startup listener`);
  }
}

function shouldWarnForSocketCleanup(): boolean {
  if (typeof process === "undefined") return true;
  return process.env?.NODE_ENV !== "production";
}

function feedUrl(baseUrl: string): string {
  return baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/feed";
}
