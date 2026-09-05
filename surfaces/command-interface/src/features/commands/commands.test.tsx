import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CommandAvailability } from "../../atlas/command-targeting.js";
import { CommandList } from "./CommandList.js";

const availability: CommandAvailability = {
  command: {
    command: "fixture.queued",
    name: "Fixture queued",
    description: "Exercise queued tasking.",
    input_schema: "atlas.fixture.FixtureInput"
  },
  manifest: {
    command: "fixture.queued",
    description: "Runs the fixture handler.",
    scheduling: "queued",
    supports_cancel: true,
    supports_progress: true
  },
  input: { targeting: "none", buildInput: () => ({ value: "fixture" }) }
};
const immediateAvailability: CommandAvailability = {
  command: {
    command: "fixture.immediate",
    name: "Fixture immediate",
    description: "Exercise immediate tasking.",
    input_schema: "atlas.fixture.FixtureInput"
  },
  manifest: {
    command: "fixture.immediate",
    description: "Runs the immediate fixture handler.",
    scheduling: "immediate",
    supports_cancel: false,
    supports_progress: false
  },
  input: { targeting: "none", buildInput: () => ({ value: "immediate" }) }
};

describe("CommandList", () => {
  it("renders the Asset-specific description and selects a Command", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<CommandList availabilities={[availability]} onPick={onPick} />);

    const button = screen.getByRole("button", { name: /Fixture queued/ });
    expect(button).toHaveTextContent("Protocol");
    expect(button).toHaveTextContent("Exercise queued tasking.");
    expect(button).toHaveTextContent("Runs the fixture handler.");
    expect(button).toHaveTextContent("Queued · Cancel yes · Progress yes");
    await user.click(button);
    expect(onPick).toHaveBeenCalledWith(availability);
  });

  it("shows immediate Commands with negative cancellation and progress capabilities", () => {
    render(<CommandList availabilities={[immediateAvailability]} onPick={() => {}} />);

    const button = screen.getByRole("button", { name: /Fixture immediate/ });
    expect(button).toHaveTextContent("Protocol");
    expect(button).toHaveTextContent("Exercise immediate tasking.");
    expect(button).toHaveTextContent("Runs the immediate fixture handler.");
    expect(button).toHaveTextContent("Immediate · Cancel no · Progress no");
  });

  it("renders the intentional no-Commands state", () => {
    render(
      <CommandList availabilities={[]} onPick={() => {}} emptyLabel="No Commands are defined in Atlas Protocol" />
    );
    expect(screen.getByText("No Commands are defined in Atlas Protocol")).toBeInTheDocument();
  });

  it("disables retained Commands while their manifest is not ready", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<CommandList availabilities={[availability]} onPick={onPick} disabled />);

    const button = screen.getByRole("button", { name: /Fixture queued/ });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onPick).not.toHaveBeenCalled();
  });
});
