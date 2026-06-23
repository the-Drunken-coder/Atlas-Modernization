import type { EntityResource } from "../../../../atlas_sdk/src/index.js";
import {
  entityAltitude,
  entityClassification,
  entityDisplayName,
  entityHeading,
  entityLastSeen,
  entityPosition,
  entitySpeed
} from "../../atlas/entities.js";
import { formatNumber, formatRelativeTime } from "../../atlas/format.js";
import { ClassificationPill } from "../../ui/primitives/StatusPill.js";
import { JsonDrawer } from "../../ui/primitives/JsonDrawer.js";
import { FieldGrid, InspectorHeading, Section } from "../shared/panels.js";

export function TrackInspector({ entity }: { entity: EntityResource }) {
  const position = entityPosition(entity);
  const classification = entityClassification(entity);
  return (
    <div className="inspector">
      <InspectorHeading name={entityDisplayName(entity)} id={entity.entity_id} />

      <Section title="Location & Movement">
        <FieldGrid
          rows={[
            ["Latitude", position ? position[1].toFixed(5) : "—"],
            ["Longitude", position ? position[0].toFixed(5) : "—"],
            ["Altitude", formatNumber(entityAltitude(entity), { unit: "m", digits: 0 })],
            ["Heading", formatNumber(entityHeading(entity), { unit: "°", digits: 0 })],
            ["Speed", formatNumber(entitySpeed(entity), { unit: "m/s", digits: 1 })],
            ["Last update", formatRelativeTime(entityLastSeen(entity))]
          ]}
        />
      </Section>

      <Section title="Classification">
        {classification ? <ClassificationPill value={classification} /> : <span style={{ color: "var(--text-3)" }}>Unclassified</span>}
      </Section>

      <JsonDrawer title="Raw entity JSON" value={entity} />
    </div>
  );
}
