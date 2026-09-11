import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/application.js";

describe("atlas-core command parser", () => {
  it("parses start repair flags together", () => {
    expect(parseCommand(["start", "--manual", "--repair-bundle", "--repair-images"])).toEqual({
      kind: "start",
      manual: true,
      repairBundle: true,
      repairImages: true
    });
  });

  it.each([
    [["plugins", "install", "building_scan"], { kind: "plugins", action: "install", pluginId: "building_scan" }],
    [
      ["plugins", "install", "building_scan", "0.2.0"],
      { kind: "plugins", action: "install", pluginId: "building_scan", version: "0.2.0" }
    ],
    [["plugins", "update", "building_scan"], { kind: "plugins", action: "update", pluginId: "building_scan" }],
    [["plugins", "rollback", "building_scan"], { kind: "plugins", action: "rollback", pluginId: "building_scan" }],
    [["plugins", "uninstall", "building_scan"], { kind: "plugins", action: "uninstall", pluginId: "building_scan" }],
    [["plugins", "refresh"], { kind: "plugins", action: "refresh" }],
    [["plugins", "rotate-core-key"], { kind: "plugins", action: "rotate-core-key" }]
  ])("parses %j", (argv, expected) => {
    expect(parseCommand(argv)).toEqual(expected);
  });

  it.each([
    [["supervise"], { kind: "supervise" }],
    [["supervision"], { kind: "supervision", action: "status" }],
    [["supervision", "install"], { kind: "supervision", action: "install" }],
    [["recover"], { kind: "recover", action: "status" }],
    [["recover", "retry"], { kind: "recover", action: "retry" }],
    [["recover", "forward", "0.1.9"], { kind: "recover", action: "forward", version: "0.1.9" }],
    [["recover", "restored", "--confirm-paired-restore"], { kind: "recover", action: "restored", confirmed: true }]
  ])("parses lifecycle command %j", (argv, expected) => {
    expect(parseCommand(argv)).toEqual(expected);
  });

  it.each([
    ["start", "--manual", "--manual"],
    ["plugins", "refresh", "building_scan"],
    ["plugins", "install", "building_scan", "0.2.0", "0.3.0"],
    ["supervise", "--once"],
    ["recover", "restored"],
    ["recover", "forward"]
  ])("rejects malformed lifecycle command %j", (...argv) => {
    expect(() => parseCommand(argv)).toThrow();
  });
});
