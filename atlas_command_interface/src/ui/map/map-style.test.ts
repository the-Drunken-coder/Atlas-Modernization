import { describe, expect, it } from "vitest";
import { defaultBlankStyle } from "./map-style.js";

describe("defaultBlankStyle", () => {
  it("does not request external map tiles", () => {
    const style = defaultBlankStyle();

    expect(style.sources).toEqual({});
    expect(style.layers).toEqual([{ id: "background", type: "background", paint: { "background-color": "#070a0f" } }]);
    expect(JSON.stringify(style)).not.toContain("://");
  });
});
