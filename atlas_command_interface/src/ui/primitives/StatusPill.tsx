import type { CSSProperties } from "react";
import { isKnownTaskStatus, taskStatusLabel } from "../../atlas/tasks.js";
import type { Classification, HeartbeatLevel, LinkState } from "../../atlas/entities.js";

type StatusPillProps = {
  label: string;
  color?: string;
  dot?: boolean;
};

export function StatusPill({ label, color, dot = true }: StatusPillProps) {
  const style = color ? ({ "--pill-color": color } as CSSProperties) : undefined;
  return (
    <span className="pill" style={style}>
      {dot ? <span className="pill__dot" /> : null}
      {label}
    </span>
  );
}

export function TaskStatusPill({ status }: { status: string }) {
  const color = isKnownTaskStatus(status) ? `var(--status-${status})` : "var(--text-3)";
  return <StatusPill label={taskStatusLabel(status)} color={color} />;
}

export function LinkStatePill({ state }: { state: LinkState }) {
  return <StatusPill label={titleCase(state)} color={`var(--link-${state})`} />;
}

export function ClassificationPill({ value }: { value: Classification }) {
  return <StatusPill label={titleCase(value)} color={`var(--class-${value})`} />;
}

const HEARTBEAT_COLORS: Record<HeartbeatLevel, string> = {
  fresh: "var(--heartbeat-fresh)",
  stale: "var(--heartbeat-stale)",
  offline: "var(--heartbeat-offline)"
};

export function heartbeatColor(level: HeartbeatLevel): string {
  return HEARTBEAT_COLORS[level];
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
