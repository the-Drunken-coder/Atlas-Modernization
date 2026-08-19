import { cleanup, render, screen } from "@testing-library/react";
import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRow } from "./TaskRow.js";

afterEach(cleanup);

const base: TaskResource = {
  task_id: "task-1",
  asset_id: "asset-1",
  command: "fixture.queued",
  input: { value: "fixture" },
  status: "pending",
  created_at: "2026-08-19T12:00:00Z",
  updated_at: "2026-08-19T12:00:00Z"
};

describe("TaskRow", () => {
  it.each([
    [{ ...base, status: "in_progress" as const, progress: 0.42 }, "In progress", "42%"],
    [{ ...base, status: "completed" as const, output: { result: "done" } }, "Completed", "Output available"],
    [
      {
        ...base,
        status: "failed" as const,
        failure: { code: "execution_failed" as const, message: "motor fault" }
      },
      "Failed",
      "motor fault"
    ],
    [
      {
        ...base,
        status: "cancelled" as const,
        cancellation: { code: "requested" as const, message: "operator cancelled" }
      },
      "Cancelled",
      "operator cancelled"
    ]
  ])("renders lifecycle state and outcome details", (task, status, detail) => {
    render(<TaskRow task={task} />);
    expect(screen.getByText("fixture.queued")).toBeInTheDocument();
    expect(screen.getByText(status)).toBeInTheDocument();
    if (detail) expect(screen.getByText(new RegExp(detail))).toBeInTheDocument();
  });
});
