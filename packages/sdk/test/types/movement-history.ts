import type { MovementSampleInput } from "../../src/index.js";

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
