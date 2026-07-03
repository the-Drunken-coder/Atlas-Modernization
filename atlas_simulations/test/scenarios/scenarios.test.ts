import { describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/server/run-store.js";
import { scenarios } from "../../src/server/scenario-registry.js";
import { parseStartRequest } from "../../src/server/scenario.js";
import { boundedNumberInput, boundedPositiveIntegerInput, numberInput, point } from "../../src/scenarios/helpers.js";
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
      await vi.waitFor(() => {
        const current = store.get(run.id);
        expect(["completed", "failed"]).toContain(current?.status);
      }, { timeout: 5000 });
      const current = store.get(run.id);
      expect(current?.status, current?.lastError).toBe("completed");
      const assertions = current?.assertions ?? [];
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

  it.each(scenarios.map((scenario) => [scenario.id, scenario]))("%s can run twice before cleanup", async (_id, scenario) => {
    vi.useFakeTimers();
    try {
      const core = createFakeAtlasCore();
      const store = new RunStore(core.factory);
      const start = () => store.start(scenario, parseStartRequest(scenario, defaultStartRequest(scenario)).input);
      const first = start();
      await vi.waitFor(() => expect(store.get(first.id)?.status).toBe("completed"), { timeout: 5000 });
      const second = start();
      await vi.waitFor(() => expect(store.get(second.id)?.status).toBe("completed"), { timeout: 5000 });

      expect(store.get(first.id)?.assertions.every((assertion) => assertion.passed)).toBe(true);
      expect(store.get(second.id)?.assertions.every((assertion) => assertion.passed)).toBe(true);
      await expect(store.cleanup(first.id)).resolves.toMatchObject({ cleaned: true });
      await expect(store.cleanup(second.id)).resolves.toMatchObject({ cleaned: true });
      await expect(core.factory().queries.full()).resolves.toMatchObject({ entities: [], tasks: [], objects: [] });
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

  it("rejects scenario number inputs outside runtime bounds", () => {
    expect(() => boundedNumberInput({ fields: { tickMs: -1 } }, "tickMs", 0, 10000)).toThrow("tickMs must be between 0 and 10000");
    expect(() => boundedNumberInput({ fields: { startLatitude: 91 } }, "startLatitude", -90, 90)).toThrow("startLatitude must be between -90 and 90");
    expect(() => boundedPositiveIntegerInput({ fields: { assetCount: 26 } }, "assetCount", 25)).toThrow("assetCount must be <= 25");
  });
});

function defaultStartRequest(scenario: (typeof scenarios)[number]) {
  return {
    scenarioId: scenario.id,
    inputs: Object.fromEntries(scenario.inputFields.map((field) => [field.key, field.defaultValue])),
    jsonInput: scenario.acceptsJson ? '{"test":"yes"}' : undefined
  };
}
