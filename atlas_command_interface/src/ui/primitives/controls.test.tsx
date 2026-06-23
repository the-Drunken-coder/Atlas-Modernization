import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelectField, TextField } from "./controls.js";

describe("form controls", () => {
  it("connects TextField labels to generated input ids", () => {
    render(<TextField label="Callsign" />);

    const input = screen.getByLabelText("Callsign");
    expect(input).toHaveAttribute("id");
  });

  it("connects SelectField labels to generated select ids", () => {
    render(
      <SelectField
        label="Layer"
        options={[
          { value: "assets", label: "Assets" },
          { value: "tracks", label: "Tracks" }
        ]}
      />
    );

    const select = screen.getByLabelText("Layer");
    expect(select).toHaveAttribute("id");
  });
});
