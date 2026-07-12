import { createHash } from "node:crypto";
import type { EntityCreateRequest, JSONValue, TaskResource } from "@the-drunken-coder/atlas-sdk";

export type ScanBounds = { north: number; south: number; east: number; west: number };
export type ScanRequest = { bounds: ScanBounds; trackCount: number };

export function scanRequestFromTask(task: TaskResource): ScanRequest | undefined {
  const component = task.components.custom_connector;
  if (!isRecord(component) || component.action !== "scan_area") return undefined;
  if (!isRecord(component.bounds)) throw new Error("scan_area requires bounds");

  const bounds = {
    north: finiteNumber(component.bounds.north, "north"),
    south: finiteNumber(component.bounds.south, "south"),
    east: finiteNumber(component.bounds.east, "east"),
    west: finiteNumber(component.bounds.west, "west")
  };
  const trackCount = component.track_count === undefined ? 3 : finiteNumber(component.track_count, "track_count");
  return validateScanRequest({ bounds, trackCount });
}

export function demoTracks(connectorId: string, taskId: string, request: ScanRequest, observedAt: string): EntityCreateRequest[] {
  return Array.from({ length: request.trackCount }, (_, index) => {
    const fraction = (index + 1) / (request.trackCount + 1);
    const latitude = round(request.bounds.south + (request.bounds.north - request.bounds.south) * fraction);
    const longitude = round(request.bounds.west + (request.bounds.east - request.bounds.west) * fraction);
    return {
      entity_id: trackId(connectorId, index),
      entity_type: "track",
      subtype: "aircraft",
      alias: `Demo aircraft ${index + 1}`,
      components: {
        geometry: { type: "Point", coordinates: [longitude, latitude] },
        telemetry: {
          latitude,
          longitude,
          altitude_m: 3000 + index * 600,
          speed_m_s: 95 + index * 12,
          heading_deg: (45 + index * 37) % 360,
          last_update: observedAt
        },
        status: { value: "observed", last_update: observedAt },
        custom_connector: {
          connector_id: connectorId,
          scan_task_id: taskId,
          source: "prototype",
          observed_at: observedAt
        }
      }
    };
  });
}

export function scanTaskComponent(bounds: ScanBounds, trackCount: number): JSONValue {
  const request = validateScanRequest({ bounds, trackCount });
  return { action: "scan_area", bounds: request.bounds, track_count: request.trackCount };
}

function trackId(connectorId: string, index: number): string {
  const digest = createHash("sha256").update(connectorId).digest("hex").slice(0, 10);
  const suffix = `-${digest}-track-${index + 1}`;
  return connectorId.slice(0, 50 - suffix.length) + suffix;
}

function validateScanRequest(request: ScanRequest): ScanRequest {
  const { bounds, trackCount } = request;
  for (const [name, value] of Object.entries(bounds)) finiteNumber(value, name);
  if (bounds.north <= bounds.south) throw new Error("north must be greater than south");
  if (bounds.east <= bounds.west) throw new Error("east must be greater than west");
  if (bounds.north > 90 || bounds.south < -90 || bounds.east > 180 || bounds.west < -180) throw new Error("scan bounds are outside valid coordinates");
  if (!Number.isInteger(trackCount) || trackCount < 1 || trackCount > 10) throw new Error("track_count must be an integer from 1 to 10");
  return request;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function isRecord(value: unknown): value is Record<string, JSONValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
