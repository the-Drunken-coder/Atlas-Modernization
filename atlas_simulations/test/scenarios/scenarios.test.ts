import { describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/server/run-store.js";
import { scenarios } from "../../src/server/scenario-registry.js";
import { parseStartRequest } from "../../src/server/scenario.js";
import { numberInput, point } from "../../src/scenarios/helpers.js";
import { createFakeAtlasCore } from "../support/fake-atlas.js";

describe("v1 scenarios", () => {
  it.each(scenarios.map((scenario) => [scenario.id, scenario]))("%s completes against the shared fake Atlas client", async (_id, scenario) => {
    vi.useFakeTimers();
    try {
      const core = createFakeAtlasCore();
      const store = new RunStore(core.factory);
      const parsed = parseStartRequest(scenario, {
        scenarioId: scenario.id,
        inputs: Object.fromEntries(scenario.inputFields.map((field) => [field.key, field.defaultValue])),
        jsonInput: scenario.acceptsJson ? '{"test":"yes"}' : undefined
      });
      const run = store.start(scenario, parsed.input);
      await vi.waitFor(() => expect(store.get(run.id)?.status).toBe("completed"), { timeout: 5000 });
      const assertions = store.get(run.id)?.assertions ?? [];
      expect(assertions.length).toBeGreaterThan(0);
      expect(assertions.every((assertion) => assertion.passed)).toBe(true);
      const beforeCleanup = await core.factory().queries.full();
      expect(beforeCleanup.entities.length + beforeCleanup.tasks.length + beforeCleanup.objects.length).toBeGreaterThan(0);
      const expectedDeletes = new Set((store.get(run.id)?.createdResources ?? []).map((resource) => `${resource.type}:${resource.id}`));

      await expect(store.cleanup(run.id)).resolves.toMatchObject({ cleaned: true });
      const afterCleanup = await core.factory().queries.full();
      expect(afterCleanup).toMatchObject({ entities: [], tasks: [], objects: [] });
      expect(core.state.deleted).toHaveLength(expectedDeletes.size);
      expect(new Set(core.state.deleted)).toEqual(expectedDeletes);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid point coordinates", () => {
    expect(() => point(181, 0)).toThrow("longitude must be between -180 and 180");
    expect(() => point(0, -91)).toThrow("latitude must be between -90 and 90");
  });

  it("rejects non-finite scenario number inputs", () => {
    expect(() => numberInput({ fields: { tickMs: Number.NaN } }, "tickMs")).toThrow("tickMs must be a finite number");
    expect(() => numberInput({ fields: { tickMs: Number.POSITIVE_INFINITY } }, "tickMs")).toThrow("tickMs must be a finite number");
  });
});
