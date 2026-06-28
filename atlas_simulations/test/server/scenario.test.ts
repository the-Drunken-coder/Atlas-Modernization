import { describe, expect, it } from "vitest";
import { createScenarioContext, parseStartRequest, type Scenario } from "../../src/server/scenario.js";
import { jsonNumber } from "../../src/shared/types.js";
import { createFakeAtlasCore } from "../support/fake-atlas.js";

const scenario: Scenario = {
  id: "example",
  name: "Example",
  summary: "Example scenario",
  acceptsJson: true,
  inputFields: [
    { key: "count", label: "Count", type: "number", defaultValue: jsonNumber(2), min: jsonNumber(1), max: jsonNumber(4), step: jsonNumber(1) },
    { key: "name", label: "Name", type: "text", defaultValue: "alpha" },
    { key: "enabled", label: "Enabled", type: "boolean", defaultValue: false }
  ],
  run: async () => undefined
};

describe("scenario input parsing", () => {
  it("rejects malformed start request shapes", () => {
    expect(() => parseStartRequest(scenario, null)).toThrow("Start request must be a JSON object");
    expect(() => parseStartRequest(scenario, { scenarioId: 12 })).toThrow("scenarioId is required");
    expect(() => parseStartRequest(scenario, { scenarioId: "other" })).toThrow("scenarioId must be example");
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: null })).toThrow("inputs must be a JSON object");
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: [] })).toThrow("inputs must be a JSON object");
    expect(() => parseStartRequest(scenario, { scenarioId: "example", jsonInput: 12 })).toThrow("jsonInput must be a string");
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: {}, typo: true })).toThrow("Unknown start request field: typo");
  });

  it("applies defaults and parses JSON input", () => {
    const parsed = parseStartRequest(scenario, {
      scenarioId: "example",
      inputs: { enabled: true },
      jsonInput: '{"note":"ok"}'
    });
    expect(parsed.input.fields).toEqual({ count: 2, name: "alpha", enabled: true });
    expect(parsed.input.json).toEqual({ note: "ok" });
  });

  it("rejects malformed JSON input", () => {
    expect(() => parseStartRequest(scenario, { scenarioId: "example", jsonInput: "{" })).toThrow("jsonInput must be valid JSON");
  });

  it("rejects overly deep JSON input", () => {
    const deepJson = `${"[".repeat(202)}null${"]".repeat(202)}`;

    expect(() => parseStartRequest(scenario, { scenarioId: "example", jsonInput: deepJson })).toThrow("JSON input must be nested at most 200 levels");
  });

  it("rejects oversized JSON input before parsing", () => {
    const largeJson = JSON.stringify("x".repeat(200_000));
    const multibyteJson = JSON.stringify("é".repeat(100_000));

    expect(() => parseStartRequest(scenario, { scenarioId: "example", jsonInput: largeJson })).toThrow("JSON input must be at most 200000 bytes");
    expect(() => parseStartRequest(scenario, { scenarioId: "example", jsonInput: `${" ".repeat(200_001)}{}` })).toThrow("JSON input must be at most 200000 bytes");
    expect(multibyteJson.length).toBeLessThan(200_000);
    expect(() => parseStartRequest(scenario, { scenarioId: "example", jsonInput: multibyteJson })).toThrow("JSON input must be at most 200000 bytes");
  });

  it("rejects JSON input with too many values", () => {
    const wideJson = JSON.stringify(Array.from({ length: 10_001 }, () => null));

    expect(() => parseStartRequest(scenario, { scenarioId: "example", jsonInput: wideJson })).toThrow("JSON input must contain at most 10000 values");
  });

  it("rejects numeric input outside field bounds", () => {
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { count: 9 } })).toThrow("Count must be at most 4");
  });

  it("rejects blank numeric input before coercion", () => {
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { count: " " } })).toThrow("Count is required");
  });

  it("parses non-blank string numeric input", () => {
    const parsed = parseStartRequest(scenario, { scenarioId: "example", inputs: { count: "2" } });

    expect(parsed.input.fields.count).toBe(2);
  });

  it("rejects numeric input that does not align to the field step", () => {
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { count: 2.5 } })).toThrow("Count must align to step 1");
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { count: "0x2" } })).toThrow("Count must be a number");
  });

  it("rejects string boolean input instead of coercing it", () => {
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { enabled: "true" } })).toThrow("Enabled must be a boolean");
  });

  it("rejects non-string text input instead of coercing it", () => {
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { name: 12 } })).toThrow("Name must be a string");
  });

  it("rejects unknown input fields", () => {
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { count: 2, unknown: true } })).toThrow("Unknown input field: unknown");
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { count: 2, "": true } })).toThrow("Unknown input field: ");
  });

  it("rejects JSON input for scenarios that do not accept it", () => {
    expect(() => parseStartRequest({ ...scenario, acceptsJson: false }, { scenarioId: "example", jsonInput: '{"nope":true}' })).toThrow(
      "Example does not accept JSON input"
    );
  });

  it("keeps generated resource IDs unique after slug and hash collisions", () => {
    const ctx = createScenarioContext({
      runId: "sim-collision",
      signal: new AbortController().signal,
      clientFactory: createFakeAtlasCore().factory,
      log: () => undefined,
      assert: (name, passed, message) => ({ id: name, name, passed, message, timestamp: new Date().toISOString() }),
      track: () => undefined,
      registerClient: () => undefined
    });

    const direct = ctx.id("a-b-212u");
    const base = ctx.id("a b");
    const hashed = ctx.id("a-b");

    expect(new Set([direct, base, hashed]).size).toBe(3);
    expect(hashed).not.toBe(direct);
    expect(hashed).not.toBe(base);
    expect(hashed).toMatch(/^sim-collision-a-b-/);
    expect(ctx.id("a-b")).toBe(hashed);
  });

  it("tracks resources created through exposed clients", async () => {
    const tracked: Array<{ type: string; id: string }> = [];
    const ctx = createScenarioContext({
      runId: "sim-track",
      signal: new AbortController().signal,
      clientFactory: createFakeAtlasCore().factory,
      log: () => undefined,
      assert: (name, passed, message) => ({ id: name, name, passed, message, timestamp: new Date().toISOString() }),
      track: (resource) => tracked.push(resource),
      registerClient: () => undefined
    });

    const entityId = ctx.id("asset");
    const objectId = ctx.id("object");
    await ctx.client.entities.create({ entity_id: entityId, entity_type: "asset" });
    await ctx.newClient().objects.create({ object_id: objectId });

    expect(tracked).toEqual([
      { type: "entity", id: entityId },
      { type: "object", id: objectId }
    ]);
  });

  it("blocks exposed client operations after cancellation", async () => {
    const controller = new AbortController();
    const ctx = createScenarioContext({
      runId: "sim-cancelled",
      signal: controller.signal,
      clientFactory: createFakeAtlasCore().factory,
      log: () => undefined,
      assert: (name, passed, message) => ({ id: name, name, passed, message, timestamp: new Date().toISOString() }),
      track: () => undefined,
      registerClient: () => undefined
    });

    controller.abort();

    await expect(ctx.client.entities.get("missing")).rejects.toThrow("Simulation cancelled");
    expect(() => ctx.client.sync.status()).toThrow("Simulation cancelled");
  });

  it("unsubscribes watches after cancellation", () => {
    const controller = new AbortController();
    let unsubscribed = 0;
    const ctx = createScenarioContext({
      runId: "sim-watch-cancelled",
      signal: controller.signal,
      clientFactory: () => ({
        ...createFakeAtlasCore().factory(),
        watch: () => () => {
          unsubscribed += 1;
        }
      }),
      log: () => undefined,
      assert: (name, passed, message) => ({ id: name, name, passed, message, timestamp: new Date().toISOString() }),
      track: () => undefined,
      registerClient: () => undefined
    });
    const stop = ctx.client.watch({ filter: "all" } as Parameters<typeof ctx.client.watch>[0], () => undefined);

    controller.abort();
    stop();

    expect(unsubscribed).toBe(1);
  });

  it("rejects invalid wait durations", async () => {
    const ctx = createScenarioContext({
      runId: "sim-wait",
      signal: new AbortController().signal,
      clientFactory: createFakeAtlasCore().factory,
      log: () => undefined,
      assert: (name, passed, message) => ({ id: name, name, passed, message, timestamp: new Date().toISOString() }),
      track: () => undefined,
      registerClient: () => undefined
    });

    await expect(ctx.wait(-1)).rejects.toThrow("Wait duration must be between 0 and 2147483647 milliseconds");
    await expect(ctx.wait(Number.POSITIVE_INFINITY)).rejects.toThrow("Wait duration must be between 0 and 2147483647 milliseconds");
  });
});
