import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("./layout.css", import.meta.url), "utf8");
const tooltip = readFileSync(new URL("../primitives/Tooltip.tsx", import.meta.url), "utf8");

describe("command interface scrolling", () => {
  it("locks the authenticated workspace without clipping the login page", () => {
    const rootDeclarations = tokens.match(/html,\s*body,\s*#root\s*{([^}]*)}/)?.[1];
    const shellDeclarations = layout.match(/\.authenticated-shell\s*{([^}]*)}/)?.[1];

    expect(rootDeclarations).not.toMatch(/overflow(?:-[xy])?\s*:\s*(?:hidden|clip)/);
    expect(rootDeclarations).toMatch(/overscroll-behavior:\s*none/);
    expect(shellDeclarations).toMatch(/overflow:\s*hidden/);
    expect(shellDeclarations).toMatch(/overscroll-behavior:\s*none/);
  });

  it("keeps vertical overflow inside the sidebar panel", () => {
    const declarations = layout.match(/\.panel__body\s*{([^}]*)}/)?.[1];

    expect(declarations).toMatch(/overflow-y:\s*auto/);
    expect(declarations).toMatch(/overscroll-behavior-y:\s*none/);
  });

  it("keeps rail controls reachable at short viewport heights", () => {
    const declarations = layout.match(/\.rail\s*{([^}]*)}/)?.[1];

    expect(declarations).toMatch(/overflow-y:\s*auto/);
    expect(declarations).toMatch(/overscroll-behavior-y:\s*none/);
  });

  it("delegates portaled tooltip positioning to Blueprint", () => {
    expect(tooltip).toMatch(/Tooltip as BlueprintTooltip/);
    expect(tooltip).toMatch(/<BlueprintTooltip/);
  });

  it("positions the portaled account menu against the viewport", () => {
    const declarations = layout.match(/\.account-menu__popover\s*{([^}]*)}/)?.[1];

    expect(declarations).toMatch(/position:\s*fixed/);
    expect(declarations).toMatch(/max-height:\s*calc\(100dvh\s*-\s*16px\)/);
    expect(declarations).toMatch(/overflow-y:\s*auto/);
  });
});
