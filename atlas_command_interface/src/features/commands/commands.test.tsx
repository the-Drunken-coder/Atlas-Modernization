import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { EntityResource, JSONValue } from "@the-drunken-coder/atlas-sdk";
import { parseCommandCatalog } from "../../atlas/command-model.js";
import { commandsForTargeting, formParameters } from "../../atlas/command-targeting.js";
import { CommandActions } from "./CommandActions.js";
import { CommandForm } from "./CommandForm.js";
import { CommandList } from "./CommandList.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

const catalog = parseCommandCatalog({
  type: "command_catalog",
  name: "Catalog",
  description: "Test",
  commands: [
    { id: "hold_position", name: "Hold Position", description: "Hold here.", parameters_schema: {} },
    { id: "return_to_home", name: "Return To Home", description: "Go home.", parameters_schema: {} },
    {
      id: "move_to_location",
      name: "Move To Location",
      description: "Fly somewhere.",
      parameters_schema: {
        latitude: { type: "number", description: "Latitude", minimum: -90, maximum: 90, required: true },
        longitude: { type: "number", description: "Longitude", minimum: -180, maximum: 180, required: true },
        altitude_m: { type: "number", description: "Altitude", minimum: 0, maximum: 500, required: true }
      }
    }
  ] as JSONValue[]
} as unknown);

function asset(supported: string[]): EntityResource {
  return { entity_id: "asset-1", entity_type: "asset", subtype: null, alias: "Rover", components: { task_catalog: { supported_tasks: supported } }, metadata };
}

describe("CommandList", () => {
  it("keeps supported commands prominent and reveals unsupported reasons on demand", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const availabilities = commandsForTargeting(catalog, asset(["hold_position"]), "none");
    render(<CommandList availabilities={availabilities} onPick={onPick} />);

    const hold = screen.getByRole("button", { name: /Hold Position/ });
    expect(screen.queryByRole("button", { name: /Return To Home/ })).not.toBeInTheDocument();
    const unavailable = screen.getByText("1 unavailable command").closest("details");
    expect(unavailable).not.toHaveAttribute("open");

    await user.click(hold);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].command.id).toBe("hold_position");

    await user.click(screen.getByText("1 unavailable command"));
    expect(unavailable).toHaveAttribute("open");
    expect(screen.getByText("Return To Home")).toBeInTheDocument();
    expect(screen.getByText("This asset does not support this command")).toBeInTheDocument();

    await user.click(screen.getByText("Return To Home"));
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});

describe("CommandActions", () => {
  it("does not claim there are no commands when only a supported position command exists", () => {
    const positionOnlyCatalog = parseCommandCatalog({
      type: "command_catalog",
      name: "Position catalog",
      description: "Test",
      commands: [catalog.commands.find((command) => command.id === "move_to_location")!]
    });

    render(
      <CommandActions
        entity={asset(["move_to_location"])}
        catalog={positionOnlyCatalog}
        positionPicking={false}
        onPickCommand={() => {}}
        onTogglePositionPicking={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: "Choose map position" })).toBeInTheDocument();
    expect(screen.queryByText("No commands available")).not.toBeInTheDocument();
  });
});

describe("CommandForm", () => {
  const command = catalog.commands.find((entry) => entry.id === "move_to_location")!;
  const params = formParameters(command, "map_point");

  it("submits map-point coordinates plus required parameters", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <CommandForm
        command={command}
        targeting="map_point"
        formParameters={params}
        mapPoint={{ lat: 40.1, lng: -74.2 }}
        submitting={false}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />
    );

    const send = screen.getByRole("button", { name: "Send command" });
    expect(send).toBeDisabled();

    await user.type(screen.getByRole("spinbutton"), "120");
    expect(send).toBeEnabled();
    await user.click(send);

    expect(onSubmit).toHaveBeenCalledWith({ latitude: 40.1, longitude: -74.2, altitude_m: 120 });
  });

  it("traps modal focus, closes on Escape, and restores trigger focus", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open command
          </button>
          {open ? (
            <CommandForm
              command={command}
              targeting="map_point"
              formParameters={params}
              mapPoint={{ lat: 40.1, lng: -74.2 }}
              submitting={false}
              onCancel={() => setOpen(false)}
              onSubmit={() => {}}
            />
          ) : null}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open command" });
    await user.click(trigger);

    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    trigger.focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    trigger.focus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("can hide a pending submission without offering a duplicate send", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <CommandForm
        command={command}
        targeting="map_point"
        formParameters={params}
        mapPoint={{ lat: 40.1, lng: -74.2 }}
        submitting
        onCancel={onCancel}
        onSubmit={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Hide" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Hide pending command" })).toHaveFocus();

    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Hide" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps submit disabled when numeric parameters are outside bounds", async () => {
    const user = userEvent.setup();
    render(
      <CommandForm
        command={command}
        targeting="map_point"
        formParameters={params}
        mapPoint={{ lat: 40.1, lng: -74.2 }}
        submitting={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    );

    const send = screen.getByRole("button", { name: "Send command" });
    const altitude = screen.getByRole("spinbutton");
    await user.type(altitude, "120");
    expect(send).toBeEnabled();

    await user.clear(altitude);
    await user.type(altitude, "600");
    expect(send).toBeDisabled();
    expect(screen.getByText("Must be <= 500")).toBeInTheDocument();
  });

  it("keeps submit disabled without finite map coordinates", async () => {
    const user = userEvent.setup();
    render(
      <CommandForm
        command={command}
        targeting="map_point"
        formParameters={params}
        mapPoint={{ lat: Number.NaN, lng: -74.2 }}
        submitting={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    );

    await user.type(screen.getByRole("spinbutton"), "120");
    expect(screen.getByRole("button", { name: "Send command" })).toBeDisabled();
  });

  it("submits optional boolean parameters when explicitly set to false", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const booleanCommand = {
      id: "set_flag",
      name: "Set Flag",
      description: "Toggle a flag.",
      parameters_schema: {
        flag: { type: "boolean", description: "Optional flag", required: false }
      }
    } as const;

    render(
      <CommandForm
        command={booleanCommand}
        targeting="none"
        formParameters={[["flag", booleanCommand.parameters_schema.flag]]}
        submitting={false}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />
    );

    const flag = screen.getByRole("checkbox", { name: "flag" });
    await user.click(flag);
    await user.click(flag);
    await user.click(screen.getByRole("button", { name: "Send command" }));

    expect(onSubmit).toHaveBeenCalledWith({ flag: false });
  });
});
