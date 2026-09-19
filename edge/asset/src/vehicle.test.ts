import { describe, expect, it } from "vitest";
import { emptySnapshot, hasFreshControlTelemetry, VehicleTracker } from "./vehicle.js";

describe("VehicleTracker", () => {
  it("builds a snapshot from HEARTBEAT, GLOBAL_POSITION_INT, and SYS_STATUS", () => {
    const tracker = new VehicleTracker();
    expect(tracker.getSnapshot()).toEqual(emptySnapshot());

    tracker.observeHeartbeat({
      systemId: 1,
      componentId: 1,
      vehicleType: 2,
      autopilot: 3,
      baseMode: 128,
      customMode: 4,
      receivedAtMs: 1_000
    });
    tracker.observePosition({
      latitudeDeg: 37.7749,
      longitudeDeg: -122.4194,
      altitudeMslM: 560.2,
      relativeAltitudeM: 0.1,
      groundSpeedMS: 0.2,
      headingDeg: 90,
      observedAtMs: 1_100
    });
    tracker.observeSysStatus(78);

    const snapshot = tracker.getSnapshot();
    expect(snapshot.armed).toBe(true);
    expect(snapshot.mode).toBe("GUIDED");
    expect(snapshot.guided).toBe(true);
    expect(snapshot.identity).toEqual({
      systemId: 1,
      componentId: 1,
      vehicleType: 2,
      autopilot: 3
    });
    expect(snapshot.observation?.latitudeDeg).toBeCloseTo(37.7749, 5);
    expect(snapshot.observation?.longitudeDeg).toBeCloseTo(-122.4194, 5);
    expect(snapshot.observation?.altitudeMslM).toBeCloseTo(560.2, 5);
    expect(snapshot.batteryRemainingPercent).toBe(78);
  });

  it("verifies launch elevation only from stable samples while landed and disarmed", () => {
    const tracker = new VehicleTracker();
    tracker.observeHeartbeat({
      systemId: 1,
      componentId: 1,
      vehicleType: 2,
      autopilot: 3,
      baseMode: 0,
      customMode: 0,
      receivedAtMs: 1_000
    });

    for (const altitude of [560.0, 560.1, 560.2]) {
      tracker.observePosition({
        latitudeDeg: 37.77,
        longitudeDeg: -122.42,
        altitudeMslM: altitude,
        relativeAltitudeM: 0.05,
        groundSpeedMS: 0,
        headingDeg: 0,
        observedAtMs: 1_000 + altitude * 10
      });
    }

    const verified = tracker.getSnapshot();
    expect(verified.launchElevationVerified).toBe(true);
    expect(verified.launchElevationM).toBeCloseTo(560.1, 5);
    expect(verified.launchLatitudeDeg).toBeCloseTo(37.77, 5);
    expect(verified.launchLongitudeDeg).toBeCloseTo(-122.42, 5);

    // Armed aircraft never retarget launch elevation.
    tracker.observeHeartbeat({
      systemId: 1,
      componentId: 1,
      vehicleType: 2,
      autopilot: 3,
      baseMode: 128,
      customMode: 4,
      receivedAtMs: 2_000
    });
    tracker.observePosition({
      latitudeDeg: 37.77,
      longitudeDeg: -122.42,
      altitudeMslM: 590,
      relativeAltitudeM: 30,
      groundSpeedMS: 1,
      headingDeg: 10,
      observedAtMs: 2_100
    });
    expect(tracker.getSnapshot().launchElevationM).toBeCloseTo(560.1, 5);
  });

  it("rejects unstable or airborne samples for launch elevation", () => {
    const tracker = new VehicleTracker();
    tracker.observeHeartbeat({
      systemId: 1,
      componentId: 1,
      vehicleType: 2,
      autopilot: 3,
      baseMode: 0,
      customMode: 0,
      receivedAtMs: 1_000
    });
    tracker.observePosition({
      latitudeDeg: 37.77,
      longitudeDeg: -122.42,
      altitudeMslM: 560,
      relativeAltitudeM: 2,
      groundSpeedMS: 0,
      headingDeg: 0,
      observedAtMs: 1_100
    });
    expect(tracker.getSnapshot().launchElevationVerified).toBe(false);

    tracker.observePosition({
      latitudeDeg: 37.77,
      longitudeDeg: -122.42,
      altitudeMslM: 560,
      relativeAltitudeM: 0,
      groundSpeedMS: 0,
      headingDeg: 0,
      observedAtMs: 1_200
    });
    tracker.observePosition({
      latitudeDeg: 37.77,
      longitudeDeg: -122.42,
      altitudeMslM: 565,
      relativeAltitudeM: 0,
      groundSpeedMS: 0,
      headingDeg: 0,
      observedAtMs: 1_300
    });
    tracker.observePosition({
      latitudeDeg: 37.77,
      longitudeDeg: -122.42,
      altitudeMslM: 560,
      relativeAltitudeM: 0,
      groundSpeedMS: 0,
      headingDeg: 0,
      observedAtMs: 1_400
    });
    expect(tracker.getSnapshot().launchElevationVerified).toBe(false);
  });

  it("ignores invalid SYS_STATUS battery readings", () => {
    const tracker = new VehicleTracker();
    tracker.observeSysStatus(-1);
    tracker.observeSysStatus(140);
    expect(tracker.getSnapshot().batteryRemainingPercent).toBeUndefined();
    tracker.observeSysStatus(55);
    expect(tracker.getSnapshot().batteryRemainingPercent).toBe(55);
  });

  it("requires both known, fresh control telemetry streams", () => {
    const position = {
      latitudeDeg: 0,
      longitudeDeg: 0,
      altitudeMslM: 0,
      relativeAltitudeM: 0,
      groundSpeedMS: 0,
      headingDeg: 0,
      observedAtMs: 0
    };
    expect(hasFreshControlTelemetry(emptySnapshot(), 10_000)).toBe(false);
    expect(
      hasFreshControlTelemetry(
        {
          ...emptySnapshot(),
          lastHeartbeatMs: 7_000,
          observation: position
        },
        10_000
      )
    ).toBe(true);
    expect(
      hasFreshControlTelemetry(
        {
          ...emptySnapshot(),
          lastHeartbeatMs: 6_999,
          observation: position
        },
        10_000
      )
    ).toBe(false);
    expect(
      hasFreshControlTelemetry(
        {
          ...emptySnapshot(),
          lastHeartbeatMs: 7_001,
          observation: position
        },
        10_001
      )
    ).toBe(false);
  });
});
