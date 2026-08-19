import type { TaskResource } from "@the-drunken-coder/atlas-sdk";

export const TASK_STATUSES = ["pending", "acknowledged", "in_progress", "completed", "failed", "cancelled"] as const;
export type TaskStatusName = (typeof TASK_STATUSES)[number];

const TASK_STATUS_LABELS: Record<TaskStatusName, string> = {
  pending: "Pending",
  acknowledged: "Acknowledged",
  in_progress: "In progress",
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

export function taskStatusMessage(task: TaskResource): string | undefined {
  if (task.failure) return task.failure.message;
  if (task.cancellation) return task.cancellation.message;
  if (task.progress !== undefined) return `${Math.round(task.progress * 100)}%`;
  if (task.output !== undefined) return "Output available";
  return undefined;
}

export function sortTasksByRecency(tasks: TaskResource[]): TaskResource[] {
  return [...tasks].sort((a, b) => {
    const byUpdated = Date.parse(b.updated_at) - Date.parse(a.updated_at);
    if (Number.isFinite(byUpdated) && byUpdated !== 0) return byUpdated;
    const byCreated = Date.parse(b.created_at) - Date.parse(a.created_at);
    if (Number.isFinite(byCreated) && byCreated !== 0) return byCreated;
    return a.task_id.localeCompare(b.task_id);
  });
}
