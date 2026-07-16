import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { formatRelativeTime } from "../../atlas/format.js";
import { taskCommandId, taskStatusMessage } from "../../atlas/tasks.js";
import { JsonDrawer } from "../../ui/primitives/JsonDrawer.js";
import { TaskStatusPill } from "../../ui/primitives/StatusPill.js";

export function TaskRow({ task }: { task: TaskResource }) {
  const commandId = taskCommandId(task);
  const message = taskStatusMessage(task);
  return (
    <div className="task-row">
      <span className="task-row__main">
        <span className="task-row__title">{commandId ?? task.task_id}</span>
        <span className="task-row__sub">
          {formatRelativeTime(task.metadata.updated_at)}
          {message ? ` · ${message}` : ""}
        </span>
      </span>
      <TaskStatusPill status={task.status} />
    </div>
  );
}

/** Task row plus a collapsed JSON drawer exposing the command payload. */
export function TaskHistoryItem({ task }: { task: TaskResource }) {
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <TaskRow task={task} />
      <div style={{ padding: "0 12px 8px" }}>
        <JsonDrawer title="Task payload" value={{ task_id: task.task_id, status: task.status, components: task.components }} />
      </div>
    </div>
  );
}
