import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import { formatRelativeTime } from "../../atlas/format.js";
import { taskStatusMessage } from "../../atlas/tasks.js";
import { IconButton } from "../../ui/primitives/controls.js";
import { JsonDrawer } from "../../ui/primitives/JsonDrawer.js";
import { ContextMenu } from "../../ui/primitives/Menu.js";
import { TaskStatusPill } from "../../ui/primitives/StatusPill.js";

type TaskRowProps = {
  task: TaskResource;
  onCancel?: (taskId: string) => Promise<unknown>;
};

export function TaskRow({ task, onCancel }: TaskRowProps) {
  const message = taskStatusMessage(task);
  const actionsLabel = `Task actions for ${task.command} task ${task.task_id}`;
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number }>();
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  const cancel = async () => {
    if (!onCancel || cancelling) return;
    setCancelling(true);
    setCancelError(undefined);
    try {
      await onCancel(task.task_id);
    } catch (cause) {
      setCancelError(sanitizeConnectionError(cause));
    } finally {
      setCancelling(false);
    }
  };
  return (
    <div className="task-row-shell">
      <div className="task-row">
        <span className="task-row__main">
          <span className="task-row__title">{task.command}</span>
          <span className="task-row__sub">
            {formatRelativeTime(task.updated_at)}
            {message ? ` · ${message}` : ""}
          </span>
        </span>
        <TaskStatusPill status={task.status} />
        {onCancel ? (
          <IconButton
            className="task-row__actions"
            label={actionsLabel}
            aria-haspopup="menu"
            aria-expanded={menuPosition !== undefined}
            aria-disabled={cancelling}
            onClick={(event) => {
              if (cancelling) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              setMenuPosition({ x: bounds.right, y: bounds.bottom + 4 });
            }}
          >
            <span aria-hidden="true">•••</span>
          </IconButton>
        ) : null}
        {onCancel && menuPosition ? (
          <ContextMenu
            x={menuPosition.x}
            y={menuPosition.y}
            items={[{ key: "cancel", title: "Cancel task", onSelect: () => void cancel() }]}
            ariaLabel={actionsLabel}
            onClose={() => setMenuPosition(undefined)}
          />
        ) : null}
      </div>
      {cancelling ? (
        <div className="task-row__notice" role="status">
          Cancelling...
        </div>
      ) : cancelError ? (
        <div className="task-row__notice task-row__notice--error" role="alert">
          {cancelError}
        </div>
      ) : null}
    </div>
  );
}

/** Task row plus a collapsed JSON drawer exposing the command payload. */
export function TaskHistoryItem({ task }: { task: TaskResource }) {
  return (
    <div className="task-history-item">
      <TaskRow task={task} />
      <div style={{ padding: "0 12px 8px" }}>
        <JsonDrawer title="Task payload" value={task} />
      </div>
    </div>
  );
}
