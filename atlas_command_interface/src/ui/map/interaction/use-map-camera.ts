import type { Map as MlMap } from "maplibre-gl";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import type { MapSources } from "../rendering/map-sources.js";
import {
  CAMERA_EVENT_TAG,
  coordsChanged,
  FIT_DURATION_MS,
  FOLLOW_EASE_MS,
  type FollowEvent,
  type FollowState,
  featureForEntityId,
  followIdle,
  followReducer,
  geometryForTarget,
  INITIAL_WORLD_BOUNDS,
  isLngLatPosition,
  type MapCameraCommand,
  PREVIEW_RESTORE_MS,
  planFocusMove,
  previewEasing
} from "./map-camera.js";

const FLY_SEQ_TAG = "atlasFlySeq";

type TaggedEvent = { [CAMERA_EVENT_TAG]?: boolean; [FLY_SEQ_TAG]?: number } | undefined;

/**
 * Binds explicit camera commands to the MapLibre camera and runs the soft
 * follow loop. Every programmatic move is tagged with CAMERA_EVENT_TAG so any
 * untagged movement can be treated as a user gesture that breaks follow.
 */
export function useMapCamera(args: {
  mapRef: RefObject<MlMap | undefined>;
  mapReady: boolean;
  sources: MapSources;
  command: MapCameraCommand | null | undefined;
}): { notifyUserGesture: () => void } {
  const { mapRef, mapReady, sources, command } = args;
  const followRef = useRef<FollowState>(followIdle);
  const lastAppliedSeqRef = useRef(0);
  const lastFollowedCoordsRef = useRef<[number, number] | null>(null);
  const previewOriginRef = useRef<{ center: [number, number]; zoom: number } | null>(null);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const dispatch = useCallback((event: FollowEvent) => {
    followRef.current = followReducer(followRef.current, event);
  }, []);

  const chaseFollowedEntity = useCallback(() => {
    const map = mapRef.current;
    const state = followRef.current;
    if (!map || state.phase !== "following") return;
    const geometry = featureForEntityId(sourcesRef.current, state.entityId)?.geometry;
    if (!geometry || geometry.type !== "Point" || !isLngLatPosition(geometry.coordinates)) return;
    const next: [number, number] = [geometry.coordinates[0], geometry.coordinates[1]];
    const last = lastFollowedCoordsRef.current;
    if (last && !coordsChanged(last, next)) return;
    lastFollowedCoordsRef.current = next;
    // easeTo restarts from the live transform, so back-to-back chases stay
    // smooth without stopping the current animation.
    map.easeTo({ center: next, duration: FOLLOW_EASE_MS, easing: (t) => t }, { [CAMERA_EVENT_TAG]: true });
  }, [mapRef]);

  const notifyUserGesture = useCallback(() => {
    previewOriginRef.current = null;
    dispatch({ type: "user-gesture" });
  }, [dispatch]);

  // Gesture and animation listeners. Untagged movement means the user moved
  // the map; dragstart/boxzoomstart/wheel cover gestures that MapLibre may
  // coalesce into an already-running move.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const onMoveStart = (event?: unknown) => {
      if (!(event as TaggedEvent)?.[CAMERA_EVENT_TAG]) notifyUserGesture();
    };
    const onMoveEnd = (event?: unknown) => {
      const tagged = event as TaggedEvent;
      const seq = tagged?.[CAMERA_EVENT_TAG] ? tagged[FLY_SEQ_TAG] : undefined;
      if (seq === undefined) return;
      dispatch({ type: "fly-complete", seq });
      // Telemetry may have moved the entity during the flight.
      chaseFollowedEntity();
    };
    const onGesture = notifyUserGesture;

    map.on("movestart", onMoveStart);
    map.on("moveend", onMoveEnd);
    map.on("dragstart", onGesture);
    map.on("boxzoomstart", onGesture);
    map.on("wheel", onGesture);
    return () => {
      map.off("movestart", onMoveStart);
      map.off("moveend", onMoveEnd);
      map.off("dragstart", onGesture);
      map.off("boxzoomstart", onGesture);
      map.off("wheel", onGesture);
    };
  }, [mapRef, mapReady, dispatch, chaseFollowedEntity, notifyUserGesture]);

  // Apply camera commands. Unresolvable targets stay pending and retry on
  // every sources change; the seq is committed only once a move is issued.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (!command) {
      dispatch({ type: "command-cleared" });
      const origin = previewOriginRef.current;
      if (origin) {
        previewOriginRef.current = null;
        map.easeTo(
          { center: origin.center, zoom: origin.zoom, duration: PREVIEW_RESTORE_MS, easing: previewEasing },
          { [CAMERA_EVENT_TAG]: true }
        );
      }
      return;
    }
    if (command.seq <= lastAppliedSeqRef.current) return;

    if (command.intent === "world") {
      previewOriginRef.current = null;
      lastAppliedSeqRef.current = command.seq;
      dispatch({ type: "command-geometry", seq: command.seq });
      map.fitBounds(INITIAL_WORLD_BOUNDS, { padding: 0, duration: FIT_DURATION_MS }, { [CAMERA_EVENT_TAG]: true });
      return;
    }

    const geometry = geometryForTarget(sources, command.target);
    const view = geometry
      ? (() => {
          const center = map.getCenter();
          return { center: [center.lng, center.lat] as [number, number], zoom: map.getZoom() };
        })()
      : undefined;
    if (command.intent === "preview" && view && !previewOriginRef.current) previewOriginRef.current = view;
    if (command.intent !== "preview") previewOriginRef.current = null;
    const move = geometry && view ? planFocusMove(geometry, view, command.intent) : null;
    if (!move) {
      if (command.target.type === "entity")
        dispatch({ type: "command-pending", seq: command.seq, entityId: command.target.id });
      else dispatch({ type: "command-geometry", seq: command.seq });
      return;
    }

    lastAppliedSeqRef.current = command.seq;
    if (move.kind === "fly-to") {
      const eventData =
        command.target.type === "entity"
          ? { [CAMERA_EVENT_TAG]: true, [FLY_SEQ_TAG]: command.seq }
          : { [CAMERA_EVENT_TAG]: true };
      if (command.target.type === "entity") {
        lastFollowedCoordsRef.current = move.center;
        dispatch({ type: "command-point", seq: command.seq, entityId: command.target.id });
      } else {
        dispatch({ type: "command-geometry", seq: command.seq });
      }
      map.flyTo(
        {
          center: move.center,
          zoom: move.zoom,
          duration: move.durationMs,
          ...(command.intent === "preview" ? { easing: previewEasing } : {})
        },
        eventData
      );
      return;
    }
    dispatch({ type: "command-geometry", seq: command.seq });
    map.fitBounds(
      move.bounds,
      {
        duration: move.durationMs,
        maxZoom: move.maxZoom,
        padding: move.padding,
        ...(command.intent === "preview" ? { easing: previewEasing } : {})
      },
      { [CAMERA_EVENT_TAG]: true }
    );
  }, [command, sources, mapReady, mapRef, dispatch]);

  // Soft follow: chase the followed entity when telemetry moves it.
  useEffect(() => {
    if (!mapReady) return;
    chaseFollowedEntity();
  }, [sources, mapReady, chaseFollowedEntity]);

  return { notifyUserGesture };
}
