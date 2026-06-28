import { describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/server/run-store.js";
import { scenarios } from "../../src/server/scenario-registry.js";
import { parseStartRequest } from "../../src/server/scenario.js";
import { createFakeAtlasCore } from "../support/fake-atlas.js";

describe("v1 scenarios", () => {
  it.each(scenarios.map((scenario) => [scenario.id, scenario]))("%s completes against the shared fake Atlas client", async (_id, scenario) => {
    vi.useFakeTimers();
    try {
      const core = createFakeAtlasCore();
      const store = new RunStore(core.factory);
      const parsed = parseStartRequest(scenario, {
        scenarioId: scenario.id,
        inputs: Object.fromEntries(scenario.inputFields.map((field) => [field.key, field.key === "tickMs" || field.key === "settleMs" ? 0 : field.defaultValue])),
        jsonInput: scenario.acceptsJson ? '{"test":"yes"}' : undefined
      });
      const run = store.start(scenario, parsed.input);
      await vi.waitFor(() => expect(store.get(run.id)?.status).toBe("completed"), { timeout: 5000 });
      expect(store.get(run.id)?.assertions.every((assertion) => assertion.passed)).toBe(true);
      expect(core.state.entities.size + core.state.objects.size + core.state.tasks.size).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
