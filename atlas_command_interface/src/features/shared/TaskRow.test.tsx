import { cleanup, render, screen } from "@testing-library/react";
import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRow } from "./TaskRow.js";

afterEach(cleanup);

const base = {
  task_id: "task-1",
  asset_id: "asset-1",
  command: "fixture.queued",
  input: { value: "fixture" },
  status: "pending",
  created_at: "2026-08-19T12:00:00Z",
  updated_at: "2026-08-19T12:00:00Z"
} satisfies TaskResource;

const lifecycleCases: ReadonlyArray<readonly [TaskResource, string, string]> = [
  [
    {
      ...base,
      status: "in_progress",
      acknowledged_at: "2026-08-19T12:00:01Z",
      started_at: "2026-08-19T12:00:02Z",
      progress: 0.42
    },
    "In progress",
    "42%"
  ],
  [
    {
      ...base,
      status: "completed",
      acknowledged_at: "2026-08-19T12:00:01Z",
      started_at: "2026-08-19T12:00:02Z",
      finished_at: "2026-08-19T12:00:03Z",
      output: { result: "done" }
    },
    "Completed",
    "Output available"
  ],
  [
    {
      ...base,
      status: "failed",
      finished_at: "2026-08-19T12:00:03Z",
      failure: { code: "execution_failed", message: "motor fault" }
    },
    "Failed",
    "motor fault"
  ],
  [
    {
      ...base,
      status: "cancelled",
      finished_at: "2026-08-19T12:00:03Z",
      cancellation: { code: "requested", message: "operator cancelled" }
    },
    "Cancelled",
    "operator cancelled"
  ]
];

describe("TaskRow", () => {
  it.each(lifecycleCases)("renders lifecycle state and outcome details", (task, status, detail) => {
    render(<TaskRow task={task} />);
    expect(screen.getByText("fixture.queued")).toBeInTheDocument();
    expect(screen.getByText(status)).toBeInTheDocument();
    if (detail) expect(screen.getByText(new RegExp(detail))).toBeInTheDocument();
  });
});
