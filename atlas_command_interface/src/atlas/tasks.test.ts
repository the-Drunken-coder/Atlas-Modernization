import type { JSONValue, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { taskParameters } from "./tasks.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

function task(parameters: JSONValue | undefined): TaskResource {
  return {
    task_id: "task-1",
    entity_id: "asset-1",
    status: "pending",
    components: parameters === undefined ? {} : ({ parameters } as unknown as TaskResource["components"]),
    metadata
  };
}

describe("task helpers", () => {
  it("returns command parameters only when they are object-shaped", () => {
    expect(taskParameters(task({ latitude: 40.1 }))).toEqual({ latitude: 40.1 });
    expect(taskParameters(task(undefined))).toBeUndefined();
    expect(taskParameters(task(["bad"]))).toBeUndefined();
    expect(taskParameters(task("bad"))).toBeUndefined();
    expect(taskParameters(task(null))).toBeUndefined();
  });
});
