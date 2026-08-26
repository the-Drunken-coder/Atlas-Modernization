import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("./layout.css", import.meta.url), "utf8");

describe("command interface scrolling", () => {
  it("locks the document viewport", () => {
    const declarations = tokens.match(/html,\s*body,\s*#root\s*{([^}]*)}/)?.[1];

    expect(declarations).toMatch(/overflow:\s*hidden/);
    expect(declarations).toMatch(/overscroll-behavior:\s*none/);
  });

  it("keeps vertical overflow inside the sidebar panel", () => {
    const declarations = layout.match(/\.panel__body\s*{([^}]*)}/)?.[1];

    expect(declarations).toMatch(/overflow-y:\s*auto/);
    expect(declarations).toMatch(/overscroll-behavior-y:\s*none/);
  });
});
