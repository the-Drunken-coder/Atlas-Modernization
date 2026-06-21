import type { EntityResource } from "../../../atlas_sdk/src/index.js";
import {
  entityBattery,
  entityClassification,
  entityDisplayName,
  entityGeometry,
  entityKind,
  entityLastSeen,
  entityLinkState,
  heartbeatLevel
} from "../atlas/entities.js";
import { formatPercent, formatRelativeTime } from "../atlas/format.js";

type EntityListProps = {
  entities: EntityResource[];
  selectedId?: string;
  emptyLabel: string;
  onSelect: (entity: EntityResource) => void;
};

export function EntityList({ entities, selectedId, emptyLabel, onSelect }: EntityListProps) {
  if (entities.length === 0) {
    return <div className="panel__empty">{emptyLabel}</div>;
  }
  return (
    <div className="entity-list" role="list">
      {entities.map((entity) => (
        <button
          key={entity.entity_id}
          type="button"
          role="listitem"
          className="entity-row"
          data-selected={entity.entity_id === selectedId}
          onClick={() => onSelect(entity)}
        >
          <span className="entity-row__dot" style={{ background: entityDotColor(entity) }} />
          <span className="entity-row__main">
            <span className="entity-row__name">{entityDisplayName(entity)}</span>
            <span className="entity-row__meta">{entityMeta(entity)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function entityDotColor(entity: EntityResource): string {
  const kind = entityKind(entity);
  if (kind === "asset") {
    const link = entityLinkState(entity);
    if (link) return `var(--link-${link})`;
    const level = heartbeatLevel(entityLastSeen(entity));
    return level ? `var(--heartbeat-${level})` : "var(--map-asset)";
  }
  if (kind === "track") {
    const classification = entityClassification(entity);
    return classification ? `var(--class-${classification})` : "var(--map-track)";
  }
  return "var(--map-geofeature)";
}

function entityMeta(entity: EntityResource): string {
  const kind = entityKind(entity);
  if (kind === "asset") {
    const link = entityLinkState(entity);
    const battery = entityBattery(entity);
    const parts = [link ? link : undefined, battery !== undefined ? formatPercent(battery) : undefined, formatRelativeTime(entityLastSeen(entity))];
    return parts.filter(Boolean).join(" · ");
  }
  if (kind === "track") {
    const classification = entityClassification(entity);
    return [classification, formatRelativeTime(entityLastSeen(entity))].filter(Boolean).join(" · ");
  }
  const geometry = entityGeometry(entity);
  return geometry ? geometry.type : "No geometry";
}
