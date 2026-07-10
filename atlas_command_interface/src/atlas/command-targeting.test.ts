import { describe, expect, it } from "vitest";
import type { EntityResource, JSONValue } from "@the-drunken-coder/atlas-sdk";
import { parseCommandCatalog } from "./command-model.js";
import { commandTargeting, commandsForTargeting, evaluateCommand, formParameters } from "./command-targeting.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

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
        altitude_m: { type: "number", description: "Altitude", required: true }
      }
    },
    {
      id: "goto",
      name: "Goto",
      description: "Navigate in 2D.",
      parameters_schema: {
        latitude: { type: "number", description: "Latitude", minimum: -90, maximum: 90, required: true },
        longitude: { type: "number", description: "Longitude", minimum: -180, maximum: 180, required: true },
        arrival_radius: { type: "number", description: "Arrival radius", required: false }
      }
    },
    {
      id: "hold_position",
      name: "Hold Position",
      description: "Hold here.",
      parameters_schema: {}
    },
    {
      id: "optional_latlng",
      name: "Optional LatLng",
      description: "Latitude/longitude are optional, so this is not a map command.",
      parameters_schema: {
        latitude: { type: "number", description: "Latitude", required: false },
        longitude: { type: "number", description: "Longitude", required: false }
      }
    },
    {
      id: "string_latlng",
      name: "String LatLng",
      description: "Latitude/longitude are strings, so this is not a map command.",
      parameters_schema: {
        latitude: { type: "string", description: "Latitude", required: true },
        longitude: { type: "string", description: "Longitude", required: true }
      }
    }
  ]
};

const catalog = parseCommandCatalog(catalogPayload);
const command = (id: string) => {
  const found = catalog.commands.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
};

function entity(overrides: Partial<EntityResource> = {}): EntityResource {
  return {
    entity_id: "asset-1",
    entity_type: "asset",
    subtype: null,
    alias: "Rover 1",
    components: {},
    metadata,
    ...overrides
  };
}

describe("command targeting", () => {
  it("classifies required numeric latitude+longitude as map_point", () => {
    expect(commandTargeting(command("move_to_location"))).toBe("map_point");
    expect(commandTargeting(command("goto"))).toBe("map_point");
  });

  it("classifies commands without both required numeric coordinates as none", () => {
    expect(commandTargeting(command("hold_position"))).toBe("none");
    expect(commandTargeting(command("optional_latlng"))).toBe("none");
    expect(commandTargeting(command("string_latlng"))).toBe("none");
  });

  it("excludes auto-filled map-point coordinates from the form parameters", () => {
    expect(formParameters(command("goto"), "map_point").map(([name]) => name)).toEqual(["arrival_radius"]);
    expect(formParameters(command("move_to_location"), "map_point").map(([name]) => name)).toEqual(["altitude_m"]);
    expect(formParameters(command("hold_position"), "none")).toEqual([]);
  });

  it("enables commands an asset supports", () => {
    const supporting = entity({ components: { task_catalog: { supported_tasks: ["goto"] } } });
    const result = evaluateCommand(supporting, command("goto"));
    expect(result.disabled).toBe(false);
    expect(result.disabledReason).toBeUndefined();
    expect(result.requiresForm).toBe(true);
  });

  it("disables commands an asset does not advertise, with a tooltip reason", () => {
    const supporting = entity({ components: { task_catalog: { supported_tasks: ["hold_position"] } } });
    const result = evaluateCommand(supporting, command("goto"));
    expect(result.disabled).toBe(true);
    expect(result.disabledReason).toBe("This asset does not support this command");
  });

  it("disables every command for non-asset entities", () => {
    const track = entity({ entity_type: "track" });
    const result = evaluateCommand(track, command("hold_position"));
    expect(result.disabled).toBe(true);
    expect(result.disabledReason).toBe("Only assets can receive commands");
  });

  it("disables commands when an asset has no task catalog", () => {
    const result = evaluateCommand(entity(), command("move_to_location"));
    expect(result.disabled).toBe(true);
    expect(result.disabledReason).toBe("This asset has no declared command support");
  });

  it("disables commands when an asset advertises an empty supported task list", () => {
    const result = evaluateCommand(entity({ components: { task_catalog: { supported_tasks: [] } } }), command("move_to_location"));
    expect(result.disabled).toBe(true);
    expect(result.disabledReason).toBe("This asset does not support this command");
  });

  it("partitions a targeting bucket with valid commands first and stable order", () => {
    const supporting = entity({ components: { task_catalog: { supported_tasks: ["goto"] } } });
    const mapCommands = commandsForTargeting(catalog, supporting, "map_point");
    expect(mapCommands.map((entry) => entry.command.id)).toEqual(["goto", "move_to_location"]);
    expect(mapCommands.map((entry) => entry.disabled)).toEqual([false, true]);

    const sidebarCommands = commandsForTargeting(catalog, supporting, "none");
    // hold_position is unsupported here, so it is disabled and sinks below none.
    expect(sidebarCommands.map((entry) => entry.command.id)).toEqual(["hold_position", "optional_latlng", "string_latlng"]);
    expect(sidebarCommands.every((entry) => entry.disabled)).toBe(true);
  });
});
