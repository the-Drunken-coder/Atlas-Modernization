import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import {
  entityBattery,
  entityClassification,
  entityConnectionStatus,
  entityDisplayName,
  entityGeometry,
  entityHeartbeatLastSeen,
  entityKind,
  entityLastSeen,
  heartbeatLevel
} from "../atlas/entities.js";
import { formatPercent, formatRelativeTime } from "../atlas/format.js";
import { connectionStatusColor, connectionStatusLabel } from "../ui/primitives/StatusPill.js";
import { useHeartbeatClock } from "./useHeartbeatClock.js";

type EntityListProps = {
  entities: EntityResource[];
  selectedId?: string;
  emptyLabel: string;
  onSelect: (entity: EntityResource) => void;
  onPreview?: (entity: EntityResource | null) => void;
};

export function EntityList({ entities, selectedId, emptyLabel, onSelect, onPreview }: EntityListProps) {
  const now = useHeartbeatClock();
  if (entities.length === 0) {
    return <div className="panel__empty">{emptyLabel}</div>;
  }
  return (
    <ul className="entity-list">
      {entities.map((entity) => (
        <li key={entity.entity_id}>
          <button
            type="button"
            className="entity-row"
            data-selected={entity.entity_id === selectedId}
            onBlur={() => onPreview?.(null)}
            onClick={() => {
              onPreview?.(null);
              onSelect(entity);
            }}
            onFocus={() => onPreview?.(entity)}
            onPointerEnter={() => onPreview?.(entity)}
            onPointerLeave={() => onPreview?.(null)}
          >
            <span className="entity-row__dot" style={{ background: entityDotColor(entity, now) }} />
            <span className="entity-row__main">
              <span className="entity-row__name">{entityDisplayName(entity)}</span>
              <span className="entity-row__meta">{entityMeta(entity, now)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function entityDotColor(entity: EntityResource, now: number = Date.now()): string {
  const kind = entityKind(entity);
  if (kind === "asset") {
    const connection = entityConnectionStatus(entity, now);
    if (connection) return connectionStatusColor(connection);
    const level = heartbeatLevel(entityHeartbeatLastSeen(entity), now);
    if (level === "clock-error") return "var(--text-3)";
    return level ? `var(--heartbeat-${level})` : "var(--map-asset)";
  }
  if (kind === "track") {
    const classification = entityClassification(entity);
    return classification ? `var(--class-${classification})` : "var(--map-track)";
  }
  return "var(--map-geofeature)";
}

function entityMeta(entity: EntityResource, now: number): string {
  const kind = entityKind(entity);
  if (kind === "asset") {
    const connection = entityConnectionStatus(entity, now);
    const battery = entityBattery(entity);
    const parts = [
      connection ? connectionStatusLabel(connection) : undefined,
      battery !== undefined ? formatPercent(battery) : undefined,
      formatRelativeTime(entityLastSeen(entity))
    ];
    return parts.filter(Boolean).join(" · ");
  }
  if (kind === "track") {
    const classification = entityClassification(entity);
    return [classification, formatRelativeTime(entityLastSeen(entity))].filter(Boolean).join(" · ");
  }
  const geometry = entityGeometry(entity);
  return geometry ? geometry.type : "No geometry";
}
