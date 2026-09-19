import { AtlasClient, type TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import type { AssetConfig } from "./config.js";
import { CoreAttachment } from "./core-client.js";

const config: AssetConfig = {
  coreUrl: "http://core.test",
  apiKey: "test",
  assetId: "quad-01",
  link: { transport: "tcp", host: "127.0.0.1", port: 5760 },
  vehicleSystemId: 1,
  vehicleComponentId: 1,
  coreLossGraceSeconds: 5,
  telemetryIntervalSeconds: 1,
  arrivalRadiusM: 1.5,
  altitudeToleranceM: 1,
  hoverSettleSeconds: 1,
  progressTimeoutSeconds: 30,
  taskTimeoutSeconds: 300,
  minBatteryPercent: 20,
  shutdownConfirmSeconds: 1
};

function clientWith(fetchImpl: typeof fetch): AtlasClient {
  return new AtlasClient({ baseUrl: config.coreUrl, apiKey: config.apiKey, fetch: fetchImpl, sync: false });
}

describe("CoreAttachment", () => {
  it("reports movement once through flat telemetry and forwards flight state and battery components", async () => {
    let requestBody: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        entity: {
          entity_id: config.assetId,
          entity_type: "asset",
          subtype: null,
          alias: null,
          components: {},
          metadata: {
            created_at: "2026-09-19T12:00:00Z",
            updated_at: "2026-09-19T12:00:00Z",
            version: 1
          }
        }
      });
    };
    const core = new CoreAttachment(config, clientWith(fetchImpl));

    await core.checkin({
      position: {
        latitude: 42.274,
        longitude: -71.806,
        altitudeMslM: 152,
        speedMS: 3.5,
        headingDeg: 90
      },
      armed: true,
      flightMode: "GUIDED",
      launchElevationM: 140,
      batteryRemainingPercent: 73
    });

    expect(requestBody).toEqual({
      latitude: 42.274,
      longitude: -71.806,
      altitude_m: 152,
      speed_m_s: 3.5,
      heading_deg: 90,
      components: {
        telemetry: { armed: true, flight_mode: "GUIDED", launch_elevation_m: 140 },
        health: { battery_percent: 73 }
      }
    });
  });

  it("rejects a successful HTTP start response that did not grant execution", async () => {
    const failed: TaskResource = {
      task_id: "task-expired",
      asset_id: config.assetId,
      command: "flight.takeoff",
      input: { altitude_m: 150 },
      status: "failed",
      acknowledged_at: "2026-09-19T12:00:00Z",
      finished_at: "2026-09-19T12:00:01Z",
      failure: { code: "immediate_start_timeout", message: "Start window expired." },
      created_at: "2026-09-19T11:59:00Z",
      updated_at: "2026-09-19T12:00:01Z"
    };
    const core = new CoreAttachment(
      config,
      clientWith(async () => Response.json(failed, { headers: { ETag: '"v1"' } }))
    );

    await expect(core.reportStart(failed.task_id)).rejects.toThrow(
      "Core did not grant execution for Task task-expired; authoritative status is failed."
    );
  });
});
