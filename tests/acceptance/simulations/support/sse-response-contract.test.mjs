import assert from "node:assert/strict";
import test from "node:test";

import { parseBrowserRunEventFrame } from "./sse-response-contract.mjs";

const timestamp = "2026-09-14T00:00:00.000Z";
const baseEvent = {
  sequence: 1,
  runId: "run-1",
  timestamp,
  message: "Scenario started",
};

test("parseBrowserRunEventFrame independently validates a status event", () => {
  const event = { ...baseEvent, type: "status", status: "running" };
  assert.deepEqual(
    parseBrowserRunEventFrame(`data: ${JSON.stringify(event)}\n\n`),
    event,
  );
});

test("parseBrowserRunEventFrame rejects malformed run events", () => {
  const malformed = [
    { ...baseEvent, sequence: 0, type: "log" },
    { ...baseEvent, timestamp: "not-a-timestamp", type: "log" },
    { ...baseEvent, timestamp: "2026-09-14T00:00:00Z", type: "log" },
    { ...baseEvent, timestamp: "2026-09-13T20:00:00.000-04:00", type: "log" },
    {
      ...baseEvent,
      type: "resource",
      resource: { type: "unknown", id: "entity-1" },
    },
    { ...baseEvent, type: "error", level: "warn" },
  ];
  for (const event of malformed) {
    assert.throws(
      () =>
        parseBrowserRunEventFrame(`data: ${JSON.stringify(event)}\n\n`),
      /Invalid simulation run event/,
    );
  }
});

test("parseBrowserRunEventFrame rejects event types ignored by onmessage", () => {
  assert.throws(
    () =>
      parseBrowserRunEventFrame(
        `event: status\ndata: ${JSON.stringify({ ...baseEvent, type: "log" })}\n\n`,
      ),
    /EventSource-ignored type/,
  );
});
