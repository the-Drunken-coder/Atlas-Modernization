import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { demoTracks, scanRequestFromTask, scanTaskComponent } from "../src/scan.js";

const metadata = { created_at: "2026-07-12T00:00:00Z", updated_at: "2026-07-12T00:00:00Z", version: 1 };

function task(custom_connector: unknown): TaskResource {
  return {
    task_id: "scan-1",
    entity_id: "connector-adsb-demo",
    status: "pending",
    components: { custom_connector: custom_connector as never },
    metadata
  };
}

describe("scanRequestFromTask", () => {
  it("reads a bounded scan request", () => {
    expect(scanRequestFromTask(task({ action: "scan_area", bounds: { north: 39, south: 38, east: -76, west: -77 }, track_count: 4 }))).toEqual({
      bounds: { north: 39, south: 38, east: -76, west: -77 },
      trackCount: 4
    });
  });

  it("ignores tasks for other connector actions", () => {
    expect(scanRequestFromTask(task({ action: "pause" }))).toBeUndefined();
  });

  it("rejects inverted bounds", () => {
    expect(() => scanRequestFromTask(task({ action: "scan_area", bounds: { north: 38, south: 39, east: -76, west: -77 } }))).toThrow(
      "north must be greater than south"
    );
  });

  it("validates submitted scans before they reach Atlas", () => {
    expect(scanTaskComponent({ north: 39, south: 38, east: -76, west: -77 }, 2)).toEqual({
      action: "scan_area",
      bounds: { north: 39, south: 38, east: -76, west: -77 },
      track_count: 2
    });
    expect(() => scanTaskComponent({ north: 39, south: 38, east: Number.POSITIVE_INFINITY, west: -77 }, 2)).toThrow("east must be a finite number");
    expect(() => scanTaskComponent({ north: 39, south: 38, east: -76, west: -77 }, 11)).toThrow("track_count must be an integer from 1 to 10");
  });
});

describe("demoTracks", () => {
  it("creates stable tracks inside the scan area", () => {
    const tracks = demoTracks(
      "connector-adsb-demo",
      "scan-1",
      { bounds: { north: 39, south: 38, east: -76, west: -77 }, trackCount: 2 },
      "2026-07-12T00:00:00.000Z"
    );

    expect(tracks[0].entity_id).not.toBe(tracks[1].entity_id);
    expect(tracks.every((track) => track.entity_id.length <= 50)).toBe(true);
    expect(tracks.every((track) => track.entity_type === "track" && track.subtype === "aircraft")).toBe(true);
    expect(tracks[0].components?.telemetry).toMatchObject({ latitude: 38.333333, longitude: -76.666667 });
    expect(tracks[1].components?.custom_connector).toMatchObject({ connector_id: "connector-adsb-demo", scan_task_id: "scan-1" });
  });

  it("keeps long connector namespaces distinct", () => {
    const request = { bounds: { north: 39, south: 38, east: -76, west: -77 }, trackCount: 1 };
    const first = demoTracks(`${"a".repeat(49)}x`, "scan-1", request, "2026-07-12T00:00:00.000Z")[0].entity_id;
    const second = demoTracks(`${"a".repeat(49)}y`, "scan-1", request, "2026-07-12T00:00:00.000Z")[0].entity_id;
    expect(first).not.toBe(second);
    expect(first).toHaveLength(50);
    expect(second).toHaveLength(50);
  });
});
