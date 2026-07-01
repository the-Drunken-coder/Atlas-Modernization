import type { Position } from "../../atlas/geometry.js";

export const RETICLE_TARGET_SIZE = 22;
export const HOVER_TARGET_PADDING = 7;

export type ScreenPoint = { x: number; y: number };
export type TargetBox = { x: number; y: number; width: number; height: number };
export type ReticleTarget = { box: TargetBox; entityId?: string; id?: string };
export type ReticleState = ScreenPoint & { target: TargetBox; targetEntityId?: string; targeted?: boolean };
export type ZoomOverlayState = { start: ScreenPoint; current: ScreenPoint };

export function pointFromClient(event: { clientX: number; clientY: number }, rect: DOMRect, clampToRect = false): ScreenPoint {
  const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  if (!clampToRect) return point;
  return { x: clamp(point.x, 0, rect.width), y: clamp(point.y, 0, rect.height) };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function boxFromDrag({ start, current }: ZoomOverlayState): TargetBox {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.max(1, Math.abs(start.x - current.x)),
    height: Math.max(1, Math.abs(start.y - current.y))
  };
}

export function reticleFromTargetBox(target: TargetBox): ReticleState {
  return { x: target.x + target.width / 2, y: target.y + target.height / 2, target };
}

export function squareAround(point: ScreenPoint, size: number): TargetBox {
  return { x: point.x - size / 2, y: point.y - size / 2, width: size, height: size };
}

export function reticleForTarget(target: ReticleTarget): ReticleState {
  const box = minimumBox(paddedBox(target.box, HOVER_TARGET_PADDING), RETICLE_TARGET_SIZE);
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    target: box,
    targetEntityId: target.entityId,
    targeted: true
  };
}

export function paddedBox(box: TargetBox, padding: number): TargetBox {
  return {
    x: box.x - padding,
    y: box.y - padding,
    width: box.width + padding * 2,
    height: box.height + padding * 2
  };
}

export function minimumBox(box: TargetBox, minSize: number): TargetBox {
  const width = Math.max(box.width, minSize);
  const height = Math.max(box.height, minSize);
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height
  };
}

export function boxIntersectsViewport(box: TargetBox, viewport: { width: number; height: number }): boolean {
  return box.x + box.width >= 0 && box.y + box.height >= 0 && box.x <= viewport.width && box.y <= viewport.height;
}

export function boxFromProjectedPositions(positions: Position[], project: (position: Position) => ScreenPoint): TargetBox | null {
  const points = positions.map(project);
  if (points.length === 0) return null;
  const xValues = points.map((position) => position.x);
  const yValues = points.map((position) => position.y);
  return {
    x: Math.min(...xValues),
    y: Math.min(...yValues),
    width: Math.max(...xValues) - Math.min(...xValues),
    height: Math.max(...yValues) - Math.min(...yValues)
  };
}
