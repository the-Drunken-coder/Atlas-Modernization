import { describe, expect, it } from "vitest";
import type { EntityResource, JSONValue } from "../../../atlas_sdk/src/index.js";
import {
  buildCommandTaskRequest,
  catalogFromObject,
  coerceParameters,
  commandById,
  commandsForEntity,
  parseCommandCatalog
} from "./command-model.js";

const metadata = {
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-20T00:00:00Z",
  version: 1
};

const catalogPayload: Record<string, JSONValue> = {
  type: "command_catalog",
  name: "Atlas Command Catalog",
  description: "Test catalog",
  commands: [
    {
      id: "move_to_location",
      name: "Move to Location",
      description: "Move to a location.",
      parameters_schema: {
        latitude: { type: "number", description: "Latitude", minimum: -90, maximum: 90, required: true },
        longitude: { type: "number", description: "Longitude", minimum: -180, maximum: 180, required: true },
        verify: { type: "boolean", description: "Verify arrival", required: false }
      }
    },
    {
      id: "hold_position",
      name: "Hold Position",
      description: "Hold the current position.",
      parameters_schema: {}
    }
  ]
};

function asset(supportedTasks?: string[]): EntityResource {
  return {
    entity_id: "asset-1",
    entity_type: "asset",
    subtype: null,
    alias: "Rover 1",
    components: supportedTasks === undefined ? {} : { task_catalog: { supported_tasks: supportedTasks } },
    metadata
  };
}

describe("command model", () => {
  it("normalizes Core object metadata plus JSON payload catalog fields", () => {
    const payload = { ...catalogPayload };
    delete payload.type;
    const catalog = catalogFromObject({
      object_id: "command_catalog",
      path: "objects/command_catalog/1",
      content_type: "application/json",
      type: "command_catalog",
      size_bytes: 1,
      usage_hints: ["command_catalog"],
      bucket: "atlas-media",
      metadata,
      payload
    });

    expect(catalog.name).toBe("Atlas Command Catalog");
    expect(catalog.commands.map((command) => command.id)).toEqual(["move_to_location", "hold_position"]);
  });

  it("coerces form values and validates numeric bounds", () => {
    const command = commandById(parseCommandCatalog(catalogPayload), "move_to_location");

    expect(coerceParameters(command, { latitude: "40.1", longitude: -74.2, verify: "true" })).toEqual({
      latitude: 40.1,
      longitude: -74.2,
      verify: true
    });
    expect(() => coerceParameters(command, { latitude: 91, longitude: -74.2 })).toThrow("latitude must be <= 90");
  });

  it("filters commands only when an entity declares supported tasks", () => {
    const catalog = parseCommandCatalog(catalogPayload);

    expect(commandsForEntity(catalog, asset()).map((command) => command.id)).toEqual(["move_to_location", "hold_position"]);
    expect(commandsForEntity(catalog, asset(["hold_position"])).map((command) => command.id)).toEqual(["hold_position"]);
    expect(commandsForEntity(catalog, asset([]))).toEqual([]);
  });

  it("builds command task payloads with command type and id", () => {
    const command = commandById(parseCommandCatalog(catalogPayload), "hold_position");

    expect(buildCommandTaskRequest({ taskId: "command-1", entityId: "asset-1", command, parameters: {} })).toEqual({
      task_id: "command-1",
      status: "pending",
      entity_id: "asset-1",
      components: {
        command: { type: "hold_position", id: "hold_position" },
        parameters: {}
      }
    });
  });
});
