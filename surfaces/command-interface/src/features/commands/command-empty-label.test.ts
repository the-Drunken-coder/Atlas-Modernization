import type { CommandCatalog, EntityResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { commandEmptyLabel } from "./command-empty-label.js";

const catalog: CommandCatalog = [
  {
    command: "fixture.queued",
    name: "Fixture queued",
    description: "Exercise tasking.",
    input_schema: "atlas.protocol.JSONValue"
  }
];
const manifest: EntityResource["command_manifest"] = [
  {
    command: "fixture.queued",
    description: "Runs the fixture.",
    scheduling: "queued",
    supports_cancel: true,
    supports_progress: true
  }
];

describe("commandEmptyLabel", () => {
  it.each(["ready", "loading", "unavailable"] as const)(
    "prioritizes catalog availability over a %s manifest",
    (status) => {
      expect(commandEmptyLabel(undefined, manifest, status)).toBe("Command Catalog unavailable");
      expect(commandEmptyLabel([], manifest, status)).toBe("No Commands are defined in Atlas Protocol");
    }
  );

  it.each([
    ["loading", "Loading Asset Commands"],
    ["unavailable", "Asset Commands unavailable"]
  ] as const)("prioritizes a %s manifest status over its contents", (status, expected) => {
    for (const entries of [undefined, [], manifest]) {
      expect(commandEmptyLabel(catalog, entries, status)).toBe(expected);
    }
  });

  it("distinguishes empty ready manifests from Commands without operator inputs", () => {
    expect(commandEmptyLabel(catalog, undefined, "ready")).toBe("This Asset has no Commands");
    expect(commandEmptyLabel(catalog, [], "ready")).toBe("This Asset has no Commands");
    expect(commandEmptyLabel(catalog, manifest, "ready")).toBe(
      "No operator inputs are available for this Asset's Commands"
    );
  });
});
