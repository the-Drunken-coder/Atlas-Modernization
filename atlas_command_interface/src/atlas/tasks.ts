import type { JSONValue, TaskResource } from "@the-drunken-coder/atlas-sdk";

export const TASK_STATUSES = ["pending", "acknowledged", "completed", "failed", "cancelled"] as const;
export type TaskStatusName = (typeof TASK_STATUSES)[number];

const TASK_STATUS_LABELS: Record<TaskStatusName, string> = {
  pending: "Pending",
  acknowledged: "Acknowledged",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled"
};

export function isKnownTaskStatus(status: string): status is TaskStatusName {
  return (TASK_STATUSES as readonly string[]).includes(status);
}

export function taskStatusLabel(status: string): string {
  return isKnownTaskStatus(status) ? TASK_STATUS_LABELS[status] : status;
}

export function taskCommandId(task: TaskResource): string | undefined {
  return task.components.command?.id ?? task.components.command?.type;
}

export function taskParameters(task: TaskResource): Record<string, JSONValue> | undefined {
  const parameters = task.components.parameters;
  return isRecord(parameters) ? parameters : undefined;
}

export function taskStatusMessage(task: TaskResource): string | undefined {
  return task.components.status_message;
}

/** Most-recently-updated task first. Falls back to created_at, then task_id. */
export function sortTasksByRecency(tasks: TaskResource[]): TaskResource[] {
  return [...tasks].sort((a, b) => {
    const byUpdated = Date.parse(b.metadata.updated_at) - Date.parse(a.metadata.updated_at);
    if (Number.isFinite(byUpdated) && byUpdated !== 0) return byUpdated;
    const byCreated = Date.parse(b.metadata.created_at) - Date.parse(a.metadata.created_at);
    if (Number.isFinite(byCreated) && byCreated !== 0) return byCreated;
    return a.task_id.localeCompare(b.task_id);
  });
}

function isRecord(value: unknown): value is Record<string, JSONValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
