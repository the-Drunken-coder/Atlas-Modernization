import type { CommandCatalog } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { buildCommandTaskRequest, commandById } from "./command-model.js";

const catalog: CommandCatalog = [
  {
    command: "fixture.queued",
    name: "Fixture queued",
    description: "Exercise queued tasking.",
    input_schema: "atlas.fixture.FixtureInput"
  }
];

describe("command model", () => {
  it("looks up Protocol Commands by canonical name", () => {
    expect(commandById(catalog, "fixture.queued").name).toBe("Fixture queued");
    expect(() => commandById(catalog, "fixture.missing")).toThrow("Unknown Command fixture.missing");
  });

  it("builds the immutable Task create request", () => {
    expect(
      buildCommandTaskRequest({
        assetId: "asset-1",
        command: catalog[0],
        input: { value: "go" }
      })
    ).toEqual({ asset_id: "asset-1", command: "fixture.queued", input: { value: "go" } });
  });
});
