import { common, type MavLinkData, MavLinkProtocolV2, minimal } from "node-mavlink";
import { describe, expect, it } from "vitest";
import {
  commandAckAccepted,
  gotoPositionCommand,
  guidedModeNumber,
  holdPositionCommand,
  landCommand,
  landModeNumber,
  paramReadCommand,
  returnToLaunchCommand,
  rtlModeNumber,
  setCopterModeCommand,
  takeoffCommand
} from "./commands.js";

const protocol = new MavLinkProtocolV2(255, 190);

function roundTrip<T extends MavLinkData>(message: MavLinkData, clazz: { MSG_ID: number } & (new () => T)): T {
  const buffer = protocol.serialize(message, 0);
  const header = protocol.header(buffer);
  expect(header.msgid).toBe(clazz.MSG_ID);
  return protocol.data(protocol.payload(buffer), clazz as never) as T;
}

describe("flight command encoding", () => {
  it("encodes takeoff height above launch, not mean sea level", () => {
    const decoded = roundTrip(takeoffCommand(1, 1, 10), common.CommandLong);
    expect(decoded.command).toBe(common.MavCmd.NAV_TAKEOFF);
    expect(decoded._param7).toBeCloseTo(10, 5);
    expect(decoded.targetSystem).toBe(1);
  });

  it("encodes RTL and land as mode-changing commands", () => {
    expect(roundTrip(returnToLaunchCommand(1, 1), common.CommandLong).command).toBe(common.MavCmd.NAV_RETURN_TO_LAUNCH);
    expect(roundTrip(landCommand(1, 1), common.CommandLong).command).toBe(common.MavCmd.NAV_LAND);
    expect(rtlModeNumber()).toBe(6);
    expect(landModeNumber()).toBe(9);
    expect(guidedModeNumber()).toBe(4);
  });

  it("encodes go-to and hold as absolute global-int position targets", () => {
    const decoded = roundTrip(gotoPositionCommand(1, 1, 37.7749, -122.4194, 590), common.SetPositionTargetGlobalInt);
    expect(decoded.latInt).toBe(Math.round(37.7749 * 1e7));
    expect(decoded.lonInt).toBe(Math.round(-122.4194 * 1e7));
    expect(decoded.alt).toBe(590);
    expect(decoded.typeMask).toBe(0x0df8);
    const held = roundTrip(holdPositionCommand(1, 1, 37.1, -122.1, 580), common.SetPositionTargetGlobalInt);
    expect(held.latInt).toBe(Math.round(37.1 * 1e7));
  });

  it("encodes mode changes with the custom-mode flag", () => {
    const decoded = roundTrip(setCopterModeCommand(1, 1, 4), common.CommandLong);
    expect(decoded.command).toBe(common.MavCmd.DO_SET_MODE);
    expect(decoded._param1).toBe(1);
    expect(decoded._param2).toBe(4);
  });

  it("encodes parameter reads by name and accepts ACK results", () => {
    const decoded = roundTrip(paramReadCommand(1, 1, "FS_GCS_ENABLE"), common.ParamRequestRead);
    expect(decoded.paramId).toBe("FS_GCS_ENABLE");
    expect(commandAckAccepted(common.MavResult.ACCEPTED)).toBe(true);
    expect(commandAckAccepted(common.MavResult.DENIED)).toBe(false);
  });

  it("decodes heartbeats and global positions with the link registry fields", () => {
    const heartbeat = new minimal.Heartbeat();
    heartbeat.customMode = 4;
    heartbeat.baseMode = 128;
    const decodedHeartbeat = roundTrip(heartbeat, minimal.Heartbeat);
    expect(decodedHeartbeat.customMode).toBe(4);
    expect(decodedHeartbeat.baseMode).toBe(128);

    const position = new common.GlobalPositionInt();
    position.lat = Math.round(37.7749 * 1e7);
    position.lon = Math.round(-122.4194 * 1e7);
    position.alt = Math.round(590 * 1000);
    position.relativeAlt = 2500;
    const decodedPosition = roundTrip(position, common.GlobalPositionInt);
    expect(decodedPosition.alt).toBe(Math.round(590 * 1000));
    expect(decodedPosition.relativeAlt).toBe(2500);
  });
});
