import { describe, expect, it } from "vitest";
import type { EntityResource, JSONValue, ObjectDetailResource } from "@the-drunken-coder/atlas-sdk";
import {
  assertEntitySupportsCommand,
  buildCommandTaskRequest,
  catalogFromObject,
  coerceParameters,
  commandById,
  commandLabel,
  CommandModelError,
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
        mode: { type: "string", description: "Mode", required: false },
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

function track(supportedTasks?: string[]): EntityResource {
  return {
    ...asset(supportedTasks),
    entity_id: "track-1",
    entity_type: "track",
    alias: "Track 1"
  };
}

describe("command model", () => {
  it("normalizes Core object metadata plus extra catalog fields", () => {
    const extra = { ...catalogPayload };
    delete extra.type;
    const catalog = catalogFromObject({
      object_id: "command_catalog",
      path: "objects/command_catalog/1",
      content_type: "application/json",
      type: "command_catalog",
      size_bytes: 1,
      usage_hints: ["command_catalog"],
      bucket: "atlas-media",
      metadata,
      extra
    });

    expect(catalog.name).toBe("Atlas Command Catalog");
    expect(catalog.commands.map((command) => command.id)).toEqual(["move_to_location", "hold_position"]);
  });

  it("prefers extra type when parsing catalog objects", () => {
    const catalog = catalogFromObject({
      object_id: "command_catalog",
      path: "objects/command_catalog/1",
      content_type: "application/json",
      type: "not_a_catalog",
      size_bytes: 1,
      usage_hints: ["command_catalog"],
      bucket: "atlas-media",
      metadata,
      extra: catalogPayload
    });

    expect(catalog.type).toBe("command_catalog");
  });

  it("rejects catalog objects without extra", () => {
    expect(() =>
      catalogFromObject({
        object_id: "command_catalog",
        path: "objects/command_catalog/1",
        content_type: "application/json",
        type: "command_catalog",
        size_bytes: 1,
        usage_hints: ["command_catalog"],
        bucket: "atlas-media",
        metadata
      } as unknown as ObjectDetailResource)
    ).toThrow("$.extra must be an object");
  });

  it("rejects malformed command catalogs", () => {
    expect(() => parseCommandCatalog({ ...catalogPayload, type: "other" })).toThrow("$.type must be command_catalog");
    expect(() => parseCommandCatalog({ ...catalogPayload, commands: [] })).toThrow("$.commands must be a non-empty array");
    expect(() =>
      parseCommandCatalog({
        ...catalogPayload,
        commands: [(catalogPayload.commands as unknown[])[0], (catalogPayload.commands as unknown[])[0]]
      })
    ).toThrow("$.commands[1].id is duplicated");
    expect(() =>
      parseCommandCatalog({
        ...catalogPayload,
        commands: [
          {
            id: "bad_schema",
            name: "Bad Schema",
            description: "Bad.",
            parameters_schema: { flag: { type: "boolean", description: "Flag", required: false, minimum: 1 } }
          }
        ]
      })
    ).toThrow("minimum is only valid for number parameters");
    expect(() =>
      parseCommandCatalog({
        ...catalogPayload,
        commands: [
          {
            id: "bad_bounds",
            name: "Bad Bounds",
            description: "Bad.",
            parameters_schema: { speed: { type: "number", description: "Speed", required: false, minimum: 10, maximum: 1 } }
          }
        ]
      })
    ).toThrow("minimum must be <= maximum");
  });

  it("trims catalog string fields while parsing", () => {
    const catalog = parseCommandCatalog({
      type: "command_catalog",
      name: "  Trimmed Catalog  ",
      description: "  Trimmed description  ",
      commands: [
        {
          id: "hold_position",
          name: "  Hold Position  ",
          description: "  Hold the current position.  ",
          parameters_schema: {}
        }
      ]
    });

    expect(catalog).toMatchObject({
      name: "Trimmed Catalog",
      description: "Trimmed description",
      commands: [{ name: "Hold Position", description: "Hold the current position." }]
    });
  });

  it("coerces form values and validates numeric bounds", () => {
    const command = commandById(parseCommandCatalog(catalogPayload), "move_to_location");

    expect(coerceParameters(command, { latitude: "40.1", longitude: -74.2, mode: "manual", verify: "true" })).toEqual({
      latitude: 40.1,
      longitude: -74.2,
      mode: "manual",
      verify: true
    });
    expect(coerceParameters(command, { latitude: 40.1, longitude: -74.2, verify: "false" })).toEqual({
      latitude: 40.1,
      longitude: -74.2,
      verify: false
    });
    expect(coerceParameters(command, { latitude: 40.1, longitude: -74.2, verify: "" })).toEqual({
      latitude: 40.1,
      longitude: -74.2
    });
    expect(() => coerceParameters(command, { longitude: -74.2 })).toThrow("latitude is required");
    expect(() => coerceParameters(command, { latitude: -91, longitude: -74.2 })).toThrow("latitude must be >= -90");
    expect(() => coerceParameters(command, { latitude: 91, longitude: -74.2 })).toThrow("latitude must be <= 90");
    expect(() => coerceParameters(command, { latitude: "north", longitude: -74.2 })).toThrow("latitude must be a finite number");
    expect(() => coerceParameters(command, { latitude: 40.1, longitude: -74.2, mode: [] })).toThrow("mode must be a string");
    expect(() => coerceParameters(command, { latitude: 40.1, longitude: -74.2, verify: "sometimes" })).toThrow("verify must be a boolean");
  });

  it("rejects malformed parameter containers as invalid parameters", () => {
    const command = commandById(parseCommandCatalog(catalogPayload), "move_to_location");

    for (const value of [[], "latitude=40.1"]) {
      try {
        coerceParameters(command, value);
        throw new Error("coerceParameters should have failed");
      } catch (error) {
        expect(error).toBeInstanceOf(CommandModelError);
        expect(error).toMatchObject({ code: "INVALID_PARAMETERS", message: "parameters must be an object" });
      }
    }
  });

  it("rejects unknown parameters even when their values are empty", () => {
    const command = commandById(parseCommandCatalog(catalogPayload), "move_to_location");

    expect(() => coerceParameters(command, { latitude: 40.1, longitude: -74.2, typo: "" })).toThrow("Unknown parameter typo");
  });

  it("filters commands through explicit supported task declarations", () => {
    const catalog = parseCommandCatalog(catalogPayload);

    expect(commandsForEntity(catalog, asset())).toEqual([]);
    expect(commandsForEntity(catalog, asset(["hold_position"])).map((command) => command.id)).toEqual(["hold_position"]);
    expect(commandsForEntity(catalog, asset([]))).toEqual([]);
    expect(
      commandsForEntity(catalog, {
        ...asset(),
        components: { task_catalog: { supported_tasks: "hold_position" } }
      } as unknown as EntityResource).map((command) => command.id)
    ).toEqual([]);
    expect(commandsForEntity(catalog, asset(["", "hold_position", 42 as unknown as string])).map((command) => command.id)).toEqual(["hold_position"]);
    expect(commandsForEntity(catalog, track(["hold_position"]))).toEqual([]);
  });

  it("builds command task payloads without client-supplied task IDs", () => {
    const command = commandById(parseCommandCatalog(catalogPayload), "move_to_location");

    expect(buildCommandTaskRequest({ entityId: "asset-1", command, parameters: { latitude: 40.1, longitude: -74.2 } })).toEqual({
      status: "pending",
      entity_id: "asset-1",
      components: {
        command: { type: "move_to_location", id: "move_to_location" },
        parameters: { latitude: 40.1, longitude: -74.2 }
      }
    });
  });

  it("looks up and labels commands", () => {
    const catalog = parseCommandCatalog(catalogPayload);
    const command = commandById(catalog, "hold_position");

    expect(commandLabel(command)).toBe("Hold Position (hold_position)");
    expect(() => commandById(catalog, "missing_command")).toThrow("Unknown command missing_command");
  });

  it("enforces entity command support declarations", () => {
    expect(() => assertEntitySupportsCommand(asset(["hold_position"]), "move_to_location")).toThrow("does not advertise support");
    expect(() => assertEntitySupportsCommand(asset(["hold_position"]), "hold_position")).not.toThrow();
    expect(() => assertEntitySupportsCommand(asset([]), "hold_position")).toThrow("does not advertise support");
    expect(() => assertEntitySupportsCommand(asset(), "move_to_location")).toThrow("does not advertise support");
    expect(() => assertEntitySupportsCommand(track(["hold_position"]), "hold_position")).toThrow("Only assets can receive commands");
  });
});
