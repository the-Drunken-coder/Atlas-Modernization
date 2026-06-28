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
      expect(store.get(started.id)).toMatchObject({ status: "completed", cleaned: true });
      expect(core.state.deleted).toEqual([`task:${started.id}-task`, `entity:${started.id}-asset`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports cancelled status after a stopped run unwinds", async () => {
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

    expect(stopped.status).toBe("running");
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("cancelled"));
    expect(store.get(started.id)?.finishedAt).toBeDefined();
  });

  it("marks the run failed when a scenario records a failed assertion", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "failed-assertion",
      name: "Failed assertion",
      summary: "Records a failed assertion",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        ctx.assert("expected convergence", false, "not converged");
      }
    };

    const started = store.start(scenario, { fields: {} });

    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("failed"));
    expect(store.get(started.id)?.lastError).toBe("Run completed with failed assertions");
  });

  it("marks the run failed when sync teardown fails", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore((options) => {
      const client = core.factory(options);
      return { ...client, sync: { ...client.sync, stop: () => { throw new Error("stop failed"); } } };
    });
    const scenario: Scenario = {
      id: "teardown-failure",
      name: "Teardown failure",
      summary: "Fails during client cleanup",
      acceptsJson: false,
      inputFields: [],
      async run() {
        return undefined;
      }
    };

    const started = store.start(scenario, { fields: {} });

    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("failed"));
    expect(store.get(started.id)?.lastError).toContain("Failed to stop client sync");
  });

  it("returns snapshots for summaries and events", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "snapshot-run",
      name: "Snapshot run",
      summary: "Checks snapshot isolation",
      acceptsJson: true,
      inputFields: [],
      async run(ctx) {
        await ctx.createEntity({ entity_id: ctx.id("asset"), entity_type: "asset" });
        ctx.assert("created", true);
      }
    };

    const started = store.start(scenario, { fields: {}, json: { nested: { value: "original" } } });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));

    const summary = store.get(started.id);
    expect(summary).toBeDefined();
    summary!.createdResources.push({ type: "entity", id: "mutated" });
    summary!.assertions[0]!.passed = false;
    (summary!.jsonInput as { nested: { value: string } }).nested.value = "mutated";

    const event = store.events(started.id)[0];
    event.message = "mutated";

    expect(store.get(started.id)?.createdResources).toHaveLength(1);
    expect(store.get(started.id)?.assertions[0]?.passed).toBe(true);
    expect(store.get(started.id)?.jsonInput).toEqual({ nested: { value: "original" } });
    expect(store.events(started.id)[0]?.message).not.toBe("mutated");
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
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    store.stop(started.id);

    await expect(store.cleanup(started.id)).rejects.toThrow("Wait for the run to finish before cleanup");
    release();
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("cancelled"));
    await expect(store.cleanup(started.id)).resolves.toMatchObject({ status: "cancelled", cleaned: true });
  });

  it("retries when a generated run ID collides with an existing run", () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const random = vi.spyOn(Math, "random").mockReturnValueOnce(0.123456).mockReturnValueOnce(0.123456).mockReturnValueOnce(0.654321);
    const scenario: Scenario = {
      id: "id-collision",
      name: "ID collision",
      summary: "Completes immediately",
      acceptsJson: false,
      inputFields: [],
      async run() {
        return undefined;
      }
    };

    try {
      const first = store.start(scenario, { fields: {} });
      const second = store.start(scenario, { fields: {} });

      expect(second.id).not.toBe(first.id);
      expect(store.get(first.id)).toBeDefined();
      expect(store.get(second.id)).toBeDefined();
    } finally {
      random.mockRestore();
      dateNow.mockRestore();
    }
  });

  it("shares concurrent cleanup calls for a run", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "concurrent-cleanup",
      name: "Concurrent cleanup",
      summary: "Creates one resource",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        await ctx.createEntity({ entity_id: ctx.id("asset"), entity_type: "asset" });
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));
    await Promise.all([store.cleanup(started.id), store.cleanup(started.id)]);

    expect(core.state.deleted).toEqual([`entity:${started.id}-asset`]);
  });

  it("evicts cleaned runs before refusing new runs at capacity", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "capacity",
      name: "Capacity",
      summary: "Completes immediately",
      acceptsJson: false,
      inputFields: [],
      async run() {
        return undefined;
      }
    };
    const runs = Array.from({ length: 100 }, () => store.start(scenario, { fields: {} }));
    await vi.waitFor(() => expect(store.get(runs[0]!.id)?.status).toBe("completed"));
    await store.cleanup(runs[0]!.id);

    const extra = store.start(scenario, { fields: {} });

    expect(store.get(runs[0]!.id)).toBeUndefined();
    expect(store.get(extra.id)).toBeDefined();
  });

  it("trims old events from long runs", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "event-cap",
      name: "Event cap",
      summary: "Emits many events",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        for (let index = 0; index < 510; index += 1) {
          ctx.log(`event ${index}`);
        }
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));
    const events = store.events(started.id);

    expect(events).toHaveLength(500);
    expect(events[0]!.sequence).toBeGreaterThan(1);
    expect(events.at(-1)?.message).toBe("Run completed");
  });
});
