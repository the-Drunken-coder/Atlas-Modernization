import type { Map as MlMap, StyleSpecification } from "maplibre-gl";
import type { WheelEvent } from "react";
import { CAMERA_EVENT_TAG, INITIAL_WORLD_BOUNDS } from "./map-camera.js";
import type { ReticleState, ScreenPoint, TargetBox } from "./map-reticle.js";

const WHEEL_ZOOM_RATE = 1 / 450;
const DOM_DELTA_LINE = 1;

export type CursorHandoffState = { nativePoint: ScreenPoint; visualPoint: ScreenPoint };

export function cursorPointsFromEvent(
  event: { clientX: number; clientY: number },
  rect: DOMRect,
  handoff: CursorHandoffState | null
): { rawPoint: ScreenPoint; visualPoint: ScreenPoint } {
  const rawPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  if (!handoff) return { rawPoint, visualPoint: rawPoint };
  return {
    rawPoint,
    visualPoint: {
      x: handoff.visualPoint.x + rawPoint.x - handoff.nativePoint.x,
      y: handoff.visualPoint.y + rawPoint.y - handoff.nativePoint.y
    }
  };
}

export function clientPointInsideRect(event: { clientX: number; clientY: number }, rect: DOMRect): boolean {
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
}

export function zoomDeltaFromWheel(event: Pick<WheelEvent<HTMLDivElement>, "deltaMode" | "deltaY" | "shiftKey">): number {
  let value = event.deltaMode === DOM_DELTA_LINE ? event.deltaY * 40 : event.deltaY;
  if (event.shiftKey && value) value /= 4;
  return -value * WHEEL_ZOOM_RATE;
}

export function reticlesEqual(a: ReticleState | null, b: ReticleState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.targetEntityId === b.targetEntityId && a.targeted === b.targeted && boxesEqual(a.target, b.target);
}

export function boxesEqual(a: TargetBox, b: TargetBox): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function cloneStyle(style: StyleSpecification): StyleSpecification {
  return JSON.parse(JSON.stringify(style)) as StyleSpecification;
}

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl"));
  } catch {
    return false;
  }
}

export function fitWorldOnce(map: MlMap, fitWorldOnceRef: { current: boolean }): void {
  if (fitWorldOnceRef.current) return;
  fitWorldOnceRef.current = true;
  map.fitBounds(INITIAL_WORLD_BOUNDS, { padding: 0, duration: 0 }, { [CAMERA_EVENT_TAG]: true });
}
