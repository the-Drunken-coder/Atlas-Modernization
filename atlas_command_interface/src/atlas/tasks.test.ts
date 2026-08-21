import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { taskStatusMessage } from "./tasks.js";

describe("taskStatusMessage", () => {
  it("prefers completed output over the final progress value", () => {
    const task: TaskResource = {
      task_id: "task-1",
      asset_id: "asset-1",
      command: "fixture.queued",
      input: {},
      status: "completed",
      progress: 1,
      output: { result: "done" },
      acknowledged_at: "2026-08-20T00:00:00Z",
      started_at: "2026-08-20T00:00:00Z",
      finished_at: "2026-08-20T00:00:01Z",
      created_at: "2026-08-20T00:00:00Z",
      updated_at: "2026-08-20T00:00:01Z"
    };

    expect(taskStatusMessage(task)).toBe("Output available");
  });
});
