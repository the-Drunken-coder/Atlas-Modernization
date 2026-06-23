import type { EntityResource, JSONValue, TaskResource } from "../../../atlas_sdk/src/index.js";
import type { CommandCatalog } from "../atlas/command-model.js";
import type { CommandSubmission, ConnectionHealth } from "../atlas/data-source.js";
import { snapshotFromDataset, type AtlasSnapshot } from "../atlas/store.js";
import type { AtlasContextValue } from "../state/atlas-context.js";

const BASE_TIME = "2026-06-21T17:30:00Z";
const FIXTURE_NOW = "2026-06-21T18:00:00Z";

function minutesAgo(minutes: number): string {
  return new Date(Date.parse(FIXTURE_NOW) - minutes * 60_000).toISOString();
}

function metadata(version = 1) {
  return { created_at: BASE_TIME, updated_at: minutesAgo(version), version };
}

export const storyCommandCatalog: CommandCatalog = {
  type: "command_catalog",
  name: "Atlas Command Catalog",
  description: "Fixture command catalog for Storybook.",
  commands: [
    {
      id: "hold_position",
      name: "Hold Position",
      description: "Hold the current position until released.",
      parameters_schema: {}
    },
    {
      id: "goto",
      name: "Goto",
      description: "Move to the selected map coordinate.",
      parameters_schema: {
        latitude: { type: "number", description: "Target latitude in decimal degrees.", required: true, minimum: -90, maximum: 90 },
        longitude: { type: "number", description: "Target longitude in decimal degrees.", required: true, minimum: -180, maximum: 180 },
        arrival_radius: { type: "number", description: "Acceptable arrival radius in meters.", required: false, minimum: 1, maximum: 100 }
      }
    },
    {
      id: "set_mode",
      name: "Set Mode",
      description: "Switch the asset into an operator-selected mode.",
      parameters_schema: {
        mode: { type: "string", description: "Mode name, such as survey or loiter.", required: true }
      }
    },
    {
      id: "return_to_home",
      name: "Return To Home",
      description: "Return to the configured home location.",
      parameters_schema: {}
    },
    {
      id: "land_now",
      name: "Land Now",
      description: "Land immediately at the current position.",
      parameters_schema: {}
    }
  ]
};

export const storyAssets: EntityResource[] = [
  {
    entity_id: "asset-summit-01",
    entity_type: "asset",
    subtype: "ground_rover",
    alias: "Summit Rover 01",
    components: {
      telemetry: { latitude: 38.9037, longitude: -77.0366, altitude_m: 42, heading_deg: 73, speed_m_s: 3.6, last_update: minutesAgo(1) },
      communications: { link_state: "connected" },
      health: { battery_percent: 82 },
      heartbeat: { last_seen: minutesAgo(1) },
      status: { value: "on_task", last_update: minutesAgo(2) },
      task_catalog: { supported_tasks: ["hold_position", "goto", "set_mode", "return_to_home"] },
      task_queue: { current_task_id: "task-current", queued_task_ids: ["task-queued"] }
    },
    metadata: metadata(2)
  },
  {
    entity_id: "asset-summit-02",
    entity_type: "asset",
    subtype: "uas",
    alias: "Scout UAS 02",
    components: {
      telemetry: { latitude: 39.002, longitude: -76.918, altitude_m: 122, heading_deg: 221, speed_m_s: 17.2, last_update: minutesAgo(4) },
      communications: { link_state: "degraded" },
      health: { battery_percent: 41 },
      heartbeat: { last_seen: minutesAgo(4) },
      status: { value: "searching", last_update: minutesAgo(4) },
      task_catalog: { supported_tasks: ["hold_position", "goto", "return_to_home", "land_now"] }
    },
    metadata: metadata(3)
  },
  {
    entity_id: "asset-relay-03",
    entity_type: "asset",
    subtype: "relay",
    alias: "Relay Node 03",
    components: {
      telemetry: { latitude: 38.832, longitude: -77.214, altitude_m: 16, heading_deg: 12, speed_m_s: 0.1, last_update: minutesAgo(18) },
      communications: { link_state: "disconnected" },
      health: { battery_percent: 19 },
      heartbeat: { last_seen: minutesAgo(18) },
      status: { value: "standby", last_update: minutesAgo(18) },
      task_catalog: { supported_tasks: ["hold_position"] }
    },
    metadata: metadata(4)
  }
];

export const storyTracks: EntityResource[] = [
  {
    entity_id: "track-unknown-17",
    entity_type: "track",
    subtype: "vehicle",
    alias: "Unknown Vehicle 17",
    components: {
      telemetry: { latitude: 38.921, longitude: -76.987, altitude_m: 0, heading_deg: 188, speed_m_s: 12.8, last_update: minutesAgo(2) },
      heartbeat: { last_seen: minutesAgo(2) },
      mil_view: { classification: "unknown" }
    },
    metadata: metadata(5)
  },
  {
    entity_id: "track-friendly-04",
    entity_type: "track",
    subtype: "team",
    alias: "Blue Team 04",
    components: {
      telemetry: { latitude: 38.873, longitude: -77.101, altitude_m: 0, heading_deg: 43, speed_m_s: 1.7, last_update: minutesAgo(8) },
      heartbeat: { last_seen: minutesAgo(8) },
      mil_view: { classification: "friendly" }
    },
    metadata: metadata(6)
  }
];

export const storyGeofeatures: EntityResource[] = [
  {
    entity_id: "geo-area-alpha",
    entity_type: "geofeature",
    subtype: "restricted_area",
    alias: "Restricted Area Alpha",
    components: {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-77.19, 38.98],
            [-77.08, 39.02],
            [-77.01, 38.93],
            [-77.14, 38.88],
            [-77.19, 38.98]
          ]
        ]
      },
      mil_view: { classification: "hostile" }
    },
    metadata: metadata(7)
  },
  {
    entity_id: "geo-route-bravo",
    entity_type: "geofeature",
    subtype: "route",
    alias: "Route Bravo",
    components: {
      geometry: {
        type: "LineString",
        coordinates: [
          [-77.24, 38.84],
          [-77.11, 38.87],
          [-76.98, 38.91],
          [-76.89, 39.01]
        ]
      },
      mil_view: { classification: "friendly" }
    },
    metadata: metadata(8)
  },
  {
    entity_id: "geo-rally-charlie",
    entity_type: "geofeature",
    subtype: "rally_point",
    alias: "Rally Point Charlie",
    components: {
      geometry: { type: "Point", coordinates: [-77.033, 38.886] },
      mil_view: { classification: "neutral" }
    },
    metadata: metadata(9)
  }
];

export const storyTasks: TaskResource[] = [
  task("task-current", "asset-summit-01", "pending", "goto", { latitude: 38.955, longitude: -77.02, arrival_radius: 15 }, "Awaiting asset acknowledgement", 1),
  task("task-queued", "asset-summit-01", "acknowledged", "hold_position", {}, "Queued behind active movement", 2),
  task("task-complete", "asset-summit-01", "completed", "set_mode", { mode: "survey" }, "Asset entered survey mode", 18),
  task("task-failed", "asset-summit-02", "failed", "return_to_home", {}, "Home position unavailable", 21)
];

export const storyEntities = [...storyAssets, ...storyTracks, ...storyGeofeatures];
export const storySnapshot: AtlasSnapshot = snapshotFromDataset(storyEntities, storyTasks);

export const storyHealth: ConnectionHealth = { running: true, healthy: true, degraded: false };

export function makeStoryAtlasValue(overrides: Partial<AtlasContextValue> = {}): AtlasContextValue {
  return {
    status: "ready",
    config: { atlasBaseUrl: "/atlas", protocolRevision: "storybook" },
    snapshot: storySnapshot,
    catalog: storyCommandCatalog,
    health: storyHealth,
    submitCommand: async (submission: CommandSubmission) =>
      task(`storybook-${Date.now()}`, submission.entityId, "pending", submission.commandId, submission.parameters ?? {}, "Storybook command fixture", 0),
    updateGeometry: async (entityId, geometry) => {
      const entity = storySnapshot.entities[entityId];
      if (!entity) throw new Error(`Unknown fixture entity ${entityId}`);
      return { ...entity, components: { ...entity.components, geometry }, metadata: metadata(entity.metadata.version + 1) };
    },
    ...overrides
  };
}

function task(
  taskId: string,
  entityId: string,
  status: string,
  commandId: string,
  parameters: Record<string, JSONValue>,
  message: string,
  updatedMinutesAgo: number
): TaskResource {
  return {
    task_id: taskId,
    entity_id: entityId,
    status,
    components: {
      command: { id: commandId, type: commandId },
      parameters,
      status_message: message
    },
    metadata: { created_at: BASE_TIME, updated_at: minutesAgo(updatedMinutesAgo), version: updatedMinutesAgo + 1 }
  };
}
