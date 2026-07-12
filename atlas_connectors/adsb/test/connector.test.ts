import { AtlasAPIError, type EntityCheckInOptions, type EntityCreateRequest, type EntityResource, type TaskResource } from "@the-drunken-coder/atlas-sdk";
import type { ConnectorConfig } from "../src/config.js";
import { ADSBConnector, type ConnectorClient } from "../src/connector.js";

const now = new Date("2026-07-12T12:00:00.000Z");
const metadata = { created_at: now.toISOString(), updated_at: now.toISOString(), version: 1 };
const config: ConnectorConfig = { baseUrl: "https://core.test", connectorId: "connector-adsb-demo", intervalMs: 2000 };

class FakeClient implements ConnectorClient {
  readonly stored = new Map<string, EntityResource>();
  readonly pending: TaskResource[] = [];
  readonly acknowledged: string[] = [];
  readonly completed: string[] = [];
  readonly failed: string[] = [];

  readonly entities = {
    get: async (id: string) => {
      const entity = this.stored.get(id);
      if (!entity) throw new AtlasAPIError("not found", 404, undefined);
      return entity;
    },
    create: async (request: EntityCreateRequest) => {
      const entity = resource(request);
      this.stored.set(entity.entity_id, entity);
      return entity;
    },
    update: async (id: string, request: Parameters<ConnectorClient["entities"]["update"]>[1]) => {
      const current = await this.entities.get(id);
      const entity = {
        ...current,
        alias: request.alias ?? current.alias,
        subtype: request.subtype ?? current.subtype,
        components: { ...current.components, ...request.components }
      };
      this.stored.set(id, entity);
      return entity;
    },
    checkIn: async (_id: string, options?: EntityCheckInOptions<"full">) => ({
      entity: this.stored.get(config.connectorId) ?? resource({ entity_id: config.connectorId, entity_type: "asset", components: {} }),
      tasks: options?.statusFilter?.includes("pending") ? [...this.pending] : [],
      task_count: this.pending.length,
      task_limit: 20,
      has_more_tasks: false
    })
  };

  readonly tasks = {
    acknowledge: async (id: string) => {
      this.acknowledged.push(id);
      return this.task(id, "acknowledged");
    },
    complete: async (id: string) => {
      this.completed.push(id);
      return this.task(id, "completed");
    },
    fail: async (id: string) => {
      this.failed.push(id);
      return this.task(id, "failed");
    }
  };

  private task(id: string, status: string): TaskResource {
    return this.pending.find((task) => task.task_id === id) ?? { task_id: id, entity_id: config.connectorId, status, components: {}, metadata };
  }
}

describe("ADSBConnector", () => {
  it("registers as a connector asset without Core-specific behavior", async () => {
    const client = new FakeClient();
    await new ADSBConnector(
      client,
      config,
      () => now,
      () => undefined
    ).ensureAsset();

    expect(client.stored.get(config.connectorId)).toMatchObject({ entity_type: "asset", subtype: "connector", alias: "ADS-B Connector Prototype" });
  });

  it("accepts a scan task and publishes tracks", async () => {
    const client = new FakeClient();
    const connector = new ADSBConnector(
      client,
      config,
      () => now,
      () => undefined
    );
    await connector.ensureAsset();
    client.pending.push({
      task_id: "scan-1",
      entity_id: config.connectorId,
      status: "pending",
      components: { custom_connector: { action: "scan_area", bounds: { north: 39, south: 38, east: -76, west: -77 }, track_count: 2 } },
      metadata
    });

    await expect(connector.tick()).resolves.toBe(1);
    expect(client.acknowledged).toEqual(["scan-1"]);
    expect(client.completed).toEqual(["scan-1"]);
    expect([...client.stored.values()].filter((entity) => entity.entity_type === "track")).toHaveLength(2);
  });

  it("fails a malformed scan task without stopping the connector", async () => {
    const client = new FakeClient();
    const connector = new ADSBConnector(
      client,
      config,
      () => now,
      () => undefined
    );
    await connector.ensureAsset();
    client.pending.push({
      task_id: "scan-bad",
      entity_id: config.connectorId,
      status: "pending",
      components: { custom_connector: { action: "scan_area", bounds: { north: 38, south: 39, east: -76, west: -77 } } },
      metadata
    });

    await expect(connector.tick()).resolves.toBe(1);
    expect(client.failed).toEqual(["scan-bad"]);
    expect(client.acknowledged).toEqual([]);
  });
});

function resource(request: EntityCreateRequest): EntityResource {
  return {
    entity_id: request.entity_id,
    entity_type: request.entity_type,
    subtype: request.subtype ?? null,
    alias: request.alias ?? null,
    components: request.components ?? {},
    metadata
  };
}
