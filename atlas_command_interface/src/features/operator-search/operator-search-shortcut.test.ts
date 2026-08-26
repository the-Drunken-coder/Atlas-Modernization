import { describe, expect, it } from "vitest";
import { isOperatorSearchShortcut, operatorSearchShortcutLabel } from "./operator-search-shortcut.js";

describe("operator search shortcut", () => {
  it("uses Command+K on macOS", () => {
    expect(isOperatorSearchShortcut({ key: "k", metaKey: true, ctrlKey: false, altKey: false }, "MacIntel")).toBe(true);
    expect(isOperatorSearchShortcut({ key: "k", metaKey: false, ctrlKey: true, altKey: false }, "MacIntel")).toBe(
      false
    );
    expect(operatorSearchShortcutLabel("MacIntel")).toBe("⌘K");
  });

  it("uses Control+K elsewhere and rejects alternate modifiers", () => {
    expect(isOperatorSearchShortcut({ key: "K", metaKey: false, ctrlKey: true, altKey: false }, "Linux")).toBe(true);
    expect(isOperatorSearchShortcut({ key: "k", metaKey: false, ctrlKey: true, altKey: true }, "Linux")).toBe(false);
    expect(operatorSearchShortcutLabel("Linux")).toBe("Ctrl K");
  });
});
