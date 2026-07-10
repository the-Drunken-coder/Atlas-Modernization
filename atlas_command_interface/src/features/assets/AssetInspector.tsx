import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import type { CommandCatalog } from "../../atlas/command-model.js";
import { commandsForTargeting, type CommandAvailability } from "../../atlas/command-targeting.js";
import {
  entityAltitude,
  entityBattery,
  entityDisplayName,
  entityHeading,
  entityLastSeen,
  entityLinkState,
  entityPosition,
  entitySpeed,
  entityStatusValue,
  heartbeatLevel
} from "../../atlas/entities.js";
import { formatNumber, formatPercent, formatRelativeTime } from "../../atlas/format.js";
import { currentTask, queuedTasks, tasksForEntity } from "../../atlas/selectors.js";
import type { AtlasSnapshot } from "../../atlas/store.js";
import { heartbeatColor, LinkStatePill, StatusPill } from "../../ui/primitives/StatusPill.js";
import { JsonDrawer } from "../../ui/primitives/JsonDrawer.js";
import { CommandList } from "../commands/CommandList.js";
import { FieldGrid, InspectorHeading, Section } from "../shared/panels.js";
import { TaskHistoryItem, TaskRow } from "../shared/TaskRow.js";

const MAX_HISTORY = 25;

type AssetInspectorProps = {
  entity: EntityResource;
  snapshot: AtlasSnapshot;
  catalog?: CommandCatalog;
  onPickCommand: (availability: CommandAvailability) => void;
};

export function AssetInspector({ entity, snapshot, catalog, onPickCommand }: AssetInspectorProps) {
  const position = entityPosition(entity);
  const link = entityLinkState(entity);
  const battery = entityBattery(entity);
  const lastSeen = entityLastSeen(entity);
  const level = heartbeatLevel(lastSeen);
  const active = currentTask(snapshot, entity);
  const queued = queuedTasks(snapshot, entity);
  const history = tasksForEntity(snapshot, entity.entity_id).slice(0, MAX_HISTORY);
  const sidebarCommands = catalog ? commandsForTargeting(catalog, entity, "none") : [];

  return (
    <div className="inspector">
      <InspectorHeading name={entityDisplayName(entity)} id={entity.entity_id} />

      <Section title="Status">
        <FieldGrid
          rows={[
            ["State", entityStatusValue(entity) ?? "—"],
            ["Link", link ? <LinkStatePill state={link} /> : "—"],
            ["Heartbeat", level ? <StatusPill label={formatRelativeTime(lastSeen)} color={heartbeatColor(level)} /> : "—"],
            ["Battery", battery !== undefined ? formatPercent(battery) : "—"]
          ]}
        />
      </Section>

      <Section title="Location & Movement">
        <FieldGrid
          rows={[
            ["Latitude", position ? position[1].toFixed(5) : "—"],
            ["Longitude", position ? position[0].toFixed(5) : "—"],
            ["Altitude", formatNumber(entityAltitude(entity), { unit: "m", digits: 0 })],
            ["Heading", formatNumber(entityHeading(entity), { unit: "°", digits: 0 })],
            ["Speed", formatNumber(entitySpeed(entity), { unit: "m/s", digits: 1 })]
          ]}
        />
      </Section>

      <Section title="Active & Queued Tasks">
        {active ? <TaskRow task={active} /> : <div style={{ color: "var(--text-3)" }}>No active task</div>}
        {queued.length > 0 ? queued.map((task) => <TaskRow key={task.task_id} task={task} />) : null}
      </Section>

      <Section title="Commands">
        <CommandList availabilities={sidebarCommands} onPick={onPickCommand} emptyLabel={catalog ? "No commands available" : "Command catalog unavailable"} />
        <p className="field__hint" style={{ marginTop: 8 }}>
          Right-click the map to send position commands to this asset.
        </p>
      </Section>

      <Section title="Task History">
        {history.length === 0 ? (
          <div style={{ color: "var(--text-3)" }}>No task history</div>
        ) : (
          history.map((task) => <TaskHistoryItem key={task.task_id} task={task} />)
        )}
      </Section>

      <JsonDrawer title="Raw entity JSON" value={entity} />
    </div>
  );
}
