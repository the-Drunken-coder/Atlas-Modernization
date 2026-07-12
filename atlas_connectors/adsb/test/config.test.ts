import { readConfig } from "../src/config.js";

describe("readConfig", () => {
  it("rejects intervals outside Node's timer range", () => {
    expect(() => readConfig({ ATLAS_CONNECTOR_INTERVAL_MS: "249" })).toThrow("250 to 2147483647");
    expect(() => readConfig({ ATLAS_CONNECTOR_INTERVAL_MS: "2147483648" })).toThrow("250 to 2147483647");
  });
});
