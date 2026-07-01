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
  onPreview?: (entity: EntityResource | null) => void;
};

export function EntityList({ entities, selectedId, emptyLabel, onSelect, onPreview }: EntityListProps) {
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
            onMouseEnter={() => onPreview?.(entity)}
            onMouseLeave={() => onPreview?.(null)}
            onMouseMove={() => onPreview?.(entity)}
            onPointerEnter={() => onPreview?.(entity)}
            onPointerLeave={() => onPreview?.(null)}
            onPointerMove={() => onPreview?.(entity)}
          >
            <span className="entity-row__dot" style={{ background: entityDotColor(entity) }} />
            <span className="entity-row__main">
              <span className="entity-row__name">{entityDisplayName(entity)}</span>
              <span className="entity-row__meta">{entityMeta(entity)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
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
