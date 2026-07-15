import { describe, expect, it, vi } from "vitest";
import type { AtlasClient, AtlasWatchEvent, EntityResource, ObjectDetailResource, ObjectResource, ResourceType, TaskResource } from "../src";
import { createTwoClientFeedHarness, type TwoClientFeedHarness } from "./support/two-client-feed-harness.js";

type ResourceValue = EntityResource | TaskResource | ObjectResource;
type UpsertCase<TResource extends ResourceValue> = {
  name: string;
  resource_type: ResourceType;
  id: string;
  watch(receiver: AtlasClient, callback: (value: TResource | undefined, event: AtlasWatchEvent) => void): void;
  create(writer: AtlasClient): Promise<TResource>;
  update(writer: AtlasClient): Promise<TResource>;
  expectedFeedResource(value: TResource): ResourceValue;
  assertRead(harness: TwoClientFeedHarness, value: TResource): Promise<void>;
};

describe("two-client feed harness", () => {
  for (const scenario of upsertCases()) {
    it(`delivers writer ${scenario.name} creates to a receiving SDK within one second`, async () => {
      const harness = createTwoClientFeedHarness();
      const { core, writer, receiver, stop } = harness;
      const watch = vi.fn();
      scenario.watch(receiver, watch);

      try {
        await receiver.sync.start();
        core.requests = [];

        const written = await scenario.create(writer);

        await expectWatch(watch, scenario.expectedFeedResource(written), {
          event: "create",
          id: scenario.id,
          resource_type: scenario.resource_type,
          version: written.metadata.version
        });
        await scenario.assertRead(harness, written);
      } finally {
        stop();
      }
    });

    it(`delivers writer ${scenario.name} updates to a receiving SDK within one second`, async () => {
      const harness = createTwoClientFeedHarness();
      const { core, writer, receiver, stop } = harness;
      const watch = vi.fn();
      scenario.watch(receiver, watch);

      try {
        await receiver.sync.start();
        await scenario.create(writer);
        await vi.waitFor(() => expect(watch).toHaveBeenCalled(), { timeout: 1_000 });
        watch.mockClear();
        core.requests = [];

        const updated = await scenario.update(writer);

        await expectWatch(watch, scenario.expectedFeedResource(updated), {
          event: "update",
          id: scenario.id,
          resource_type: scenario.resource_type,
          version: updated.metadata.version
        });
        await scenario.assertRead(harness, updated);
      } finally {
        stop();
      }
    });

    it(`delivers writer ${scenario.name} deletes to a receiving SDK within one second`, async () => {
      const harness = createTwoClientFeedHarness();
      const { core, writer, receiver, stop } = harness;
      const watch = vi.fn();
      scenario.watch(receiver, watch);

      try {
        await receiver.sync.start();
        await scenario.create(writer);
        await vi.waitFor(() => expect(watch).toHaveBeenCalled(), { timeout: 1_000 });
        watch.mockClear();
        core.requests = [];

        await deleteResource(writer, scenario.resource_type, scenario.id);
        const deletion = core.deletions.at(-1);
        expect(deletion).toEqual(expect.objectContaining({ id: scenario.id, resource_type: scenario.resource_type }));

        await vi.waitFor(
          () => {
            expect(watch).toHaveBeenCalledWith(undefined, deletion);
          },
          { timeout: 1_000 }
        );
      } finally {
        stop();
      }
    });
  }

  it("delivers writer task lifecycle updates to a receiving SDK within one second", async () => {
    const { core, writer, receiver, stop } = createTwoClientFeedHarness();
    const taskID = "task-two-client-lifecycle-feed";
    const watch = vi.fn();
    receiver.tasks.watch(taskID, watch);

    try {
      await receiver.sync.start();
      await writer.tasks.create({ task_id: taskID, status: "pending" });
      await vi.waitFor(() => expect(watch).toHaveBeenCalled(), { timeout: 1_000 });
      watch.mockClear();
      core.requests = [];

      const acknowledged = await writer.tasks.acknowledge(taskID);

      await expectWatch(watch, acknowledged, {
        event: "update",
        id: taskID,
        resource_type: "task",
        version: acknowledged.metadata.version
      });
      const taskReads = core.requests.filter((request) => request === `/tasks/${taskID}`).length;
      await expect(receiver.tasks.get(taskID)).resolves.toEqual(acknowledged);
      expect(core.requests.filter((request) => request === `/tasks/${taskID}`)).toHaveLength(taskReads);
    } finally {
      stop();
    }
  });
});

function upsertCases(): Array<UpsertCase<EntityResource> | UpsertCase<TaskResource> | UpsertCase<ObjectDetailResource>> {
  return [
    {
      name: "entity",
      resource_type: "entity",
      id: "asset-two-client-feed",
      watch: (receiver, callback) => receiver.entities.watch("asset-two-client-feed", callback),
      create: (writer) => writer.entities.create({ entity_id: "asset-two-client-feed", entity_type: "asset", alias: "created" }),
      update: (writer) => writer.entities.update("asset-two-client-feed", { alias: "updated" }),
      expectedFeedResource: (value) => value,
      assertRead: async ({ core, receiver }, value) => {
        const entityReads = core.requests.filter((request) => request === "/entities/asset-two-client-feed").length;
        await expect(receiver.entities.get("asset-two-client-feed")).resolves.toEqual(value);
        expect(core.requests.filter((request) => request === "/entities/asset-two-client-feed")).toHaveLength(entityReads);
      }
    },
    {
      name: "task",
      resource_type: "task",
      id: "task-two-client-feed",
      watch: (receiver, callback) => receiver.tasks.watch("task-two-client-feed", callback),
      create: (writer) => writer.tasks.create({ task_id: "task-two-client-feed", status: "pending" }),
      update: (writer) => writer.tasks.update("task-two-client-feed", { status: "acknowledged" }),
      expectedFeedResource: (value) => value,
      assertRead: async ({ core, receiver }, value) => {
        const taskReads = core.requests.filter((request) => request === "/tasks/task-two-client-feed").length;
        await expect(receiver.tasks.get("task-two-client-feed")).resolves.toEqual(value);
        expect(core.requests.filter((request) => request === "/tasks/task-two-client-feed")).toHaveLength(taskReads);
      }
    },
    {
      name: "object",
      resource_type: "object",
      id: "object-two-client-feed",
      watch: (receiver, callback) => receiver.objects.watch("object-two-client-feed", callback),
      create: (writer) => writer.objects.create({ object_id: "object-two-client-feed", type: "image", extra: { label: "created" } }),
      update: (writer) => writer.objects.update("object-two-client-feed", { type: "log", extra: { label: "updated" } }),
      expectedFeedResource: objectFeedResource,
      assertRead: async ({ core, receiver }, value) => {
        const objectReads = core.requests.filter((request) => request === "/objects/object-two-client-feed").length;
        await expect(receiver.objects.get("object-two-client-feed")).resolves.toEqual(value);
        expect(core.requests.filter((request) => request === "/objects/object-two-client-feed")).toHaveLength(objectReads + 1);
      }
    }
  ];
}

async function expectWatch(
  watch: ReturnType<typeof vi.fn>,
  resource: ResourceValue,
  event: { event: "create" | "update"; id: string; resource_type: ResourceType; version: number }
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(watch).toHaveBeenCalledWith(resource, expect.objectContaining(event));
    },
    { timeout: 1_000 }
  );
}

async function deleteResource(writer: AtlasClient, type: ResourceType, id: string): Promise<void> {
  if (type === "entity") {
    await writer.entities.delete(id);
  } else if (type === "task") {
    await writer.tasks.delete(id);
  } else {
    await writer.objects.delete(id);
  }
}

function objectFeedResource(value: ObjectDetailResource): ObjectResource {
  const { extra: _extra, ...resource } = value;
  return resource;
}
