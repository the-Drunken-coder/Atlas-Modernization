import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./map.css", import.meta.url), "utf8");

const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)}/g), ([, selectors, declarations]) => ({
  declarations,
  selectors: selectors.split(",").map((selector) => selector.trim())
}));

function declarationsFor(selector: string) {
  return rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.declarations);
}

function declarationsForSelectorsContaining(...fragments: string[]) {
  return rules
    .filter((rule) => rule.selectors.some((selector) => fragments.every((fragment) => selector.includes(fragment))))
    .map((rule) => rule.declarations);
}

function ruleFor(selector: string) {
  return declarationsFor(selector).join("\n");
}

describe("map window source provenance", () => {
  it("keeps the expanded footer on one line", () => {
    const footer = ruleFor(".map-window__footer");
    const source = ruleFor(".spatial-map-window__source");

    expect(footer).toMatch(/display:\s*flex/);
    expect(footer).toMatch(/align-items:\s*center/);
    expect(source).toMatch(/text-overflow:\s*ellipsis/);
    expect(source).toMatch(/white-space:\s*nowrap/);
  });

  it("wraps source provenance and retrieval time above collapsed attribution", () => {
    const footer = ruleFor(".map-window__peek-footer");
    const allFooterRules = declarationsForSelectorsContaining(".map-window__peek-footer").join("\n");
    const sourceSelector = ".map-window__peek-footer .spatial-map-window__source";
    const source = ruleFor(sourceSelector);
    const allSourceRules = declarationsForSelectorsContaining(".spatial-map-window__source").join("\n");
    const focusReveal = ruleFor(".map-window--handle:focus-within .map-window__peek");

    expect(footer).toMatch(/display:\s*grid/);
    expect(footer).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(footer).toMatch(/overflow-y:\s*auto/);
    expect(allFooterRules).not.toMatch(/display:\s*none/);
    expect(allFooterRules).not.toMatch(/visibility:\s*hidden/);
    expect(source).toMatch(/overflow:\s*visible/);
    expect(source).toMatch(/overflow-wrap:\s*anywhere/);
    expect(source).toMatch(/text-overflow:\s*clip/);
    expect(source).toMatch(/white-space:\s*normal/);
    expect(allSourceRules).not.toMatch(/display:\s*none/);
    expect(allSourceRules).not.toMatch(/visibility:\s*hidden/);
    expect(focusReveal).toMatch(/visibility:\s*visible/);
  });

  it("caps long collapsed provenance at the workspace height", () => {
    const workspace = ruleFor(".map-window-workspace");
    const peek = ruleFor(".map-window__peek");
    const horizontalPeek = ruleFor('.map-window--handle[data-edge="top"] .map-window__peek');

    expect(workspace).toMatch(/container-type:\s*size/);
    expect(peek).toMatch(/grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
    expect(peek).toMatch(/max-block-size:\s*100cqh/);
    expect(horizontalPeek).toMatch(/max-block-size:\s*calc\(100cqh\s*-\s*38px\)/);
  });

  it("clamps peeks by their rendered size at every dock position", () => {
    const sidePeek = ruleFor('.map-window--handle[data-edge="right"] .map-window__peek');
    const horizontalPeek = ruleFor('.map-window--handle[data-edge="top"] .map-window__peek');

    expect(sidePeek).toMatch(/transform:\s*translateY\(\s*clamp\(/);
    expect(sidePeek).toMatch(/calc\(0px\s*-\s*var\(--map-window-dock-position\)\)/);
    expect(sidePeek).toMatch(/calc\(100cqh\s*-\s*var\(--map-window-dock-position\)\s*-\s*100%\)/);
    expect(horizontalPeek).toMatch(/transform:\s*translateX\(\s*clamp\(/);
    expect(horizontalPeek).toMatch(/calc\(100cqw\s*-\s*var\(--map-window-dock-position\)\s*-\s*100%\)/);
    expect(css).not.toContain("data-peek-align");
  });
});
