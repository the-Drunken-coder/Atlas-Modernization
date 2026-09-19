import type { AssetConfig } from "./config.js";
import { ARDUPILOT_AUTOPILOT, ARDUPILOT_QUADROTOR_TYPE, type VehicleSnapshot } from "./vehicle.js";

export type ReadinessFailure = {
  check: string;
  message: string;
};

export type Readiness = { ready: boolean; failures: ReadinessFailure[] };

const HEARTBEAT_FRESH_MS = 3000;
const POSITION_FRESH_MS = 5000;

/**
 * Flight readiness: the host accepts flight Tasks only when every check
 * passes. Failures carry actionable messages so an operator can correct the
 * aircraft or radio setup before tasking. A restarted process additionally
 * requires landed and disarmed state (see controller), which this pure check
 * does not encode.
 */
export function checkFlightReadiness(snapshot: VehicleSnapshot, config: AssetConfig, nowMs: number): Readiness {
  const failures: ReadinessFailure[] = [];

  if (snapshot.identity === undefined) {
    failures.push({ check: "vehicle-link", message: "No MAVLink heartbeat received. Check the SiK radio connection." });
  } else {
    if (snapshot.lastHeartbeatMs === undefined || nowMs - snapshot.lastHeartbeatMs > HEARTBEAT_FRESH_MS) {
      failures.push({
        check: "vehicle-link",
        message: "MAVLink heartbeat is stale. Check the SiK radio connection."
      });
    }
    if (
      snapshot.identity.systemId !== config.vehicleSystemId ||
      snapshot.identity.componentId !== config.vehicleComponentId
    ) {
      failures.push({
        check: "vehicle-identity",
        message: `Connected vehicle ${snapshot.identity.systemId}/${snapshot.identity.componentId} does not match configured ${config.vehicleSystemId}/${config.vehicleComponentId}. Reconnect the expected aircraft.`
      });
    }
    if (snapshot.identity.vehicleType !== ARDUPILOT_QUADROTOR_TYPE) {
      failures.push({
        check: "vehicle-type",
        message: `Connected vehicle type ${snapshot.identity.vehicleType} is not a quadcopter. This host supports ArduCopter quadcopters only.`
      });
    }
    if (snapshot.identity.autopilot !== ARDUPILOT_AUTOPILOT) {
      failures.push({
        check: "autopilot",
        message: `Connected autopilot ${snapshot.identity.autopilot} is not ArduPilot. This host supports ArduCopter only.`
      });
    }
  }

  if (snapshot.observation === undefined || nowMs - snapshot.observation.observedAtMs > POSITION_FRESH_MS) {
    failures.push({ check: "position", message: "No fresh position observation. Wait for GPS lock." });
  }

  if (snapshot.gcsFailsafeEnabled === false) {
    failures.push({
      check: "gcs-failsafe",
      message:
        "Onboard GCS failsafe is disabled (FS_GCS_ENABLE=0). Host or SiK loss relies on onboard heartbeat-loss behavior; enable the failsafe in the autopilot configuration."
    });
  }

  if (snapshot.batteryRemainingPercent !== undefined && snapshot.batteryRemainingPercent < config.minBatteryPercent) {
    failures.push({
      check: "battery",
      message: `Battery ${snapshot.batteryRemainingPercent}% is below the ${config.minBatteryPercent}% minimum.`
    });
  }

  if (!snapshot.launchElevationVerified || snapshot.launchElevationM === undefined) {
    failures.push({
      check: "launch-elevation",
      message: "Launch elevation is not verified. Keep the aircraft landed and disarmed until telemetry stabilizes."
    });
  }

  return { ready: failures.length === 0, failures };
}
