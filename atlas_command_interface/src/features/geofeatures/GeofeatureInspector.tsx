import type { EntityResource } from "../../../../atlas_sdk/src/index.js";
import { entityClassification, entityDisplayName, entityGeometry } from "../../atlas/entities.js";
import { geometrySummary } from "../../atlas/geometry.js";
import { JsonDrawer } from "../../ui/primitives/JsonDrawer.js";
import { ClassificationPill } from "../../ui/primitives/StatusPill.js";
import { FieldGrid, InspectorHeading, Section } from "../shared/panels.js";

export function GeofeatureInspector({ entity }: { entity: EntityResource }) {
  const classification = entityClassification(entity);
  const geometry = entityGeometry(entity);

  return (
    <div className="inspector">
      <InspectorHeading name={entityDisplayName(entity)} id={entity.entity_id} />

      <Section title="Geometry">
        {geometry ? (
          <FieldGrid
            rows={[
              ["Type", geometry.type],
              ["Summary", geometrySummary(geometry)]
            ]}
          />
        ) : (
          <div style={{ color: "var(--text-3)" }}>No geometry</div>
        )}
      </Section>

      <Section title="Classification">
        {classification ? <ClassificationPill value={classification} /> : <span style={{ color: "var(--text-3)" }}>Unclassified</span>}
      </Section>

      <JsonDrawer title="Raw entity JSON" value={entity} />
    </div>
  );
}
