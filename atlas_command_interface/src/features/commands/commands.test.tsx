import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { EntityResource, JSONValue } from "../../../../atlas_sdk/src/index.js";
import { parseCommandCatalog } from "../../atlas/command-model.js";
import { commandsForTargeting, formParameters } from "../../atlas/command-targeting.js";
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
  it("lists valid non-position commands first and greys out unsupported ones", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const availabilities = commandsForTargeting(catalog, asset(["hold_position"]), "none");
    render(<CommandList availabilities={availabilities} onPick={onPick} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveTextContent("Hold Position");
    expect(buttons[1]).toHaveTextContent("Return To Home");
    expect(buttons[1]).toBeDisabled();
    expect(buttons[1]).toHaveAttribute("title", "This asset does not support this command");

    await user.click(buttons[0]);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].command.id).toBe("hold_position");

    await user.click(buttons[1]);
    expect(onPick).toHaveBeenCalledTimes(1);
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
        credential="secret"
        onCredentialChange={() => {}}
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

  it("keeps submit disabled when numeric parameters are outside bounds", async () => {
    const user = userEvent.setup();
    render(
      <CommandForm
        command={command}
        targeting="map_point"
        formParameters={params}
        mapPoint={{ lat: 40.1, lng: -74.2 }}
        credential="secret"
        onCredentialChange={() => {}}
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

  it("keeps submit disabled without a command key", () => {
    render(
      <CommandForm
        command={command}
        targeting="map_point"
        formParameters={params}
        mapPoint={{ lat: 1, lng: 2 }}
        credential=""
        onCredentialChange={() => {}}
        submitting={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Send command" })).toBeDisabled();
  });

  it("keeps submit disabled without finite map coordinates", async () => {
    const user = userEvent.setup();
    render(
      <CommandForm
        command={command}
        targeting="map_point"
        formParameters={params}
        mapPoint={{ lat: Number.NaN, lng: -74.2 }}
        credential="secret"
        onCredentialChange={() => {}}
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
        credential="secret"
        onCredentialChange={() => {}}
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
