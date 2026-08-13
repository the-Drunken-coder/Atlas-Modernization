import type { RunEvent } from "../shared/types.js";
import { errorMessage } from "./http-utils.js";
import { MAX_EVENT_HISTORY_BYTES_PER_RUN, MAX_EVENTS_PER_RUN } from "./run-store-limits.js";

type EventStreamResponse = {
  readonly writableEnded: boolean;
  writeHead(statusCode: number, headers: Record<string, string>): unknown;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): unknown;
  on(event: "close" | "drain", listener: () => void): unknown;
  off(event: "drain", listener: () => void): unknown;
};

type EventStreamStore = {
  get(runId: string): { cleaned: boolean } | undefined;
  subscribe(runId: string, subscriber: (event: RunEvent) => void): () => void;
};

export type EventStream = {
  close(): void;
};

export function streamRunEvents(
  response: EventStreamResponse,
  store: EventStreamStore,
  runId: string,
  eventStreams: Set<EventStream>
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  response.flushHeaders();
  try {
    let unsubscribe: (() => void) | undefined;
    let stream: EventStream | undefined;
    let replaying = true;
    let closeAfterReplay = false;
    let closeScheduled = false;
    let closed = false;
    let waitingForDrain = false;
    let pendingBytes = 0;
    const pendingEvents: Array<{ bytes: number; chunk: string }> = [];
    function removeStream() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (stream) eventStreams.delete(stream);
      response.off("drain", resumePendingEvents);
      pendingEvents.length = 0;
      pendingBytes = 0;
    }
    function close() {
      if (closed) return;
      closed = true;
      removeStream();
      if (!response.writableEnded) response.end();
    }
    stream = { close };
    eventStreams.add(stream);
    function scheduleClose() {
      if (closeScheduled) return;
      closeScheduled = true;
      queueMicrotask(close);
    }
    function writePendingEvents() {
      if (waitingForDrain) return;
      while (pendingEvents.length > 0 && !closeScheduled && !response.writableEnded) {
        const event = pendingEvents.shift()!;
        pendingBytes -= event.bytes;
        const wrote = response.write(event.chunk);
        if (!wrote) {
          waitingForDrain = true;
          return;
        }
      }
      if (!replaying && closeAfterReplay && pendingEvents.length === 0) scheduleClose();
    }
    function resumePendingEvents() {
      waitingForDrain = false;
      writePendingEvents();
    }
    response.on("close", removeStream);
    response.on("drain", resumePendingEvents);
    unsubscribe = store.subscribe(runId, (event) => {
      if (closed || closeScheduled || response.writableEnded) return;
      if (shouldCloseRunEventStream(event, store.get(runId), replaying)) closeAfterReplay = true;
      const data = JSON.stringify(safeStreamEvent(event));
      const bytes = Buffer.byteLength(data, "utf8");
      if (pendingEvents.length >= MAX_EVENTS_PER_RUN || pendingBytes + bytes > MAX_EVENT_HISTORY_BYTES_PER_RUN) {
        close();
        return;
      }
      pendingEvents.push({ bytes, chunk: `id: ${event.sequence}\ndata: ${data}\n\n` });
      pendingBytes += bytes;
      writePendingEvents();
    });
    replaying = false;
    writePendingEvents();
  } catch (error) {
    response.write(`event: error\n`);
    response.write(`data: ${JSON.stringify({ message: errorMessage(error) })}\n\n`);
    response.end();
  }
}

function safeStreamEvent(event: RunEvent): RunEvent {
  if (event.type !== "assertion" || event.assertion.message === undefined) {
    return { ...event, message: errorMessage(event.message) };
  }
  return {
    ...event,
    message: errorMessage(event.message),
    assertion: { ...event.assertion, message: errorMessage(event.assertion.message) }
  };
}

function isTerminalRunEvent(event: RunEvent): boolean {
  return (event.type === "status" && event.status !== "running") || (event.type === "cleanup" && !event.resource);
}

function shouldCloseRunEventStream(
  event: RunEvent,
  run: { cleaned: boolean } | undefined,
  replaying: boolean
): boolean {
  if (!isTerminalRunEvent(event)) return false;
  if (!replaying) return true;
  return event.type === "cleanup" || run?.cleaned === true;
}
