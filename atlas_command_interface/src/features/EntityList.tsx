import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { useEffect, useMemo, useRef } from "react";
import {
  entityBattery,
  entityClassification,
  entityConnectionStatus,
  entityDisplayName,
  entityGeometry,
  entityHeartbeatLastSeen,
  entityKind,
  entityLastSeen,
  entityLinkState,
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
  query: string;
  emptyLabel: string;
  onSelect: (entity: EntityResource) => void;
  onQueryChange: (query: string) => void;
};

export function EntityList({
  entities,
  selectedId,
  restoreFocusId,
  query,
  emptyLabel,
  onSelect,
  onQueryChange
}: EntityListProps) {
  const now = useHeartbeatClock();
  const filterRef = useRef<HTMLInputElement>(null);
  const focusedEntityIdRef = useRef<string | undefined>(undefined);
  const restoreFocusRef = useRef<HTMLButtonElement>(null);
  const visibleEntities = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return entities;
    return entities.filter((entity) => entitySearchText(entity).toLocaleLowerCase().includes(normalized));
  }, [entities, query]);

  useEffect(() => {
    if (!restoreFocusId) return;
    (restoreFocusRef.current ?? filterRef.current)?.focus();
  }, [restoreFocusId]);

  useEffect(() => {
    const focusedId = focusedEntityIdRef.current;
    if (!focusedId || visibleEntities.some((entity) => entity.entity_id === focusedId)) return;
    focusedEntityIdRef.current = undefined;
    filterRef.current?.focus();
  }, [visibleEntities]);

  if (entities.length === 0) {
    return <div className="panel__empty">{emptyLabel}</div>;
  }
  return (
    <div className="entity-browser">
      <label className="bp6-input-group bp6-small entity-filter">
        <SearchIcon size={14} />
        <input
          ref={filterRef}
          className="bp6-input"
          type="search"
          aria-label="Filter entities"
          placeholder="Filter entities"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
      </label>
      <div className="entity-list__summary" aria-live="polite">
        {query.trim() ? `${visibleEntities.length} of ${entities.length}` : `${entities.length} total`}
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
                ref={
                  entity.entity_id === selectedId && entity.entity_id === restoreFocusId ? restoreFocusRef : undefined
                }
                onBlur={() => {
                  focusedEntityIdRef.current = undefined;
                }}
                onClick={() => onSelect(entity)}
                onFocus={() => {
                  focusedEntityIdRef.current = entity.entity_id;
                }}
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

export function entitySearchText(entity: EntityResource): string {
  const common = [entityDisplayName(entity), entity.entity_id, entity.entity_type, entity.subtype];
  const kind = entityKind(entity);
  if (kind === "asset") {
    const battery = entityBattery(entity);
    return [...common, entityLinkState(entity), battery !== undefined ? formatPercent(battery) : undefined]
      .filter(Boolean)
      .join(" ");
  }
  if (kind === "track") {
    return [...common, entityClassification(entity)].filter(Boolean).join(" ");
  }
  const geometry = entityGeometry(entity);
  return [...common, geometry?.type].filter(Boolean).join(" ");
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

export function entityMeta(entity: EntityResource, now: number): string {
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
