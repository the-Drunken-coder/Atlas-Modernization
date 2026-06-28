import { describe, expect, it } from "vitest";
import { createFakeAtlasCore } from "./fake-atlas.js";

describe("fake Atlas core", () => {
  it("returns pending entity tasks from check-in", async () => {
    const core = createFakeAtlasCore();
    const client = core.factory();
    await client.entities.create({ entity_id: "asset-1", entity_type: "asset" });
    await client.tasks.create({ task_id: "task-1", entity_id: "asset-1" });
    await client.tasks.create({ task_id: "task-2", entity_id: "asset-1", status: "acknowledged" });

    const checkIn = await client.entities.checkIn("asset-1");

    expect(checkIn.tasks.map((task) => task.task_id)).toEqual(["task-1"]);
    expect(checkIn.task_count).toBe(1);
    expect(checkIn.task_limit).toBe(10);
    expect(checkIn.has_more_tasks).toBe(false);
  });
});
