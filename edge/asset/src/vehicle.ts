import { ardupilotmega, minimal } from "node-mavlink";

function lookup(table: unknown, key: string): number {
  const value = (table as Record<string, number>)[key];
  if (typeof value !== "number") throw new Error(`Missing MAVLink constant ${key}`);
  return value;
}

export const ARDUPILOT_QUADROTOR_TYPE = lookup(minimal.MavType, "QUADROTOR");
export const ARDUPILOT_AUTOPILOT = lookup(minimal.MavAutopilot, "ARDUPILOTMEGA");
const ARMED_FLAG = lookup(minimal.MavModeFlag, "SAFETY_ARMED");
const GUIDED_MODE = lookup(ardupilotmega.CopterMode, "GUIDED");

const COPTER_MODE_NAMES = new Map<number, string>();
for (const [name, value] of Object.entries(ardupilotmega.CopterMode as unknown as Record<string, number | string>)) {
  if (typeof value === "number") COPTER_MODE_NAMES.set(value, name);
}

export function copterModeName(customMode: number): string {
  return COPTER_MODE_NAMES.get(customMode) ?? `UNKNOWN_${customMode}`;
}

export function isGuidedMode(customMode: number): boolean {
  return customMode === GUIDED_MODE;
}

export function isArmedBaseMode(baseMode: number): boolean {
  return (baseMode & ARMED_FLAG) !== 0;
}

export type VehicleIdentity = {
  systemId: number;
  componentId: number;
  vehicleType: number;
  autopilot: number;
};

export type VehicleObservation = {
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeMslM: number;
  relativeAltitudeM: number;
  groundSpeedMS: number;
  headingDeg: number;
  batteryRemainingPercent?: number;
  observedAtMs: number;
};

export type VehicleSnapshot = {
  identity?: VehicleIdentity;
  armed: boolean;
  mode: string;
  customMode?: number;
  guided: boolean;
  observation?: VehicleObservation;
  lastHeartbeatMs?: number;
  batteryRemainingPercent?: number;
  gcsFailsafeEnabled?: boolean;
  /** Verified launch elevation in meters above mean sea level. */
  launchElevationM?: number;
  launchElevationVerified: boolean;
};

export function emptySnapshot(): VehicleSnapshot {
  return { armed: false, mode: "UNKNOWN", guided: false, launchElevationVerified: false };
}

export type HeartbeatObservation = {
  systemId: number;
  componentId: number;
  vehicleType: number;
  autopilot: number;
  baseMode: number;
  customMode: number;
  receivedAtMs: number;
};

const LAUNCH_SAMPLES_REQUIRED = 3;
const LAUNCH_STABILITY_M = 0.5;

/**
 * Tracks ArduPilot vehicle state from MAVLink observations. Launch elevation
 * is verified from repeated consistent altitude samples while landed and
 * disarmed; it never updates once the aircraft is armed or airborne.
 */
export class VehicleTracker {
  private snapshot: VehicleSnapshot = emptySnapshot();
  private launchSamples: number[] = [];

  getSnapshot(): VehicleSnapshot {
    return this.snapshot;
  }

  observeHeartbeat(heartbeat: HeartbeatObservation): void {
    const mode = copterModeName(heartbeat.customMode);
    this.snapshot = {
      ...this.snapshot,
      identity: {
        systemId: heartbeat.systemId,
        componentId: heartbeat.componentId,
        vehicleType: heartbeat.vehicleType,
        autopilot: heartbeat.autopilot
      },
      armed: isArmedBaseMode(heartbeat.baseMode),
      mode,
      customMode: heartbeat.customMode,
      guided: isGuidedMode(heartbeat.customMode),
      lastHeartbeatMs: heartbeat.receivedAtMs
    };
    if (this.snapshot.armed) this.launchSamples = [];
  }

  observePosition(observation: VehicleObservation): void {
    this.snapshot = { ...this.snapshot, observation };
    if (observation.batteryRemainingPercent !== undefined) {
      this.snapshot = { ...this.snapshot, batteryRemainingPercent: observation.batteryRemainingPercent };
    }
    this.maybeVerifyLaunchElevation(observation);
  }

  observeSysStatus(batteryRemainingPercent: number | undefined): void {
    if (batteryRemainingPercent === undefined || batteryRemainingPercent < 0 || batteryRemainingPercent > 100) return;
    this.snapshot = { ...this.snapshot, batteryRemainingPercent };
  }

  observeGcsFailsafe(enabled: boolean): void {
    this.snapshot = { ...this.snapshot, gcsFailsafeEnabled: enabled };
  }

  heartbeatAgeMs(nowMs: number): number | undefined {
    if (this.snapshot.lastHeartbeatMs === undefined) return undefined;
    return nowMs - this.snapshot.lastHeartbeatMs;
  }

  positionAgeMs(nowMs: number): number | undefined {
    if (this.snapshot.observation === undefined) return undefined;
    return nowMs - this.snapshot.observation.observedAtMs;
  }

  private maybeVerifyLaunchElevation(observation: VehicleObservation): void {
    if (this.snapshot.launchElevationVerified || this.snapshot.armed) return;
    // Only trust samples that look landed: near-zero relative altitude.
    if (Math.abs(observation.relativeAltitudeM) > 0.5) {
      this.launchSamples = [];
      return;
    }
    this.launchSamples.push(observation.altitudeMslM);
    if (this.launchSamples.length < LAUNCH_SAMPLES_REQUIRED) return;
    const recent = this.launchSamples.slice(-LAUNCH_SAMPLES_REQUIRED);
    const min = Math.min(...recent);
    const max = Math.max(...recent);
    if (max - min <= LAUNCH_STABILITY_M) {
      const mean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
      this.snapshot = { ...this.snapshot, launchElevationM: mean, launchElevationVerified: true };
    }
  }
}
