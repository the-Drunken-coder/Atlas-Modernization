import type { Position, UiRawGeometry } from "../../atlas/geometry.js";
import type { MapFeature, MapSources } from "./map-sources.js";

/**
 * Camera targets mirror reticle targets: a live entity resolved against the
 * current sources, or a literal point/geometry (e.g. future search results).
 */
export type MapTarget =
  | { type: "entity"; id: string }
  | { type: "point"; id: string; coordinates: [number, number]; label?: string }
  | { type: "geometry"; id: string; geometry: UiRawGeometry; label?: string };

/**
 * Explicit camera intent. `seq` is monotonic so re-issuing a command for the
 * same target (e.g. re-clicking a sidebar row) still moves the camera.
 */
export type MapCameraCommand = { seq: number; target: MapTarget };

export const ASSET_VIEW_ZOOM = 13;
export const FIT_MAX_ZOOM = 10;
export const FIT_BOUNDS_PADDING = 48;
export const FIT_DURATION_MS = 450;
export const FLY_MIN_DURATION_MS = 600;
export const FLY_MAX_DURATION_MS = 1500;
export const FOLLOW_EASE_MS = 300;
export const FOLLOW_EPSILON_DEG = 1e-7;
export const CAMERA_EVENT_TAG = "atlasCamera";
export const INITIAL_WORLD_BOUNDS: [[number, number], [number, number]] = [
  [-180, -80],
  [180, 85.051129]
];

export type CameraView = { center: [number, number]; zoom: number };

export type CameraMove =
  | { kind: "fly-to"; center: [number, number]; zoom: number; durationMs: number }
  | {
      kind: "fit-bounds";
      bounds: [[number, number], [number, number]];
      maxZoom: number;
      padding: number;
      durationMs: number;
    };

/**
 * Plan the camera move for a resolved geometry. Points always fly to the
 * standard asset view zoom (in or out); lines/polygons fit their bounds.
 */
export function planFocusMove(geometry: UiRawGeometry, view: CameraView): CameraMove | null {
  if (geometry.type === "Point") {
    if (!isLngLatPosition(geometry.coordinates)) return null;
    const center: [number, number] = [geometry.coordinates[0], geometry.coordinates[1]];
    return {
      kind: "fly-to",
      center,
      zoom: ASSET_VIEW_ZOOM,
      durationMs: flyDurationMs(view, { center, zoom: ASSET_VIEW_ZOOM })
    };
  }
  const bounds = boundsForGeometry(geometry);
  if (!bounds) return null;
  return {
    kind: "fit-bounds",
    bounds,
    maxZoom: FIT_MAX_ZOOM,
    padding: FIT_BOUNDS_PADDING,
    durationMs: FIT_DURATION_MS
  };
}

/**
 * Arc-flight duration scaling with distance and zoom change, clamped so short
 * hops stay snappy and cross-world jumps stay bounded.
 */
export function flyDurationMs(from: CameraView, to: CameraView): number {
  const lngDelta = Math.abs(wrapLngDelta(to.center[0] - from.center[0]));
  const latDelta = Math.abs(to.center[1] - from.center[1]);
  const distanceDeg = Math.hypot(lngDelta, latDelta);
  const zoomDelta = Math.abs(to.zoom - from.zoom);
  const duration = FLY_MIN_DURATION_MS + 40 * distanceDeg + 120 * zoomDelta;
  return Math.min(FLY_MAX_DURATION_MS, Math.max(FLY_MIN_DURATION_MS, Math.round(duration)));
}

function wrapLngDelta(delta: number): number {
  return ((((delta + 180) % 360) + 360) % 360) - 180;
}

export function geometryForTarget(sources: MapSources, target: MapTarget): UiRawGeometry | undefined {
  if (target.type === "point") return { type: "Point", coordinates: target.coordinates };
  if (target.type === "geometry") return target.geometry;
  return featureForEntityId(sources, target.id)?.geometry;
}

export function featureForEntityId(sources: MapSources, entityId: string): MapFeature | undefined {
  return [...sources.assets.features, ...sources.tracks.features, ...sources.geofeatures.features].find(
    (feature) => feature.properties.entityId === entityId
  );
}

export function boundsForGeometry(geometry: UiRawGeometry): [[number, number], [number, number]] | null {
  const positions = collectLngLatPositions(geometry.coordinates);
  if (positions.length === 0) return null;
  const lngValues = positions.map((position) => position[0]);
  const latValues = positions.map((position) => position[1]);
  return [
    [Math.min(...lngValues), Math.min(...latValues)],
    [Math.max(...lngValues), Math.max(...latValues)]
  ];
}

export function collectLngLatPositions(value: unknown): Position[] {
  if (isLngLatPosition(value)) return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap(collectLngLatPositions);
}

export function isLngLatPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

export function coordsChanged(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) > FOLLOW_EPSILON_DEG || Math.abs(a[1] - b[1]) > FOLLOW_EPSILON_DEG;
}

/**
 * Soft-follow state machine. A sidebar command flies to a point entity and
 * then follows it as telemetry moves; any user gesture drops back to idle.
 * `pending` covers a selected entity that is not yet locatable — it survives
 * user gestures so the fly still happens when data arrives.
 */
export type FollowState =
  | { phase: "idle" }
  | { phase: "pending"; seq: number; entityId: string }
  | { phase: "flying"; seq: number; entityId: string }
  | { phase: "following"; seq: number; entityId: string };

export type FollowEvent =
  | { type: "command-point"; seq: number; entityId: string }
  | { type: "command-geometry"; seq: number }
  | { type: "command-pending"; seq: number; entityId: string }
  | { type: "command-cleared" }
  | { type: "fly-complete"; seq: number }
  | { type: "user-gesture" };

export const followIdle: FollowState = { phase: "idle" };

export function followReducer(state: FollowState, event: FollowEvent): FollowState {
  switch (event.type) {
    case "command-point":
      return { phase: "flying", seq: event.seq, entityId: event.entityId };
    case "command-geometry":
      return followIdle;
    case "command-pending":
      return { phase: "pending", seq: event.seq, entityId: event.entityId };
    case "command-cleared":
      return followIdle;
    case "fly-complete":
      if (state.phase === "flying" && state.seq === event.seq) {
        return { phase: "following", seq: state.seq, entityId: state.entityId };
      }
      return state;
    case "user-gesture":
      // A gesture cancels flight/follow but not a pending retry: the user has
      // asked for an entity the feed has not located yet.
      return state.phase === "pending" ? state : followIdle;
    default:
      return state;
  }
}
