import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./console.css", import.meta.url), "utf8");

describe("primary control target sizes", () => {
  it.each([".rail-button", ".btn", ".icon-button", ".menu-item", ".unavailable-commands summary"])("keeps %s at least 44px tall", (selector) => {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(css).toMatch(new RegExp(`${escapedSelector}\\s*\\{[^}]*(?:min-)?height:\\s*44px`, "s"));
  });

  it("keeps MapLibre navigation buttons at 44px in both dimensions", () => {
    expect(css).toMatch(/\.map-canvas \.maplibregl-ctrl-group button\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s);
  });

  it("keeps the account control at the same 44px target size", () => {
    expect(readFileSync(new URL("./tokens.css", import.meta.url), "utf8")).toMatch(/--rail-brand-size:\s*44px/);
  });
});
