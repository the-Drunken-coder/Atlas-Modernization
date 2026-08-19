import type { CommandCatalog, EntityResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import type { CommandInputRegistry } from "../features/commands/command-input-registry.js";
import { commandsForTargeting } from "./command-targeting.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };
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
  return {
    entity_id: "asset-1",
    entity_type: "asset",
    subtype: null,
    alias: "Rover 1",
    components: {},
    command_manifest: commandManifest,
    metadata
  };
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
