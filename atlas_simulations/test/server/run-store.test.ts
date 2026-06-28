import { describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/server/run-store.js";
import type { Scenario } from "../../src/server/scenario.js";
import { createFakeAtlasCore } from "../support/fake-atlas.js";

describe("RunStore", () => {
  it("runs a scenario, records resources and assertions, and cleans up explicitly", async () => {
    vi.useFakeTimers();
    try {
      const core = createFakeAtlasCore();
      const store = new RunStore(core.factory);
      const scenario: Scenario = {
        id: "store-test",
        name: "Store test",
        summary: "Stores run state",
        acceptsJson: false,
        inputFields: [],
        async run(ctx) {
          await ctx.createEntity({ entity_id: ctx.id("asset"), entity_type: "asset" });
          await ctx.createTask({ task_id: ctx.id("task"), entity_id: ctx.id("asset") });
          ctx.assert("created", true, "resources tracked");
        }
      };

      const started = store.start(scenario, { fields: {} });
      await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));
      expect(store.get(started.id)?.createdResources).toHaveLength(2);
      expect(store.get(started.id)?.assertions[0]?.passed).toBe(true);

      await store.cleanup(started.id);
      expect(store.get(started.id)?.status).toBe("cleaned");
      expect(core.state.deleted).toEqual([`task:${started.id}-task`, `entity:${started.id}-asset`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports cancelled status immediately when a run is stopped", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "slow-run",
      name: "Slow run",
      summary: "Waits until stopped",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        await ctx.wait(60_000);
      }
    };

    const started = store.start(scenario, { fields: {} });
    const stopped = store.stop(started.id);

    expect(stopped.status).toBe("cancelled");
    expect(stopped.finishedAt).toBeDefined();
    expect(store.get(started.id)?.status).toBe("cancelled");
  });

  it("keeps cleanup blocked until a cancelled scenario has unwound", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    let release!: () => void;
    const scenario: Scenario = {
      id: "blocked-cleanup",
      name: "Blocked cleanup",
      summary: "Does not unwind immediately",
      acceptsJson: false,
      inputFields: [],
      async run() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };

    const started = store.start(scenario, { fields: {} });
    store.stop(started.id);

    await expect(store.cleanup(started.id)).rejects.toThrow("Wait for the run to finish before cleanup");
    release();
    await vi.waitFor(() => expect(store.cleanup(started.id)).resolves.toMatchObject({ status: "cleaned" }));
  });
});
