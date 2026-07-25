import { describe, expect, it } from "vitest";
import { appendMilsymbolSourceMapReference } from "../vite.config.js";

describe("Milsymbol source-map output", () => {
  it("adds a relative source-map reference to the hashed runtime asset", () => {
    const source = "window.ms = {};";

    expect(appendMilsymbolSourceMapReference(source, "assets/milsymbol-C66lyuqP.js")).toBe(
      `${source}\n//# sourceMappingURL=milsymbol.js.map\n`
    );
  });

  it("does not add the reference to unrelated or already-mapped output", () => {
    const source = "window.ms = {};";
    const mappedSource = `${source}\n//# sourceMappingURL=existing.js.map`;

    expect(appendMilsymbolSourceMapReference(source, "assets/other.js")).toBe(source);
    expect(appendMilsymbolSourceMapReference(mappedSource, "assets/milsymbol-C66lyuqP.js")).toBe(mappedSource);
  });
});
