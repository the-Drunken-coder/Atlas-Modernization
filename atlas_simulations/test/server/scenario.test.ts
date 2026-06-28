import { describe, expect, it } from "vitest";
import { parseStartRequest, type Scenario } from "../../src/server/scenario.js";

const scenario: Scenario = {
  id: "example",
  name: "Example",
  summary: "Example scenario",
  acceptsJson: true,
  inputFields: [
    { key: "count", label: "Count", type: "number", defaultValue: 2, min: 1, max: 4 },
    { key: "name", label: "Name", type: "text", defaultValue: "alpha" },
    { key: "enabled", label: "Enabled", type: "boolean", defaultValue: false }
  ],
  run: async () => undefined
};

describe("scenario input parsing", () => {
  it("applies defaults and parses JSON input", () => {
    const parsed = parseStartRequest(scenario, {
      scenarioId: "example",
      inputs: { enabled: "true" },
      jsonInput: '{"note":"ok"}'
    });
    expect(parsed.input.fields).toEqual({ count: 2, name: "alpha", enabled: true });
    expect(parsed.input.json).toEqual({ note: "ok" });
  });

  it("rejects numeric input outside field bounds", () => {
    expect(() => parseStartRequest(scenario, { scenarioId: "example", inputs: { count: 9 } })).toThrow("Count must be at most 4");
  });
});
