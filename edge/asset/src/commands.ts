import { ardupilotmega, common } from "node-mavlink";

type CommandLongMessage = InstanceType<typeof common.CommandLong>;
type PositionTargetMessage = InstanceType<typeof common.SetPositionTargetGlobalInt>;
type ParamReadMessage = InstanceType<typeof common.ParamRequestRead>;

// Field names below are verified by commands.test.ts round-trips against the
// installed node-mavlink mappings (CommandLong params carry a leading
// underscore; GlobalPositionInt lives in the common dialect).

const MAV_CMD_NAV_TAKEOFF = common.MavCmd.NAV_TAKEOFF;
const MAV_CMD_NAV_RETURN_TO_LAUNCH = common.MavCmd.NAV_RETURN_TO_LAUNCH;
const MAV_CMD_NAV_LAND = common.MavCmd.NAV_LAND;
const MAV_CMD_DO_SET_MODE = common.MavCmd.DO_SET_MODE;
const MAV_FRAME_GLOBAL_INT = common.MavFrame.GLOBAL_INT;
const COPTER_MODE_GUIDED = ardupilotmega.CopterMode.GUIDED;
const COPTER_MODE_RTL = ardupilotmega.CopterMode.RTL;
const COPTER_MODE_LAND = ardupilotmega.CopterMode.LAND;

export const MAV_RESULT_ACCEPTED = common.MavResult.ACCEPTED;

export function commandAckAccepted(result: number): boolean {
  return result === MAV_RESULT_ACCEPTED;
}

function commandLong(targetSystem: number, targetComponent: number, command: number): CommandLongMessage {
  const message = new common.CommandLong();
  message.targetSystem = targetSystem;
  message.targetComponent = targetComponent;
  message.command = command;
  message.confirmation = 0;
  message._param1 = 0;
  message._param2 = 0;
  message._param3 = 0;
  message._param4 = 0;
  message._param5 = 0;
  message._param6 = 0;
  message._param7 = 0;
  return message;
}

/**
 * Guided takeoff. ArduCopter treats NAV_TAKEOFF param7 as height above home,
 * not mean sea level. Callers convert Task MSL altitude using verified launch
 * elevation before sending.
 */
export function takeoffCommand(
  targetSystem: number,
  targetComponent: number,
  heightAboveLaunchM: number
): CommandLongMessage {
  const message = commandLong(targetSystem, targetComponent, MAV_CMD_NAV_TAKEOFF);
  message._param7 = heightAboveLaunchM;
  return message;
}

/** Return to launch, land, and disarm (native mode transition). */
export function returnToLaunchCommand(targetSystem: number, targetComponent: number): CommandLongMessage {
  return commandLong(targetSystem, targetComponent, MAV_CMD_NAV_RETURN_TO_LAUNCH);
}

/** Land at the current location and disarm (native mode transition). */
export function landCommand(targetSystem: number, targetComponent: number): CommandLongMessage {
  return commandLong(targetSystem, targetComponent, MAV_CMD_NAV_LAND);
}

/** Request an ArduCopter mode by number (for example GUIDED for idle hold). */
export function setCopterModeCommand(targetSystem: number, targetComponent: number, mode: number): CommandLongMessage {
  const message = commandLong(targetSystem, targetComponent, MAV_CMD_DO_SET_MODE);
  message._param1 = 1; // MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
  message._param2 = mode;
  return message;
}

export function guidedModeNumber(): number {
  return COPTER_MODE_GUIDED;
}

export function rtlModeNumber(): number {
  return COPTER_MODE_RTL;
}

export function landModeNumber(): number {
  return COPTER_MODE_LAND;
}

// ArduPilot position-only mask: ignore vx/vy/vz, ax/ay/az, yaw, yaw rate.
const POSITION_ONLY_TYPE_MASK = 0x0df8;

function positionTarget(
  targetSystem: number,
  targetComponent: number,
  latitudeDeg: number,
  longitudeDeg: number,
  altitudeMslM: number,
  typeMask: number
): PositionTargetMessage {
  const message = new common.SetPositionTargetGlobalInt();
  message.timeBootMs = 0;
  message.targetSystem = targetSystem;
  message.targetComponent = targetComponent;
  message.coordinateFrame = MAV_FRAME_GLOBAL_INT;
  message.typeMask = typeMask;
  message.latInt = Math.round(latitudeDeg * 1e7);
  message.lonInt = Math.round(longitudeDeg * 1e7);
  message.alt = altitudeMslM;
  message.vx = 0;
  message.vy = 0;
  message.vz = 0;
  message.afx = 0;
  message.afy = 0;
  message.afz = 0;
  message.yaw = 0;
  message.yawRate = 0;
  return message;
}

/** Guided go-to destination: absolute position, altitude in meters MSL. */
export function gotoPositionCommand(
  targetSystem: number,
  targetComponent: number,
  latitudeDeg: number,
  longitudeDeg: number,
  altitudeMslM: number
): PositionTargetMessage {
  return positionTarget(
    targetSystem,
    targetComponent,
    latitudeDeg,
    longitudeDeg,
    altitudeMslM,
    POSITION_ONLY_TYPE_MASK
  );
}

/**
 * Active idle hold: re-target the current position so the aircraft stops at
 * the cancelled destination instead of continuing toward it. Merely ceasing
 * messages does not cancel a Guided destination.
 */
export function holdPositionCommand(
  targetSystem: number,
  targetComponent: number,
  latitudeDeg: number,
  longitudeDeg: number,
  altitudeMslM: number
): PositionTargetMessage {
  return positionTarget(
    targetSystem,
    targetComponent,
    latitudeDeg,
    longitudeDeg,
    altitudeMslM,
    POSITION_ONLY_TYPE_MASK
  );
}

/** Read one autopilot parameter by name (for example FS_GCS_ENABLE). */
export function paramReadCommand(targetSystem: number, targetComponent: number, paramId: string): ParamReadMessage {
  const message = new common.ParamRequestRead();
  message.targetSystem = targetSystem;
  message.targetComponent = targetComponent;
  message.paramId = paramId;
  message.paramIndex = -1;
  return message;
}

export function isCommonMessage(name: string): boolean {
  return (common as unknown as Record<string, unknown>)[name] !== undefined;
}
