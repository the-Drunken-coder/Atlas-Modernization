import type { CommandCatalog, EntityResource } from "@the-drunken-coder/atlas-sdk";
import { type CommandAvailability, commandsForTargeting } from "../../atlas/command-targeting.js";
import {
  entityAltitude,
  entityBattery,
  entityConnectionStatus,
  entityDisplayName,
  entityHeading,
  entityHeartbeatLastSeen,
  entityPosition,
  entitySpeed,
  entityStatusValue,
  heartbeatLevel
} from "../../atlas/entities.js";
import { formatNumber, formatPercent, formatRelativeTime } from "../../atlas/format.js";
import { activeTasks, queuedTasks, tasksForAsset } from "../../atlas/selectors.js";
import type { AtlasSnapshot } from "../../atlas/store.js";
import { JsonDrawer } from "../../ui/primitives/JsonDrawer.js";
import { ConnectionStatusPill, heartbeatColor, StatusPill } from "../../ui/primitives/StatusPill.js";
import { CommandList } from "../commands/CommandList.js";
import { FieldGrid, InspectorHeading, Section } from "../shared/panels.js";
import { TaskHistoryItem, TaskRow } from "../shared/TaskRow.js";
import { useHeartbeatClock } from "../useHeartbeatClock.js";

const MAX_HISTORY = 25;

export type CommandManifestStatus = "ready" | "loading" | "unavailable";

type AssetInspectorProps = {
  entity: EntityResource;
  snapshot: AtlasSnapshot;
  catalog?: CommandCatalog;
  commandManifestStatus?: CommandManifestStatus;
  onPickCommand: (availability: CommandAvailability) => void;
};

export function AssetInspector({
  entity,
  snapshot,
  catalog,
  commandManifestStatus = "ready",
  onPickCommand
}: AssetInspectorProps) {
  const now = useHeartbeatClock();
  const position = entityPosition(entity);
  const connection = entityConnectionStatus(entity, now);
  const battery = entityBattery(entity);
  const lastSeen = entityHeartbeatLastSeen(entity);
  const level = heartbeatLevel(lastSeen, now);
  const active = activeTasks(snapshot, entity);
  const queued = queuedTasks(snapshot, entity);
  const history = tasksForAsset(snapshot, entity.entity_id)
    .filter((task) => task.status === "completed" || task.status === "failed" || task.status === "cancelled")
    .slice(0, MAX_HISTORY);
  const sidebarCommands = catalog
    ? [...commandsForTargeting(catalog, entity, "none"), ...commandsForTargeting(catalog, entity, "map_point")]
    : [];
  const commandEmptyLabel = !catalog
    ? "Command Catalog unavailable"
    : catalog.length === 0
      ? "No Commands are defined in Atlas Protocol"
      : commandManifestStatus === "loading"
        ? "Loading Asset Commands"
        : commandManifestStatus === "unavailable"
          ? "Asset Commands unavailable"
          : !entity.command_manifest?.length
            ? "This Asset has no Commands"
            : "No operator inputs are available for this Asset's Commands";

  return (
    <div className="inspector">
      <InspectorHeading name={entityDisplayName(entity)} id={entity.entity_id} />

      <Section title="Status">
        <FieldGrid
          rows={[
            ["State", entityStatusValue(entity) ?? "N/A"],
            ["Link", connection ? <ConnectionStatusPill key="connection-status" status={connection} /> : "N/A"],
            [
              "Heartbeat",
              level ? (
                <StatusPill
                  key="heartbeat-status"
                  label={level === "clock-error" ? "Clock error" : formatRelativeTime(lastSeen, now)}
                  accent={level === "clock-error" ? "var(--text-3)" : heartbeatColor(level)}
                />
              ) : (
                "N/A"
              )
            ],
            ["Battery", battery !== undefined ? formatPercent(battery) : "N/A"]
          ]}
        />
      </Section>

      <Section title="Location & Movement">
        <FieldGrid
          rows={[
            ["Latitude", position ? position[1].toFixed(5) : "N/A"],
            ["Longitude", position ? position[0].toFixed(5) : "N/A"],
            ["Altitude", formatNumber(entityAltitude(entity), { unit: "m", digits: 0 })],
            ["Heading", formatNumber(entityHeading(entity), { unit: "°", digits: 0 })],
            ["Speed", formatNumber(entitySpeed(entity), { unit: "m/s", digits: 1 })]
          ]}
        />
      </Section>

      <Section title="Active & Queued Tasks">
        {active.length > 0 ? (
          active.map((task) => <TaskRow key={task.task_id} task={task} />)
        ) : (
          <div style={{ color: "var(--text-3)" }}>No active task</div>
        )}
        {queued.length > 0 ? queued.map((task) => <TaskRow key={task.task_id} task={task} />) : null}
      </Section>

      <Section title="Commands">
        <CommandList
          availabilities={sidebarCommands}
          onPick={onPickCommand}
          emptyLabel={commandEmptyLabel}
          disabled={commandManifestStatus !== "ready"}
        />
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
