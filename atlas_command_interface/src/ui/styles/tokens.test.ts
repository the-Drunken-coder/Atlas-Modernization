import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Rgb = readonly [number, number, number];

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const blueprintCss = readFileSync(
  new URL("../../../../node_modules/@blueprintjs/core/lib/css/blueprint.css", import.meta.url),
  "utf8"
);

function token(name: string): Rgb {
  const value = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  if (!value) throw new Error(`Missing hex color token --${name}`);
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16)
  ];
}

function mix(foreground: Rgb, background: Rgb, opacity: number): Rgb {
  return [
    Math.round(foreground[0] * opacity + background[0] * (1 - opacity)),
    Math.round(foreground[1] * opacity + background[1] * (1 - opacity)),
    Math.round(foreground[2] * opacity + background[2] * (1 - opacity))
  ];
}

function luminance(color: Rgb): number {
  const [red, green, blue] = color.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: Rgb, background: Rgb): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("command interface tokens", () => {
  it("keeps muted text readable across its rendered backgrounds", () => {
    const mutedText = token("text-3");
    const accent = token("accent");
    const surface1 = token("surface-1");
    const surface2 = token("surface-2");
    const backgrounds = [
      token("bg-base"),
      surface1,
      surface2,
      token("surface-3"),
      mix(accent, surface1, 0.2),
      mix(accent, surface2, 0.2)
    ];

    for (const background of backgrounds) {
      expect(contrast(mutedText, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps primary button text readable against the amber accent", () => {
    expect(contrast(token("text-on-accent"), token("accent"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the decorative select chevron out of pointer hit testing", () => {
    const declarations = blueprintCss.match(/\.bp6-html-select \.bp6-icon,[^{]+{([^}]*)}/)?.[1];
    expect(declarations).toMatch(/pointer-events:\s*none/);
  });

  it("uses the product selection color for Blueprint button focus", () => {
    const declarations = css.match(/\.bp6-button:focus-visible\s*{([^}]*)}/)?.[1];
    expect(declarations).toMatch(/outline:\s*2px solid var\(--selected-ring\)/);
  });
});
