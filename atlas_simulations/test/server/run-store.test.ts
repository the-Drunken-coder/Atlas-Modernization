import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AtlasClientFactory } from "../../src/server/atlas.js";
import { CleanupLedger, type CleanupLedgerStore } from "../../src/server/cleanup-ledger.js";
import { RunStore, type RunTarget } from "../../src/server/run-store.js";
import type { Scenario, ScenarioInput } from "../../src/server/scenario.js";
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
          await ctx.createTask({ asset_id: ctx.id("asset"), command: "fixture.queued", input: { value: "run" } });
          ctx.assert("created", true, "resources tracked");
        }
      };

      const started = store.start(scenario, { fields: {} });
      await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));
      expect(store.get(started.id)?.createdResources).toHaveLength(2);
      expect(store.get(started.id)?.assertions[0]?.passed).toBe(true);
      const resources = store.get(started.id)?.createdResources ?? [];

      await store.cleanup(started.id);
      expect(store.get(started.id)).toMatchObject({ status: "completed", cleaned: true });
      expect(core.state.deleted).toEqual([`entity:${resources.find((resource) => resource.type === "entity")?.id}`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clean up an external resource after a non-run create ID is rejected", async () => {
    const core = createFakeAtlasCore();
    const writer = core.factory();
    await writer.entities.create({ entity_id: "external-asset", entity_type: "asset" });
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "external-id",
      name: "External ID",
      summary: "Attempts to create an existing non-run resource",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        await ctx.createEntity({ entity_id: "external-asset", entity_type: "asset" });
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("failed"));

    expect(store.get(started.id)?.lastError).toContain("entity ID must start with run ID prefix");
    expect(store.get(started.id)?.createdResources).toEqual([]);
    await expect(store.cleanup(started.id)).resolves.toMatchObject({ cleaned: true });
    await expect(writer.entities.get("external-asset")).resolves.toMatchObject({ entity_id: "external-asset" });
    expect(core.state.deleted).toEqual([]);
  });

  it("cleans up hidden create candidates after response failure", async () => {
    const core = createFakeAtlasCore();
    let firstClient = true;
    const store = new RunStore((options) => {
      const client = core.factory(options);
      if (!firstClient) return client;
      firstClient = false;
      return {
        ...client,
        entities: {
          ...client.entities,
          create: async (entity) => {
            await client.entities.create(entity);
            throw new Error("response failed");
          }
        }
      };
    });
    let entityId = "";
    const scenario: Scenario = {
      id: "response-failure-cleanup",
      name: "Response failure cleanup",
      summary: "Cleans up a create whose response failed after persistence",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        entityId = ctx.id("asset");
        await ctx.createEntity({ entity_id: entityId, entity_type: "asset" });
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("failed"));

    expect(store.get(started.id)?.createdResources).toEqual([]);
    await expect(core.factory().entities.get(entityId)).resolves.toMatchObject({ entity_id: entityId });
    await expect(store.cleanup(started.id)).resolves.toMatchObject({ cleaned: true });
    expect(core.state.deleted).toEqual([`entity:${entityId}`]);
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

    expect(stopped.status).toBe("cancelled");
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("cancelled"));
    expect(store.get(started.id)?.finishedAt).toBeDefined();
  });

  it("preserves stop event ordering and ignores callbacks after settlement", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    let lateCallback!: () => void;
    let lateAssertion: { id: string; name: string } | undefined;
    const scenario: Scenario = {
      id: "late-callbacks",
      name: "Late callbacks",
      summary: "Stops before delayed callbacks run",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        lateCallback = () => {
          ctx.log("late log");
          lateAssertion = ctx.assert("late assertion", true);
          ctx.track({ type: "entity", id: ctx.id("late") });
        };
        await ctx.wait(60_000);
      }
    };

    const started = store.start(scenario, { fields: {} });
    const eventOrder: string[] = [];
    store.subscribe(started.id, (event) =>
      eventOrder.push(event.type === "status" ? `${event.type}:${event.status}` : `${event.type}:${event.message}`)
    );
    store.stop(started.id);
    await store.cleanup(started.id);

    expect(eventOrder).toEqual(["status:running", "log:Stop requested", "status:cancelled"]);
    lateCallback();
    expect(lateAssertion).toMatchObject({ id: "assert-late", name: "late assertion" });
    expect(store.get(started.id)?.assertions).toEqual([]);
    expect(store.get(started.id)?.createdResources).toEqual([]);
    expect(store.events(started.id).some((event) => event.message === "late log")).toBe(false);
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

  it("fails runs that exceed the assertion history byte cap", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "assertion-byte-cap",
      name: "Assertion byte cap",
      summary: "Records oversized assertion history",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        for (let index = 0; index < 40; index += 1) {
          ctx.assert("x".repeat(8_100), true, "y".repeat(8_100));
        }
      }
    };

    const started = store.start(scenario, { fields: {} });

    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("failed"));
    expect(store.get(started.id)?.lastError).toContain("assertion history");
    expect(store.get(started.id)!.assertions.length).toBeLessThan(40);
  });

  it("marks the run failed when sync teardown fails", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore((options) => {
      const client = core.factory(options);
      return {
        ...client,
        sync: {
          ...client.sync,
          stop: () => {
            throw new Error("stop failed");
          }
        }
      };
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

    const summary = store.get(started.id)!;
    summary.createdResources.push({ type: "entity", id: "mutated" });
    summary.assertions[0]!.passed = false;
    (summary.jsonInput as { nested: { value: string } }).nested.value = "mutated";

    const event = store.events(started.id)[0]!;
    event.message = "mutated";

    expect(store.get(started.id)?.createdResources).toHaveLength(1);
    expect(store.get(started.id)?.assertions[0]?.passed).toBe(true);
    expect(store.get(started.id)?.jsonInput).toEqual({ nested: { value: "original" } });
    expect(store.events(started.id)[0]?.message).not.toBe("mutated");
  });

  it("isolates running scenarios from later input mutations", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    let release!: () => void;
    let observedInput: ScenarioInput | undefined;
    const scenario: Scenario = {
      id: "input-isolation",
      name: "Input isolation",
      summary: "Reads inputs after start returns",
      acceptsJson: true,
      inputFields: [],
      async run(_ctx, input) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        observedInput = input;
      }
    };
    const input: ScenarioInput = { fields: { name: "original" }, json: { nested: { value: "original" } } };

    const started = store.start(scenario, input);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    input.fields.name = "mutated";
    (input.json as { nested: { value: string } }).nested.value = "mutated";
    release();

    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));
    expect(observedInput).toEqual({ fields: { name: "original" }, json: { nested: { value: "original" } } });
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

    const cleanup = store.cleanup(started.id);
    release();
    await expect(cleanup).resolves.toMatchObject({ status: "cancelled", cleaned: true });
  });

  it("retries when a generated run ID collides with an existing run", () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const random = vi
      .spyOn(Math, "random")
      .mockReturnValueOnce(0.123456)
      .mockReturnValueOnce(0.123456)
      .mockReturnValueOnce(0.654321);
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
    let cleanupStopCalls = 0;
    const store = new RunStore((options) => {
      const client = core.factory(options);
      return {
        ...client,
        sync: {
          ...client.sync,
          stop: () => {
            cleanupStopCalls += 1;
            client.sync.stop();
          }
        }
      };
    });
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
    cleanupStopCalls = 0;
    await Promise.all([store.cleanup(started.id), store.cleanup(started.id)]);

    expect(cleanupStopCalls).toBe(1);
    expect(core.state.deleted).toEqual([`entity:${store.get(started.id)?.createdResources[0]?.id}`]);
  });

  it("keeps cleanup retryable after a post-delete sync teardown failure", async () => {
    const core = createFakeAtlasCore();
    let factoryCalls = 0;
    let cleanupStopCalls = 0;
    const store = new RunStore((options) => {
      factoryCalls += 1;
      const client = core.factory(options);
      if (factoryCalls < 2) return client;
      return {
        ...client,
        sync: {
          ...client.sync,
          stop: () => {
            cleanupStopCalls += 1;
            if (cleanupStopCalls === 1) throw new Error("cleanup stop failed");
            client.sync.stop();
          }
        }
      };
    });
    const scenario: Scenario = {
      id: "cleanup-stop-failure",
      name: "Cleanup stop failure",
      summary: "Creates one resource",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        await ctx.createEntity({ entity_id: ctx.id("asset"), entity_type: "asset" });
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));

    await expect(store.cleanup(started.id)).rejects.toThrow("cleanup stop failed");
    expect(cleanupStopCalls).toBe(1);
    expect(store.get(started.id)).toMatchObject({ cleaned: false, lastError: "cleanup stop failed" });
    expect(
      store.events(started.id).filter((event) => event.type === "error" && event.message === "cleanup stop failed")
    ).toHaveLength(1);
    const deletedAfterFailure = [...core.state.deleted];

    await expect(store.cleanup(started.id)).resolves.toMatchObject({ cleaned: true });
    expect(cleanupStopCalls).toBe(2);
    expect(core.state.deleted).toEqual(deletedAfterFailure);
    expect(
      store.events(started.id).filter((event) => event.type === "error" && event.message === "cleanup stop failed")
    ).toHaveLength(1);
  });

  it("fails cleanup when a resource delete times out", async () => {
    vi.useFakeTimers();
    try {
      const core = createFakeAtlasCore();
      const store = new RunStore((options) => {
        const client = core.factory(options);
        return {
          ...client,
          entities: {
            ...client.entities,
            delete: async () => new Promise<void>(() => undefined)
          }
        };
      });
      const scenario: Scenario = {
        id: "cleanup-timeout",
        name: "Cleanup timeout",
        summary: "Creates one resource",
        acceptsJson: false,
        inputFields: [],
        async run(ctx) {
          await ctx.createEntity({ entity_id: ctx.id("asset"), entity_type: "asset" });
        }
      };

      const started = store.start(scenario, { fields: {} });
      await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));

      const cleanupPromise = expect(store.cleanup(started.id)).rejects.toThrow("Timed out deleting entity");
      await vi.advanceTimersByTimeAsync(10_000);

      await cleanupPromise;
      expect(store.get(started.id)).toMatchObject({ cleaned: false });
      expect(store.get(started.id)?.lastError).toContain("Timed out deleting entity");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats already-deleted cleanup resources as successful", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario = createOneEntityScenario();
    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));
    const resource = store.get(started.id)?.createdResources[0]!;

    await core.factory().entities.delete(resource.id);
    await expect(store.cleanup(started.id)).resolves.toMatchObject({ cleaned: true });
    expect(store.events(started.id)).toContainEqual(
      expect.objectContaining({
        type: "cleanup",
        message: `${resource.type} ${resource.id} was already gone`
      })
    );
  });

  it("does not mark unsupported cleanup resource types as deleted", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "unsupported-cleanup",
      name: "Unsupported cleanup",
      summary: "Tracks an unsupported resource type",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        ctx.track({ type: "track", id: ctx.id("track") } as unknown as Parameters<typeof ctx.track>[0]);
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));

    await expect(store.cleanup(started.id)).rejects.toThrow("Unsupported cleanup resource type: track");
    expect(store.get(started.id)).toMatchObject({
      cleaned: false,
      lastError: "Unsupported cleanup resource type: track"
    });
    expect(
      store.events(started.id).some((event) => event.type === "cleanup" && event.message.includes("Deleted track"))
    ).toBe(false);
  });

  it("keeps the overflowing cleanup resource when resource tracking exceeds its cap", async () => {
    const core = createFakeAtlasCore();
    const deleted: string[] = [];
    const store = new RunStore((options) => {
      const client = core.factory(options);
      return {
        ...client,
        entities: {
          ...client.entities,
          delete: async (id: string) => {
            deleted.push(id);
          }
        }
      };
    });
    const scenario: Scenario = {
      id: "cleanup-resource-cap",
      name: "Cleanup resource cap",
      summary: "Tracks many cleanup resources",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        for (let index = 0; index < 1_005; index += 1) {
          ctx.track({ type: "entity", id: ctx.id(`asset-${index}`) });
        }
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("failed"));
    expect(store.get(started.id)?.lastError).toBe("Simulation can track at most 1000 created resources");
    expect(store.get(started.id)?.createdResources).toHaveLength(1_000);

    await expect(store.cleanup(started.id)).resolves.toMatchObject({ cleaned: true });
    expect(deleted).toHaveLength(1_001);
  });

  it("does not retain repeated cleanup resource overflows", async () => {
    const core = createFakeAtlasCore();
    const deleted: string[] = [];
    const store = new RunStore((options) => {
      const client = core.factory(options);
      return {
        ...client,
        entities: {
          ...client.entities,
          delete: async (id: string) => {
            deleted.push(id);
          }
        }
      };
    });
    const scenario: Scenario = {
      id: "repeated-cleanup-resource-cap",
      name: "Repeated cleanup resource cap",
      summary: "Keeps trying after cleanup tracking overflows",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        for (let index = 0; index < 1_005; index += 1) {
          try {
            ctx.track({ type: "entity", id: ctx.id(`asset-${index}`) });
          } catch {
            // Keep exercising the guard after the first overflow.
          }
        }
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("failed"));
    expect(store.get(started.id)?.lastError).toBe("Simulation can track at most 1000 created resources");
    expect(store.get(started.id)?.createdResources).toHaveLength(1_000);

    await expect(store.cleanup(started.id)).resolves.toMatchObject({ cleaned: true });
    expect(deleted).toHaveLength(1_001);
  });

  it("cleans resources by dependency type and newest-to-oldest within a type", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "cleanup-order",
      name: "Cleanup order",
      summary: "Creates mixed resources",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        const entityId = ctx.id("asset");
        await ctx.createEntity({ entity_id: entityId, entity_type: "asset" });
        await ctx.createObject({ object_id: ctx.id("object-1") });
        await ctx.createObject({ object_id: ctx.id("object-2") });
        await ctx.createTask({ asset_id: entityId, command: "fixture.queued", input: { value: "run" } });
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));
    const resources = store.get(started.id)?.createdResources ?? [];
    const entity = resources.find((resource) => resource.type === "entity");
    const objects = resources.filter((resource) => resource.type === "object");
    await store.cleanup(started.id);

    expect(core.state.deleted).toEqual([
      `object:${objects[1]?.id}`,
      `object:${objects[0]?.id}`,
      `entity:${entity?.id}`
    ]);
  });

  it("fake sync clients read the revision visible at their sync version", async () => {
    const core = createFakeAtlasCore();
    const writer = core.factory();
    const reader = core.factory({ sync: "all" });

    await writer.entities.create({ entity_id: "asset-1", entity_type: "asset", alias: "old" });
    await reader.sync.start();
    await writer.entities.update("asset-1", { alias: "new" });

    expect((await reader.entities.get("asset-1")).alias).toBe("old");
    await reader.sync.status();
    expect((await reader.entities.get("asset-1")).alias).toBe("new");
  });

  it("fake sync writers immediately see their own mutations", async () => {
    const core = createFakeAtlasCore();
    const writer = core.factory({ sync: "all" });
    await writer.sync.start();

    await writer.entities.create({ entity_id: "asset-1", entity_type: "asset", alias: "created" });
    expect((await writer.entities.get("asset-1")).alias).toBe("created");
    await writer.entities.update("asset-1", { alias: "updated" });
    expect((await writer.entities.get("asset-1")).alias).toBe("updated");
    await writer.entities.delete("asset-1");
    await expect(writer.entities.get("asset-1")).rejects.toMatchObject({ status: 404 });
  });

  it("fake sync deletion snapshots stay deleted after resource recreation", async () => {
    const core = createFakeAtlasCore();
    const writer = core.factory();

    await writer.entities.create({ entity_id: "asset-1", entity_type: "asset", alias: "old" });
    await writer.entities.delete("asset-1");
    const deletedSnapshot = core.factory({ sync: "all" });
    await deletedSnapshot.sync.start();
    await writer.entities.create({ entity_id: "asset-1", entity_type: "asset", alias: "new" });

    await expect(deletedSnapshot.entities.get("asset-1")).rejects.toMatchObject({ status: 404 });
    expect((await writer.entities.get("asset-1")).alias).toBe("new");
  });

  it("fake core rejects duplicate creates until a resource is deleted", async () => {
    const core = createFakeAtlasCore();
    const client = core.factory();

    await client.entities.create({ entity_id: "asset-1", entity_type: "asset" });
    await expect(client.entities.create({ entity_id: "asset-1", entity_type: "asset" })).rejects.toMatchObject({
      status: 409
    });
    await client.entities.delete("asset-1");
    await expect(client.entities.create({ entity_id: "asset-1", entity_type: "asset" })).resolves.toMatchObject({
      entity_id: "asset-1"
    });
  });

  it("fake core rejects duplicate active entity aliases", async () => {
    const core = createFakeAtlasCore();
    const client = core.factory();

    await client.entities.create({ entity_id: "asset-1", entity_type: "asset", alias: " Shared alias " });
    expect((await client.entities.get("asset-1")).alias).toBe("Shared alias");
    await expect(
      client.entities.create({ entity_id: "asset-2", entity_type: "asset", alias: "Shared alias" })
    ).rejects.toMatchObject({ status: 409 });
    await client.entities.update("asset-1", { alias: " Updated alias " });
    expect((await client.entities.get("asset-1")).alias).toBe("Updated alias");
    await expect(
      client.entities.create({ entity_id: "asset-2", entity_type: "asset", alias: "Updated alias" })
    ).rejects.toMatchObject({ status: 409 });
    await client.entities.delete("asset-1");
    await expect(
      client.entities.create({ entity_id: "asset-2", entity_type: "asset", alias: "Updated alias" })
    ).resolves.toMatchObject({
      entity_id: "asset-2"
    });
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
    await vi.waitFor(() => expect(store.get(runs[50]!.id)?.status).toBe("completed"));
    await store.cleanup(runs[50]!.id);

    const extra = store.start(scenario, { fields: {} });

    expect(store.get(runs[0]!.id)).toBeDefined();
    expect(store.get(runs[50]!.id)).toBeUndefined();
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

  it("keeps the terminal status event when cleanup events trim history", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "cleanup-event-cap",
      name: "Cleanup event cap",
      summary: "Creates enough resources to trim cleanup events",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        for (let index = 0; index < 510; index += 1) {
          await ctx.createObject({ object_id: ctx.id(`object-${index}`) });
        }
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));
    await expect(store.cleanup(started.id)).resolves.toMatchObject({ cleaned: true });
    const events = store.events(started.id);

    expect(events).toHaveLength(500);
    expect(events.some((event) => event.type === "status" && event.status === "completed")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "cleanup", message: "Cleanup complete" });
  });

  it("keeps subscribers added after completion until cleanup finishes", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "terminal-subscribe",
      name: "Terminal subscribe",
      summary: "Creates a cleanup target",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        await ctx.createObject({ object_id: ctx.id("object") });
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));
    const replayed: string[] = [];
    store.subscribe(started.id, (event) => replayed.push(event.message));
    await store.cleanup(started.id);

    expect(replayed).toContain("Cleanup complete");
  });

  it("clears live subscribers after terminal status", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "terminal-live-subscribe",
      name: "Terminal live subscribe",
      summary: "Creates a cleanup target after a short wait",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        await ctx.createObject({ object_id: ctx.id("object") });
        await ctx.wait(20);
      }
    };

    const started = store.start(scenario, { fields: {} });
    const messages: string[] = [];
    store.subscribe(started.id, (event) => messages.push(event.message));
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));
    await store.cleanup(started.id);

    expect(messages).toContain("Run completed");
    expect(messages).not.toContain("Cleanup complete");
  });

  it("rejects overly deep structured event data before storing the log event", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "deep-event-data",
      name: "Deep event data",
      summary: "Emits nested data",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        ctx.log("too deep", JSON.parse(`${"[".repeat(202)}null${"]".repeat(202)}`));
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("failed"));

    expect(store.get(started.id)?.lastError).toBe("Run event data must be nested at most 200 levels");
    expect(store.events(started.id).some((event) => event.type === "log" && event.message === "too deep")).toBe(false);
  });

  it("rejects event data with too many structured values before storing the log event", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "wide-event-data",
      name: "Wide event data",
      summary: "Emits wide data",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        ctx.log(
          "too wide",
          Array.from({ length: 10_001 }, () => null)
        );
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("failed"));

    expect(store.get(started.id)?.lastError).toBe("Run event data must contain at most 10000 values");
    expect(store.events(started.id).some((event) => event.type === "log" && event.message === "too wide")).toBe(false);
  });

  it("rejects oversized event data before storing the log event", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "oversized-event-data",
      name: "Oversized event data",
      summary: "Emits oversized data",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        ctx.log("too large", "x".repeat(200_001));
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("failed"));

    expect(store.get(started.id)?.lastError).toBe("Run event data strings must total at most 200000 bytes");
    expect(store.events(started.id).some((event) => event.type === "log" && event.message === "too large")).toBe(false);
  });

  it("truncates oversized event messages before storing them", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    const scenario: Scenario = {
      id: "oversized-event-message",
      name: "Oversized event message",
      summary: "Emits an oversized message",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        ctx.log("x".repeat(200_001));
      }
    };

    const started = store.start(scenario, { fields: {} });
    await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));
    const logEvent = store
      .events(started.id)
      .find((event) => event.type === "log" && event.message.endsWith("...[truncated]"));

    expect(logEvent).toBeDefined();
    expect(Buffer.byteLength(logEvent!.message, "utf8")).toBeLessThanOrEqual(200_000);
  });

  it("persists deployed cleanup candidates before sending create requests", async () => {
    const { directory, ledger } = temporaryLedger();
    try {
      const core = createFakeAtlasCore();
      let resourcesObservedByCore: Array<{ type: string; id: string }> | undefined;
      const factory: AtlasClientFactory = (options) => {
        const client = core.factory(options);
        return {
          ...client,
          entities: {
            ...client.entities,
            create: async (entity) => {
              resourcesObservedByCore = ledger.load()[0]?.resources;
              return client.entities.create(entity);
            }
          }
        };
      };
      const store = new RunStore(factory, { ledger });
      const scenario = createOneEntityScenario();

      const started = store.start(scenario, { fields: {} }, deployedTarget(factory));
      await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));

      expect(resourcesObservedByCore).toEqual([{ type: "entity", id: expect.stringMatching(`${started.id}-`) }]);
      expect(ledger.load()[0]?.resources).toEqual(resourcesObservedByCore);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back a deployed run when initial ledger persistence fails", () => {
    const ledger: CleanupLedgerStore = {
      load: () => [],
      save: () => {
        throw new Error("ledger write failed");
      },
      remove: () => undefined
    };
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory, { ledger });

    expect(() => store.start(createOneEntityScenario(), { fields: {} }, deployedTarget(core.factory))).toThrow(
      "ledger write failed"
    );
    expect(store.list()).toEqual([]);
  });

  it("recovers deployed runs as abandoned and retains their ledger until cleanup succeeds", async () => {
    const { directory, ledger } = temporaryLedger();
    try {
      const core = createFakeAtlasCore();
      const original = new RunStore(core.factory, { ledger });
      const started = original.start(createOneEntityScenario(), { fields: {} }, deployedTarget(core.factory));
      await vi.waitFor(() => expect(original.get(started.id)?.status).toBe("completed"));
      const resource = ledger.load()[0]?.resources[0];

      expect(
        () =>
          new RunStore(core.factory, {
            ledger,
            resolveTarget: (target) =>
              deployedTarget(core.factory, { ...target, baseUrl: "https://other.example.test" })
          })
      ).toThrow(`Cleanup ledger run ${started.id} no longer matches its deployed target`);

      const recovered = new RunStore(core.factory, {
        ledger: new CleanupLedger(path.join(directory, "state", "runs")),
        resolveTarget: (target) => deployedTarget(core.factory, target)
      });

      expect(recovered.get(started.id)).toMatchObject({
        status: "abandoned",
        cleaned: false,
        createdResources: [resource],
        lastError: expect.stringContaining("restarted before explicit cleanup")
      });
      expect(recovered.events(started.id)).toEqual([
        expect.objectContaining({ type: "status", status: "abandoned", level: "warn" })
      ]);

      const failingCleanupFactory: AtlasClientFactory = (options) => {
        const client = core.factory(options);
        return {
          ...client,
          entities: {
            ...client.entities,
            delete: async () => {
              throw new Error("cleanup unavailable");
            }
          }
        };
      };
      await expect(recovered.cleanup(started.id, failingCleanupFactory)).rejects.toThrow("cleanup unavailable");
      expect(new CleanupLedger(path.join(directory, "state", "runs")).load()).toHaveLength(1);

      await expect(recovered.cleanup(started.id, core.factory)).resolves.toMatchObject({
        status: "abandoned",
        cleaned: true
      });
      expect(new CleanupLedger(path.join(directory, "state", "runs")).load()).toEqual([]);
      expect(core.state.deleted).toEqual([`entity:${resource?.id}`]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps local runs out of the deployed cleanup ledger", async () => {
    const { directory, ledger } = temporaryLedger();
    try {
      const core = createFakeAtlasCore();
      const store = new RunStore(core.factory, { ledger });
      const started = store.start(createOneEntityScenario(), { fields: {} }, localTarget(core.factory));
      await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));

      expect(ledger.load()).toEqual([]);
      await expect(store.cleanup(started.id)).resolves.toMatchObject({ cleaned: true });
      expect(ledger.load()).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains deployed Tasks outside the cleanup ledger", async () => {
    const { directory, ledger } = temporaryLedger();
    try {
      const core = createFakeAtlasCore();
      const store = new RunStore(core.factory, { ledger });
      const scenario: Scenario = {
        id: "generated-deployed-task",
        name: "Generated deployed task",
        summary: "Retains Task execution history",
        acceptsJson: false,
        inputFields: [],
        async run(ctx) {
          await ctx.createTask({
            asset_id: ctx.id("asset"),
            command: "fixture.queued",
            input: { value: "deployed" }
          });
        }
      };

      const started = store.start(scenario, { fields: {} }, deployedTarget(core.factory));
      await vi.waitFor(() => expect(store.get(started.id)?.status).toBe("completed"));

      expect(store.get(started.id)?.createdResources).toEqual([
        expect.objectContaining({ type: "task", id: expect.stringMatching(/^task-/) })
      ]);
      expect(core.state.tasks.size).toBe(1);
      expect(ledger.load()[0]?.resources).toEqual([]);
      await expect(store.cleanup(started.id)).resolves.toMatchObject({ cleaned: true });
      expect(core.state.tasks.size).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function createOneEntityScenario(): Scenario {
  return {
    id: "durable-entity",
    name: "Durable entity",
    summary: "Creates one cleanup target",
    acceptsJson: false,
    inputFields: [],
    async run(ctx) {
      await ctx.createEntity({ entity_id: ctx.id("asset"), entity_type: "asset" });
    }
  };
}

function deployedTarget(
  clientFactory: AtlasClientFactory,
  target: { id: string; label: string; baseUrl: string } = {
    id: "deployed",
    label: "Deployed Core",
    baseUrl: "https://atlas.example.test"
  }
): RunTarget {
  return { ...target, deployed: true, apiKeyConfigured: false, clientFactory };
}

function localTarget(clientFactory: AtlasClientFactory): RunTarget {
  return {
    id: "local",
    label: "Local Core",
    baseUrl: "http://127.0.0.1:8000",
    deployed: false,
    apiKeyConfigured: false,
    clientFactory
  };
}

function temporaryLedger(): { directory: string; ledger: CleanupLedger } {
  const directory = mkdtempSync(path.join(tmpdir(), "atlas-simulations-run-store-"));
  return { directory, ledger: new CleanupLedger(path.join(directory, "state", "runs")) };
}
