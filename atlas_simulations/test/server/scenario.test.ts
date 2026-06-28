import { describe, expect, it } from "vitest";
import { parseStartRequest, type Scenario } from "../../src/server/scenario.js";

const scenario: Scenario = {
  id: "example",
  name: "Example",
  summary: "Example scenario",
  acceptsJson: true,
  inputFields: [
    { key: "count", label: "Count", type: "number", defaultValue: 2, min: 1, max: 4, step: 1 },
    { key: "name", label: "Name", type: "text", defaultValue: "alpha" },
    { key: "enabled", label: "Enabled", type: "boolean", defaultValue: false }
  ],
  run: async () => undefined
};

describe("scenario input parsing", () => {
  it("applies defaults and parses JSON input", () => {
    const parsed = parseStartRequest(scenario, {
      scenarioId: "example",
      inputs: { enabled: true },
      jsonInput: '{"note":"ok"}'
    });
    expect(parsed.input.fields).toEqual({ count: 2, name: "alpha", enabled: true });
    expect(parsed.input.json).toEqual({ note: "ok" });
  });

  it("rejects numeric input outside field bounds", () => {
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { count: 9 } })).toThrow("Count must be at most 4");
  });

  it("rejects blank numeric input before coercion", () => {
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { count: " " } })).toThrow("Count is required");
  });

  it("rejects string numeric input instead of coercing it", () => {
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { count: "2" } })).toThrow("Count must be a number");
  });

  it("rejects numeric input that does not align to the field step", () => {
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { count: 2.5 } })).toThrow("Count must align to step 1");
  });

  it("rejects string boolean input instead of coercing it", () => {
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { enabled: "true" } })).toThrow("Enabled must be a boolean");
  });
});
