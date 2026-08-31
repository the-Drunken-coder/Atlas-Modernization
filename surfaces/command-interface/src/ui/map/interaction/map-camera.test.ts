import { describe, expect, it } from "vitest";
import type { UiRawGeometry } from "../../../atlas/geometry.js";
import {
  type CameraView,
  COMMIT_FIT_MAX_ZOOM,
  coordsChanged,
  FIT_BOUNDS_PADDING,
  FIT_DURATION_MS,
  FIT_MAX_ZOOM,
  FLY_MAX_DURATION_MS,
  FLY_MIN_DURATION_MS,
  type FollowState,
  flyDurationMs,
  followIdle,
  followReducer,
  PREVIEW_DURATION_MS,
  PREVIEW_FIT_BOUNDS_PADDING,
  PREVIEW_FIT_MAX_ZOOM,
  PREVIEW_POINT_ZOOM,
  planFocusMove,
  previewEasing
} from "./map-camera.js";

const view = (center: [number, number], zoom: number): CameraView => ({ center, zoom });

describe("planFocusMove", () => {
  it("flies points to the standard asset view zoom when zoomed out", () => {
    const move = planFocusMove({ type: "Point", coordinates: [70, 80] }, view([0, 0], 4));
    expect(move).toMatchObject({ kind: "fly-to", center: [70, 80], zoom: 15 });
  });

  it("flies points down to the asset view zoom when zoomed in past it", () => {
    const move = planFocusMove({ type: "Point", coordinates: [70, 80] }, view([70, 80], 15));
    expect(move).toMatchObject({ kind: "fly-to", zoom: 15 });
  });

  it("uses a wider point view for previews", () => {
    const move = planFocusMove({ type: "Point", coordinates: [0.01, 0.01] }, view([0, 0], 13), "preview");
    expect(move).toMatchObject({
      kind: "fly-to",
      center: [0.01, 0.01],
      zoom: PREVIEW_POINT_ZOOM,
      durationMs: PREVIEW_DURATION_MS
    });
  });

  it("fits line geometry bounds with the standard padding and cap", () => {
    const move = planFocusMove(
      {
        type: "LineString",
        coordinates: [
          [10, 20],
          [30, 5]
        ]
      },
      view([0, 0], 4)
    );
    expect(move).toEqual({
      kind: "fit-bounds",
      bounds: [
        [10, 5],
        [30, 20]
      ],
      maxZoom: FIT_MAX_ZOOM,
      padding: FIT_BOUNDS_PADDING,
      durationMs: FIT_DURATION_MS
    });
  });

  it("fits all polygons in a multipolygon target", () => {
    const move = planFocusMove(
      {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [10, 20],
              [12, 20],
              [12, 22],
              [10, 20]
            ]
          ],
          [
            [
              [30, 5],
              [32, 5],
              [32, 7],
              [30, 5]
            ]
          ]
        ]
      },
      view([0, 0], 4),
      "commit"
    );

    expect(move).toMatchObject({
      kind: "fit-bounds",
      bounds: [
        [10, 5],
        [32, 22]
      ],
      maxZoom: COMMIT_FIT_MAX_ZOOM
    });
  });

  it("fits a polygon across the antimeridian by the short interval", () => {
    const move = planFocusMove(
      {
        type: "Polygon",
        coordinates: [
          [
            [179, 10],
            [-179, 10],
            [-179, 12],
            [179, 10]
          ]
        ]
      },
      view([180, 11], 4)
    );

    expect(move).toMatchObject({
      kind: "fit-bounds",
      bounds: [
        [179, 10],
        [181, 12]
      ]
    });
  });

  it("fits every polygon in an antimeridian multipolygon by the short interval", () => {
    const move = planFocusMove(
      {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [178, 10],
              [179, 10],
              [179, 11],
              [178, 10]
            ]
          ],
          [
            [
              [-179, 12],
              [-178, 12],
              [-178, 13],
              [-179, 12]
            ]
          ]
        ]
      },
      view([180, 11], 4)
    );

    expect(move).toMatchObject({
      kind: "fit-bounds",
      bounds: [
        [178, 10],
        [182, 13]
      ]
    });
  });

  it("returns null for empty geometry", () => {
    expect(planFocusMove({ type: "LineString", coordinates: [] }, view([0, 0], 4))).toBeNull();
  });

  it("fits preview geometry loosely and committed geometry tightly", () => {
    const geometry: UiRawGeometry = {
      type: "LineString",
      coordinates: [
        [10, 20],
        [30, 5]
      ]
    };

    expect(planFocusMove(geometry, view([0, 0], 4), "preview")).toMatchObject({
      kind: "fit-bounds",
      maxZoom: PREVIEW_FIT_MAX_ZOOM,
      padding: PREVIEW_FIT_BOUNDS_PADDING,
      durationMs: PREVIEW_DURATION_MS
    });
    expect(planFocusMove(geometry, view([0, 0], 4), "commit")).toMatchObject({
      kind: "fit-bounds",
      maxZoom: COMMIT_FIT_MAX_ZOOM,
      padding: FIT_BOUNDS_PADDING
    });
  });
});

describe("previewEasing", () => {
  it("starts and ends slowly while preserving the endpoints", () => {
    expect(previewEasing(0)).toBe(0);
    expect(previewEasing(0.25)).toBeLessThan(0.25);
    expect(previewEasing(0.5)).toBe(0.5);
    expect(previewEasing(0.75)).toBeGreaterThan(0.75);
    expect(previewEasing(1)).toBe(1);
  });
});

describe("flyDurationMs", () => {
  it("clamps short hops to the minimum duration", () => {
    expect(flyDurationMs(view([0, 0], 12), view([0, 0], 12))).toBe(FLY_MIN_DURATION_MS);
    expect(flyDurationMs(view([0, 0], 12), view([0.01, 0.01], 12))).toBeLessThan(FLY_MIN_DURATION_MS + 10);
  });

  it("clamps cross-world jumps to the maximum duration", () => {
    expect(flyDurationMs(view([-170, -60], 2), view([170, 70], 16))).toBe(FLY_MAX_DURATION_MS);
  });

  it("grows with distance", () => {
    const near = flyDurationMs(view([0, 0], 12), view([5, 0], 12));
    const far = flyDurationMs(view([0, 0], 12), view([15, 0], 12));
    expect(far).toBeGreaterThan(near);
  });

  it("grows with zoom delta", () => {
    const shallow = flyDurationMs(view([0, 0], 11), view([1, 0], 12));
    const deep = flyDurationMs(view([0, 0], 2), view([1, 0], 12));
    expect(deep).toBeGreaterThan(shallow);
  });

  it("measures longitude across the antimeridian by the short way", () => {
    const wrapped = flyDurationMs(view([179, 0], 12), view([-179, 0], 12));
    expect(wrapped).toBe(flyDurationMs(view([0, 0], 12), view([2, 0], 12)));
  });
});

describe("coordsChanged", () => {
  it("ignores sub-epsilon jitter", () => {
    expect(coordsChanged([10, 20], [10 + 1e-9, 20 - 1e-9])).toBe(false);
  });

  it("detects real movement", () => {
    expect(coordsChanged([10, 20], [10.001, 20])).toBe(true);
  });
});

describe("followReducer", () => {
  const pending: FollowState = { phase: "pending", seq: 1, entityId: "a" };
  const flying: FollowState = { phase: "flying", seq: 1, entityId: "a" };
  const following: FollowState = { phase: "following", seq: 1, entityId: "a" };

  it("starts flying on a point command from any phase", () => {
    for (const state of [followIdle, pending, flying, following]) {
      expect(followReducer(state, { type: "command-point", seq: 2, entityId: "b" })).toEqual({
        phase: "flying",
        seq: 2,
        entityId: "b"
      });
    }
  });

  it("returns to idle on geometry commands and cleared commands", () => {
    for (const state of [followIdle, pending, flying, following]) {
      expect(followReducer(state, { type: "command-geometry", seq: 2 })).toEqual(followIdle);
      expect(followReducer(state, { type: "command-cleared" })).toEqual(followIdle);
    }
  });

  it("parks unlocatable targets in pending", () => {
    expect(followReducer(followIdle, { type: "command-pending", seq: 2, entityId: "b" })).toEqual({
      phase: "pending",
      seq: 2,
      entityId: "b"
    });
  });

  it("promotes flying to following when the matching fly completes", () => {
    expect(followReducer(flying, { type: "fly-complete", seq: 1 })).toEqual(following);
  });

  it("ignores stale fly completions", () => {
    expect(followReducer(flying, { type: "fly-complete", seq: 0 })).toEqual(flying);
    expect(followReducer(followIdle, { type: "fly-complete", seq: 1 })).toEqual(followIdle);
    expect(followReducer(following, { type: "fly-complete", seq: 1 })).toEqual(following);
  });

  it("drops flight and follow on user gestures", () => {
    expect(followReducer(flying, { type: "user-gesture" })).toEqual(followIdle);
    expect(followReducer(following, { type: "user-gesture" })).toEqual(followIdle);
    expect(followReducer(followIdle, { type: "user-gesture" })).toEqual(followIdle);
  });

  it("keeps a pending retry alive through user gestures", () => {
    expect(followReducer(pending, { type: "user-gesture" })).toEqual(pending);
  });
});
