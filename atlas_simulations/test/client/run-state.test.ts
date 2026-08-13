import { describe, expect, it } from "vitest";
import { buildStartRunRequest, parseRunEvent } from "../../src/client/run-state.js";
import { type AtlasTargetSummary, jsonNumber, type ScenarioDescriptor } from "../../src/shared/types.js";

const scenario: ScenarioDescriptor = {
  id: "sync-entity",
  name: "Sync entity",
  summary: "Synchronizes an entity",
  acceptsJson: true,
  inputFields: [
    { key: "entityId", label: "Entity ID", type: "text", defaultValue: "entity-1" },
    { key: "attempts", label: "Attempts", type: "number", defaultValue: jsonNumber(1), min: jsonNumber(1) }
  ]
};

const target: AtlasTargetSummary = {
  id: "deployed-core",
  label: "Deployed Core",
  baseUrl: "https://atlas.example",
  deployed: true,
  apiKeyConfigured: true
};

describe("buildStartRunRequest", () => {
  it("builds the complete request after validating inputs", () => {
    expect(
      buildStartRunRequest(scenario, target, { entityId: "entity-2", attempts: "3" }, '{"mode":"fast"}', true)
    ).toEqual({
      scenarioId: "sync-entity",
      targetId: "deployed-core",
      confirmDeployedMutation: true,
      inputs: { entityId: "entity-2", attempts: 3 },
      jsonInput: '{"mode":"fast"}'
    });
  });

  it("requires explicit confirmation for a deployed mutation", () => {
    expect(() => buildStartRunRequest(scenario, target, {}, "", false)).toThrow(
      "Confirm the deployed mutation before starting the run"
    );
  });

  it("rejects invalid JSON before a run is submitted", () => {
    expect(() => buildStartRunRequest(scenario, target, {}, "{", true)).toThrow("JSON input must be valid JSON");
  });
});

describe("parseRunEvent", () => {
  const timestamp = "2026-08-12T12:00:00.000Z";
  const base = { sequence: 1, runId: "run-1", timestamp, message: "event" };

  it("constructs every valid event variant", () => {
    expect(parseRunEvent({ ...base, type: "status", status: "completed" })).toMatchObject({ type: "status" });
    expect(parseRunEvent({ ...base, type: "log", level: "warn", data: { nested: [1, true, null] } })).toMatchObject({
      type: "log",
      level: "warn"
    });
    expect(
      parseRunEvent({
        ...base,
        type: "assertion",
        assertion: { id: "assertion-1", name: "passes", passed: true, timestamp }
      })
    ).toMatchObject({ type: "assertion" });
    expect(parseRunEvent({ ...base, type: "resource", resource: { type: "entity", id: "entity-1" } })).toMatchObject({
      type: "resource"
    });
    expect(parseRunEvent({ ...base, type: "error", level: "error" })).toMatchObject({ type: "error" });
    expect(parseRunEvent({ ...base, type: "cleanup" })).toMatchObject({ type: "cleanup" });
  });

  it("rejects invalid optional levels, JSON data, and timestamps", () => {
    expect(() => parseRunEvent({ ...base, type: "status", status: "completed", level: "debug" })).toThrow(
      "Invalid run event"
    );
    expect(() => parseRunEvent({ ...base, type: "log", data: { invalid: Number.POSITIVE_INFINITY } })).toThrow(
      "Invalid run event"
    );
    expect(() => parseRunEvent({ ...base, type: "log", data: new Date(timestamp) })).toThrow("Invalid run event");
    expect(() =>
      parseRunEvent({
        ...base,
        type: "assertion",
        assertion: { id: "assertion-1", name: "passes", passed: true, timestamp: "not-a-date" }
      })
    ).toThrow("Invalid run event");
    for (const nonCanonicalTimestamp of ["2026-08-12", "June 1, 2026", "08/12/2026", "2026-08-12T12:00:00Z"]) {
      expect(() => parseRunEvent({ ...base, timestamp: nonCanonicalTimestamp, type: "log" })).toThrow(
        "Invalid run event"
      );
      expect(() =>
        parseRunEvent({
          ...base,
          type: "assertion",
          assertion: {
            id: "assertion-1",
            name: "passes",
            passed: true,
            timestamp: nonCanonicalTimestamp
          }
        })
      ).toThrow("Invalid run event");
    }
  });

  it("rejects malformed branch data without accepting a partial event", () => {
    expect(() => parseRunEvent({ ...base, type: "status", status: "unknown" })).toThrow("Invalid run event");
    expect(() => parseRunEvent({ ...base, type: "resource", resource: { type: "entity" } })).toThrow(
      "Invalid run event"
    );
    expect(() => parseRunEvent({ ...base, type: "error", level: "warn" })).toThrow("Invalid run event");
  });
});
