import { randomUUID } from "node:crypto";
import type {
  CommandManifest,
  EntityCheckInTelemetry,
  EntityComponents,
  TaskFailureCode,
  TaskResource
} from "@the-drunken-coder/atlas-sdk";
import { AtlasClient } from "@the-drunken-coder/atlas-sdk";
import type { AssetConfig } from "./config.js";
import type { FailureCode } from "./task-engine.js";

export type { TaskResource };

/** The four production flight manifest entries this host advertises. */
export function flightManifest(): CommandManifest {
  return [
    {
      command: "flight.goto",
      description: "Fly to an absolute destination and hold position.",
      scheduling: "immediate",
      supports_cancel: true,
      supports_progress: false
    },
    {
      command: "flight.land",
      description: "Land at the current location and disarm.",
      scheduling: "immediate",
      supports_cancel: false,
      supports_progress: false
    },
    {
      command: "flight.return_to_launch",
      description: "Return to launch, land, and disarm.",
      scheduling: "immediate",
      supports_cancel: false,
      supports_progress: false
    },
    {
      command: "flight.takeoff",
      description: "Climb to the requested altitude and settle into a hover.",
      scheduling: "immediate",
      supports_cancel: false,
      supports_progress: false
    }
  ];
}

export type FlightTelemetry = {
  position?: {
    latitude: number;
    longitude: number;
    altitudeMslM: number;
    speedMS: number;
    headingDeg: number;
  };
  armed?: boolean;
  flightMode?: string;
  launchElevationM?: number;
  batteryRemainingPercent?: number;
};

function failureCodeFor(code: FailureCode): TaskFailureCode {
  return code === "precondition_failed" ? "precondition_failed" : "execution_failed";
}

/**
 * Core attachment for one Asset process. Every process uses a fresh runtime
 * identity so Core fences updates from previous processes and fails their
 * unfinished work on the next registration.
 */
export class CoreAttachment {
  readonly runtimeId = randomUUID();
  private readonly client: AtlasClient;
  private readonly assetId: string;

  constructor(config: AssetConfig, client?: AtlasClient) {
    this.assetId = config.assetId;
    this.client = client ?? new AtlasClient({ baseUrl: config.coreUrl, apiKey: config.apiKey, sync: false });
  }

  async begin(): Promise<void> {
    await this.client.runtime.begin(this.assetId, { runtime_id: this.runtimeId });
  }

  async ready(): Promise<void> {
    await this.client.runtime.ready(this.assetId, { runtime_id: this.runtimeId, manifest: flightManifest() });
  }

  /** Fresh authoritative task read for reconciliation. */
  async fetchTasks(): Promise<TaskResource[]> {
    const response = await this.client.runtime.tasks(this.assetId, { runtimeId: this.runtimeId });
    return response.tasks;
  }

  async getTask(taskId: string): Promise<TaskResource> {
    return this.client.tasks.get(taskId);
  }

  async reportStart(taskId: string): Promise<void> {
    const task = await this.client.tasks.start(taskId, { runtimeId: this.runtimeId });
    if (task.status !== "in_progress") {
      throw new Error(`Core did not grant execution for Task ${taskId}; authoritative status is ${task.status}.`);
    }
  }

  async reportProgress(taskId: string, progress: number): Promise<void> {
    await this.client.tasks.progress(taskId, { progress }, { runtimeId: this.runtimeId });
  }

  async reportComplete(taskId: string): Promise<void> {
    await this.client.tasks.complete(taskId, { runtimeId: this.runtimeId });
  }

  async reportFail(taskId: string, code: FailureCode, message: string): Promise<void> {
    await this.client.tasks.fail(taskId, {
      runtimeId: this.runtimeId,
      failure: { code: failureCodeFor(code), message }
    });
  }

  async checkin(telemetry: FlightTelemetry): Promise<void> {
    const flat: EntityCheckInTelemetry = {};
    if (telemetry.position !== undefined) {
      flat.latitude = telemetry.position.latitude;
      flat.longitude = telemetry.position.longitude;
      flat.altitude_m = telemetry.position.altitudeMslM;
      flat.speed_m_s = telemetry.position.speedMS;
      flat.heading_deg = telemetry.position.headingDeg;
    }
    // Flat fields feed both movement history and Core's telemetry component.
    // Only Asset-specific flight state belongs in the explicit component.
    const flight: NonNullable<EntityComponents["telemetry"]> = {};
    if (telemetry.armed !== undefined) flight.armed = telemetry.armed;
    if (telemetry.flightMode !== undefined) flight.flight_mode = telemetry.flightMode;
    if (telemetry.launchElevationM !== undefined) {
      flight.launch_elevation_m = telemetry.launchElevationM;
    }
    const components: EntityComponents = {};
    if (Object.keys(flight).length > 0) components.telemetry = flight;
    if (telemetry.batteryRemainingPercent !== undefined) {
      components.health = { battery_percent: telemetry.batteryRemainingPercent };
    }
    if (Object.keys(components).length > 0) {
      await this.client.entities.checkIn(this.assetId, {
        telemetry: flat,
        components
      });
    } else {
      await this.client.entities.checkIn(this.assetId, { telemetry: flat });
    }
  }
}

/** Test seam for the controller: the Core operations one host process uses. */
export type CoreGateway = {
  begin(): Promise<void>;
  ready(): Promise<void>;
  fetchTasks(): Promise<TaskResource[]>;
  getTask(taskId: string): Promise<TaskResource>;
  reportStart(taskId: string): Promise<void>;
  reportProgress(taskId: string, progress: number): Promise<void>;
  reportComplete(taskId: string): Promise<void>;
  reportFail(taskId: string, code: FailureCode, message: string): Promise<void>;
  checkin(telemetry: FlightTelemetry): Promise<void>;
};
