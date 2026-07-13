import type { CSSProperties } from "react";
import type { Classification, EntityConnectionStatus, HeartbeatLevel } from "../../atlas/entities.js";
import { isKnownTaskStatus, taskStatusLabel } from "../../atlas/tasks.js";

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

export function ConnectionStatusPill({ status }: { status: EntityConnectionStatus }) {
  return <StatusPill label={connectionStatusLabel(status)} color={connectionStatusColor(status)} />;
}

export function connectionStatusLabel({ reported, freshness }: EntityConnectionStatus): string {
  if (freshness === "fresh") return titleCase(reported);
  if (freshness === "missing") return `Reported ${reported} — never checked in`;
  return `Reported ${reported} — ${freshness === "stale" ? "stale heartbeat" : "offline"}`;
}

export function connectionStatusColor({ reported, freshness }: EntityConnectionStatus): string {
  if (freshness === "fresh") return `var(--link-${reported})`;
  if (freshness === "missing") return "var(--text-3)";
  return heartbeatColor(freshness);
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
