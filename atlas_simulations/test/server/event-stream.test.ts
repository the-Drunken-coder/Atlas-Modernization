import { describe, expect, it, vi } from "vitest";
import { type EventStream, streamRunEvents } from "../../src/server/event-stream.js";
import { jsonNumber, type RunEvent, type RunEventDetails } from "../../src/shared/types.js";

describe("streamRunEvents", () => {
  it("finishes a cleaned-run replay after response backpressure drains", async () => {
    const chunks: string[] = [];
    let firstWrite = true;
    let drain: (() => void) | undefined;
    const end = vi.fn();
    const response = {
      writableEnded: false,
      writeHead: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => {
        chunks.push(chunk);
        if (!firstWrite) return true;
        firstWrite = false;
        return false;
      }),
      end,
      on: vi.fn((event: "close" | "drain", listener: () => void) => {
        if (event === "drain") drain = listener;
      }),
      off: vi.fn()
    };
    const events: RunEvent[] = [
      event(1, { type: "status", status: "completed", message: "Run completed" }),
      event(2, { type: "cleanup", message: "Cleanup complete" })
    ];
    const store = {
      get: () => ({ cleaned: true }),
      subscribe: (_runId: string, subscriber: (runEvent: RunEvent) => void) => {
        for (const runEvent of events) subscriber(runEvent);
        return vi.fn();
      }
    };
    const streams = new Set<EventStream>();

    streamRunEvents(response, store, "run-1", streams);

    expect(response.write).toHaveBeenCalledTimes(1);
    expect(end).not.toHaveBeenCalled();

    drain?.();
    await Promise.resolve();

    expect(response.write).toHaveBeenCalledTimes(2);
    expect(chunks.at(-1)).toContain('"message":"Cleanup complete"');
    expect(end).toHaveBeenCalledOnce();
    expect(streams).toHaveLength(0);
  });
});

function event(sequence: number, details: RunEventDetails): RunEvent {
  return {
    sequence: jsonNumber(sequence),
    runId: "run-1",
    timestamp: "2026-08-13T00:00:00.000Z",
    ...details
  };
}
