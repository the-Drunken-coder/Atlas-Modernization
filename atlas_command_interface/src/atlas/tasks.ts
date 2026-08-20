import type { TaskResource, TaskStatus } from "@the-drunken-coder/atlas-sdk";

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "Pending",
  acknowledged: "Acknowledged",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled"
};

export function taskStatusLabel(status: TaskStatus): string {
  return TASK_STATUS_LABELS[status];
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

export function sortTasksByTaskingOrder(tasks: TaskResource[]): TaskResource[] {
  return [...tasks].sort((a, b) => {
    const byCreated = Date.parse(a.created_at) - Date.parse(b.created_at);
    if (Number.isFinite(byCreated) && byCreated !== 0) return byCreated;
    return a.task_id.localeCompare(b.task_id);
  });
}
