import type { ServerResponse } from "node:http";
import type { RunEvent } from "../shared/types.js";
import { errorMessage } from "./http-utils.js";
import type { RunStore } from "./run-store.js";

export type EventStream = {
  response: ServerResponse;
  close(): void;
};

export function streamRunEvents(
  response: ServerResponse,
  store: RunStore,
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
    let dropFurtherEvents = false;
    const removeStream = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (stream) eventStreams.delete(stream);
    };
    const close = () => {
      removeStream();
      if (!response.writableEnded) response.end();
    };
    stream = { response, close };
    eventStreams.add(stream);
    const scheduleClose = () => {
      if (closeScheduled) return;
      closeScheduled = true;
      queueMicrotask(close);
    };
    const closeAfterCurrentReplay = () => {
      closeAfterReplay = true;
      if (!replaying && unsubscribe) scheduleClose();
    };
    response.on("close", removeStream);
    unsubscribe = store.subscribe(runId, (event) => {
      if (dropFurtherEvents || closeScheduled || response.writableEnded) return;
      const wrote = response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(safeStreamEvent(event))}\n\n`);
      if (!wrote) {
        dropFurtherEvents = true;
        closeAfterCurrentReplay();
        return;
      }
      if (shouldCloseRunEventStream(event, store.get(runId), replaying)) closeAfterCurrentReplay();
    });
    replaying = false;
    if (closeAfterReplay) scheduleClose();
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
