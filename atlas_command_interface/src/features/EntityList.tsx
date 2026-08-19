import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { useMemo, useState } from "react";
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
import { ChevronRightIcon, SearchIcon } from "../ui/primitives/icons.js";
import { connectionStatusColor, connectionStatusLabel } from "../ui/primitives/StatusPill.js";
import { useHeartbeatClock } from "./useHeartbeatClock.js";

type EntityListProps = {
  entities: EntityResource[];
  selectedId?: string;
  restoreFocusId?: string;
  emptyLabel: string;
  onSelect: (entity: EntityResource) => void;
  onPreview?: (entity: EntityResource | null) => void;
};

export function EntityList({ entities, selectedId, restoreFocusId, emptyLabel, onSelect, onPreview }: EntityListProps) {
  const now = useHeartbeatClock();
  const [query, setQuery] = useState("");
  const visibleEntities = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return entities;
    return entities.filter((entity) =>
      `${entityDisplayName(entity)} ${entityMeta(entity, now)}`.toLocaleLowerCase().includes(normalized)
    );
  }, [entities, now, query]);
  if (entities.length === 0) {
    return <div className="panel__empty">{emptyLabel}</div>;
  }
  return (
    <div className="entity-browser">
      <label className="bp6-input-group bp6-small entity-filter">
        <SearchIcon size={14} />
        <input
          className="bp6-input"
          type="search"
          aria-label="Filter entities"
          placeholder="Filter entities"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div className="entity-list__summary" aria-live="polite">
        {query ? `${visibleEntities.length} of ${entities.length}` : `${entities.length} total`}
      </div>
      {visibleEntities.length === 0 ? (
        <div className="panel__empty">No matching entities.</div>
      ) : (
        <ul className="entity-list">
          {visibleEntities.map((entity) => (
            <li key={entity.entity_id}>
              <button
                type="button"
                className="entity-row"
                data-selected={entity.entity_id === selectedId}
                aria-current={entity.entity_id === selectedId ? "true" : undefined}
                autoFocus={entity.entity_id === selectedId && entity.entity_id === restoreFocusId}
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
                <ChevronRightIcon size={12} className="entity-row__chevron" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
      formatRelativeTime(entityLastSeen(entity), now)
    ];
    return parts.filter(Boolean).join(" · ");
  }
  if (kind === "track") {
    const classification = entityClassification(entity);
    return [classification, formatRelativeTime(entityLastSeen(entity), now)].filter(Boolean).join(" · ");
  }
  const geometry = entityGeometry(entity);
  return geometry ? geometry.type : "No geometry";
}
