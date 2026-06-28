import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";

const packageRoot = "/tmp/atlas-simulations-config-test";

describe("loadConfig", () => {
  it("uses the default port when ATLAS_SIM_PORT is blank", () => {
    expect(loadConfig({ env: { ATLAS_SIM_PORT: " " }, packageRoot }).port).toBe(5180);
  });

  it("rejects non-numeric ATLAS_SIM_PORT values", () => {
    expect(() => loadConfig({ env: { ATLAS_SIM_PORT: "abc" }, packageRoot })).toThrow("ATLAS_SIM_PORT must be a valid TCP port");
  });
});
