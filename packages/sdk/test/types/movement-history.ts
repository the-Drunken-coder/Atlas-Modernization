import type { MovementSample, MovementSampleInput } from "../../src/index.js";

const position = { sample_id: "p", latitude: 1, longitude: 2 } satisfies MovementSampleInput;
const speed = { sample_id: "s", speed_m_s: 1 } satisfies MovementSampleInput;
const altitude = { sample_id: "a", altitude_m: 1 } satisfies MovementSampleInput;
// @ts-expect-error At least one quantity is required.
const empty = { sample_id: "empty" } satisfies MovementSampleInput;
// @ts-expect-error A scalar report cannot carry half a coordinate pair.
const partial = { sample_id: "partial", latitude: 1, speed_m_s: 2 } satisfies MovementSampleInput;
// @ts-expect-error Unknown fields are not accepted.
const typo = { sample_id: "typo", speed_m_s: 1, speeed_m_s: 2 } satisfies MovementSampleInput;
void [position, speed, altitude, empty, partial, typo];

const metadata = {
  sample_id: "report",
  received_at: "2026-09-10T12:00:00Z",
  time: "2026-09-10T12:00:00Z",
  time_is_arrival: true
};
const positionReport = { ...metadata, latitude: 1, longitude: 2 } satisfies MovementSample;
const speedReport = { ...metadata, speed_m_s: 0 } satisfies MovementSample;
const altitudeReport = { ...metadata, altitude_m: 0 } satisfies MovementSample;
const combinedReport = {
  ...metadata,
  latitude: 1,
  longitude: 2,
  speed_m_s: 0,
  altitude_m: 0
} satisfies MovementSample;
// @ts-expect-error Output reports also require at least one quantity.
const emptyReport = { ...metadata } satisfies MovementSample;
// @ts-expect-error Latitude requires longitude even with a scalar quantity.
const latitudeReport = { ...metadata, latitude: 1, speed_m_s: 2 } satisfies MovementSample;
// @ts-expect-error Longitude requires latitude even with a scalar quantity.
const longitudeReport = { ...metadata, longitude: 1, altitude_m: 2 } satisfies MovementSample;
// @ts-expect-error Output reports reject unknown fields.
const typoReport = { ...metadata, speed_m_s: 1, speeed_m_s: 2 } satisfies MovementSample;
void [
  positionReport,
  speedReport,
  altitudeReport,
  combinedReport,
  emptyReport,
  latitudeReport,
  longitudeReport,
  typoReport
];
