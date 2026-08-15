import type { CommandCatalog } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { buildCommandTaskRequest, CommandModelError, coerceParameters, commandById } from "./command-model.js";

const catalogPayload: CommandCatalog = {
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

describe("command model", () => {
  it("coerces form values and validates numeric bounds", () => {
    const command = commandById(catalogPayload, "move_to_location");

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
    expect(() => coerceParameters(command, { latitude: "north", longitude: -74.2 })).toThrow(
      "latitude must be a finite number"
    );
    expect(() => coerceParameters(command, { latitude: 40.1, longitude: -74.2, mode: [] })).toThrow(
      "mode must be a string"
    );
    expect(() => coerceParameters(command, { latitude: 40.1, longitude: -74.2, verify: "sometimes" })).toThrow(
      "verify must be a boolean"
    );
  });

  it("rejects malformed parameter containers as invalid parameters", () => {
    const command = commandById(catalogPayload, "move_to_location");

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
    const command = commandById(catalogPayload, "move_to_location");

    expect(() => coerceParameters(command, { latitude: 40.1, longitude: -74.2, typo: "" })).toThrow(
      "Unknown parameter typo"
    );
  });

  it("builds command task payloads without client-supplied task IDs", () => {
    const command = commandById(catalogPayload, "move_to_location");

    expect(
      buildCommandTaskRequest({ entityId: "asset-1", command, parameters: { latitude: 40.1, longitude: -74.2 } })
    ).toEqual({
      status: "pending",
      entity_id: "asset-1",
      components: {
        command: { type: "move_to_location", id: "move_to_location" },
        parameters: { latitude: 40.1, longitude: -74.2 }
      }
    });
  });

  it("looks up commands by id", () => {
    expect(commandById(catalogPayload, "hold_position").id).toBe("hold_position");
    expect(() => commandById(catalogPayload, "missing_command")).toThrow("Unknown command missing_command");
  });
});
