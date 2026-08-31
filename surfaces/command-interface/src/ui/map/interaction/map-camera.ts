import type { Position, UiRawGeometry } from "../../../atlas/geometry.js";
import type { MapFeature, MapSources } from "../rendering/map-sources.js";

/**
 * Camera targets mirror reticle targets: a live entity resolved against the
 * current sources, or a literal point/geometry such as a place search result.
 */
export type MapTarget =
  | { type: "entity"; id: string }
  | { type: "point"; id: string; coordinates: [number, number]; label?: string; reticleSize?: number }
  | { type: "geometry"; id: string; geometry: UiRawGeometry; label?: string };

/**
 * Explicit camera intent. `seq` is monotonic so re-issuing a command for the
 * same target (e.g. re-clicking a sidebar row) still moves the camera.
 */
export type MapCameraCommand =
  | { seq: number; intent: "world" }
  | { seq: number; target: MapTarget; intent?: "focus" | "preview" | "commit" };

export const ASSET_VIEW_ZOOM = 15;
export const FIT_MAX_ZOOM = 10;
export const FIT_BOUNDS_PADDING = 48;
export const FIT_DURATION_MS = 450;
export const PREVIEW_POINT_ZOOM = 13;
export const PREVIEW_FIT_MAX_ZOOM = 14;
export const PREVIEW_FIT_BOUNDS_PADDING = 80;
export const PREVIEW_DURATION_MS = 900;
export const COMMIT_FIT_MAX_ZOOM = 16;
export const PREVIEW_RESTORE_MS = 1200;
export const RETICLE_FLASH_MS = 240;
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
 * Plan the camera move for a resolved geometry. Preview moves leave more
 * context around the target; committed place moves use the tighter view.
 */
export function planFocusMove(
  geometry: UiRawGeometry,
  view: CameraView,
  intent: "focus" | "preview" | "commit" = "focus"
): CameraMove | null {
  if (geometry.type === "Point") {
    if (!isLngLatPosition(geometry.coordinates)) return null;
    const center: [number, number] = [geometry.coordinates[0], geometry.coordinates[1]];
    const zoom = intent === "preview" ? PREVIEW_POINT_ZOOM : ASSET_VIEW_ZOOM;
    return {
      kind: "fly-to",
      center,
      zoom,
      durationMs:
        intent === "preview"
          ? Math.max(PREVIEW_DURATION_MS, flyDurationMs(view, { center, zoom }))
          : flyDurationMs(view, { center, zoom })
    };
  }
  const bounds = boundsForGeometry(geometry);
  if (!bounds) return null;
  return {
    kind: "fit-bounds",
    bounds,
    maxZoom: intent === "focus" ? FIT_MAX_ZOOM : intent === "preview" ? PREVIEW_FIT_MAX_ZOOM : COMMIT_FIT_MAX_ZOOM,
    padding: intent === "preview" ? PREVIEW_FIT_BOUNDS_PADDING : FIT_BOUNDS_PADDING,
    durationMs: intent === "preview" ? PREVIEW_DURATION_MS : FIT_DURATION_MS
  };
}

/** Smooth camera previews at both ends so tiles have time to catch up. */
export function previewEasing(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
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
  const [west, east] = minimumLongitudeInterval(positions.map((position) => position[0]));
  const latValues = positions.map((position) => position[1]);
  return [
    [west, Math.min(...latValues)],
    [east, Math.max(...latValues)]
  ];
}

/** True when a geometry continues past the canonical world to cross the date line. */
export function geometryUsesUnwrappedLongitudes(geometry: UiRawGeometry): boolean {
  const positions = collectLngLatPositions(geometry.coordinates);
  if (positions.some(([longitude]) => longitude < -180 || longitude > 180)) return true;
  if (positions.length === 0) return false;
  const [west, east] = minimumLongitudeInterval(positions.map(([longitude]) => longitude));
  return west < -180 || east > 180;
}

function minimumLongitudeInterval(longitudes: number[]): [west: number, east: number] {
  const canonicalWest = Math.min(...longitudes);
  const canonicalEast = Math.max(...longitudes);
  if (canonicalEast - canonicalWest <= 180) return [canonicalWest, canonicalEast];
  const normalized = longitudes.map((longitude) => ((longitude % 360) + 360) % 360).sort((left, right) => left - right);
  let largestGap = -1;
  let startIndex = 0;
  for (let index = 0; index < normalized.length; index++) {
    const current = normalized[index];
    const next = index === normalized.length - 1 ? normalized[0] + 360 : normalized[index + 1];
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      startIndex = (index + 1) % normalized.length;
    }
  }
  const start = normalized[startIndex];
  const west = start >= 180 ? start - 360 : start;
  return [west, west + 360 - largestGap];
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
