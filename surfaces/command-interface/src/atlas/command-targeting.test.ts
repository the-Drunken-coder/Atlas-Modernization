import type { CommandCatalog, EntityResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { entityFixture } from "../../test/fixtures.js";
import type { CommandInputRegistry } from "../features/commands/command-input-registry.js";
import { commandsForTargeting } from "./command-targeting.js";

const catalog: CommandCatalog = [
  {
    command: "fixture.queued",
    name: "Fixture queued",
    description: "Exercise queued tasking.",
    input_schema: "atlas.fixture.FixtureInput"
  }
];
const registry: CommandInputRegistry = {
  "fixture.queued": { targeting: "none", buildInput: () => ({ value: "fixture" }) }
};

function asset(commandManifest: EntityResource["command_manifest"]): EntityResource {
  return entityFixture({
    entity_id: "asset-1",
    alias: "Rover 1",
    command_manifest: commandManifest
  });
}

const manifest = [
  {
    command: "fixture.queued",
    description: "Runs the fixture handler.",
    scheduling: "queued" as const,
    supports_cancel: true,
    supports_progress: true
  }
];

describe("command targeting", () => {
  it("requires the Command in the catalog, Asset manifest, and purpose-built input registry", () => {
    expect(commandsForTargeting(catalog, asset(manifest), "none", registry)).toHaveLength(1);
    expect(commandsForTargeting([], asset(manifest), "none", registry)).toEqual([]);
    expect(commandsForTargeting(catalog, asset([]), "none", registry)).toEqual([]);
    expect(commandsForTargeting(catalog, asset(manifest), "none", {})).toEqual([]);
  });

  it("keeps targeting in the purpose-built input registration", () => {
    expect(commandsForTargeting(catalog, asset(manifest), "map_point", registry)).toEqual([]);
  });

  it("never exposes Commands for non-Asset entities", () => {
    expect(commandsForTargeting(catalog, { ...asset(manifest), entity_type: "track" }, "none", registry)).toEqual([]);
  });
});

describe("flight command targeting", () => {
  const flightCatalog: CommandCatalog = [
    { command: "flight.takeoff", name: "Takeoff", description: "Climb.", input_schema: "atlas.flight.TakeoffRequest" },
    { command: "flight.goto", name: "Go to", description: "Fly.", input_schema: "atlas.flight.GotoRequest" },
    {
      command: "flight.return_to_launch",
      name: "Return to launch",
      description: "Recover.",
      input_schema: "atlas.tasking.EmptyObject"
    },
    { command: "flight.land", name: "Land", description: "Land.", input_schema: "atlas.tasking.EmptyObject" }
  ];
  const flightManifest: EntityResource["command_manifest"] = [
    {
      command: "flight.takeoff",
      description: "Climb.",
      scheduling: "immediate",
      supports_cancel: false,
      supports_progress: false
    },
    {
      command: "flight.goto",
      description: "Fly.",
      scheduling: "immediate",
      supports_cancel: true,
      supports_progress: true
    },
    {
      command: "flight.return_to_launch",
      description: "Recover.",
      scheduling: "immediate",
      supports_cancel: false,
      supports_progress: false
    },
    {
      command: "flight.land",
      description: "Land.",
      scheduling: "immediate",
      supports_cancel: false,
      supports_progress: false
    }
  ];

  it("exposes go-to for map points and the rest for the sidebar", async () => {
    const { COMMAND_INPUT_REGISTRY } = await import("../features/commands/command-input-registry.js");
    const aircraft = asset(flightManifest);
    const mapCommands = commandsForTargeting(flightCatalog, aircraft, "map_point", COMMAND_INPUT_REGISTRY);
    expect(mapCommands.map((entry) => entry.command.command)).toEqual(["flight.goto"]);
    const sidebarCommands = commandsForTargeting(flightCatalog, aircraft, "none", COMMAND_INPUT_REGISTRY);
    expect(sidebarCommands.map((entry) => entry.command.command).sort()).toEqual([
      "flight.land",
      "flight.return_to_launch",
      "flight.takeoff"
    ]);
  });
});
