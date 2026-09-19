import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { entityFixture } from "../../../test/fixtures.js";
import type { CommandInputFormProps } from "./command-input-registry.js";
import { GotoForm, LandForm, ReturnToLaunchForm, TakeoffForm } from "./flight-inputs.js";

function takeoffProps(asset: ReturnType<typeof entityFixture>, onSubmit: (input: unknown) => void) {
  return {
    asset,
    command: {
      command: "flight.takeoff",
      name: "Takeoff",
      description: "Climb.",
      input_schema: "atlas.flight.TakeoffRequest"
    },
    submitting: false,
    error: undefined,
    onCancel: () => {},
    onSubmit: onSubmit as CommandInputFormProps["onSubmit"]
  } satisfies CommandInputFormProps;
}

describe("TakeoffForm", () => {
  it("converts height above launch to mean sea level before submitting", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const asset = entityFixture({
      components: { telemetry: { launch_elevation_m: 560, last_update: new Date().toISOString() } }
    });
    render(<TakeoffForm {...takeoffProps(asset, onSubmit)} />);

    await user.type(screen.getByLabelText(/Height above launch/), "10");
    await user.click(screen.getByRole("button", { name: /Submit takeoff/ }));
    expect(onSubmit).toHaveBeenCalledWith({ altitude_m: 570 });
  });

  it("withholds submission without verified launch elevation", () => {
    const onSubmit = vi.fn();
    render(<TakeoffForm {...takeoffProps(entityFixture({}), onSubmit)} />);
    expect(screen.getByRole("button", { name: /Submit takeoff/ })).toBeDisabled();
    expect(screen.getByText(/not verified yet/)).toBeInTheDocument();
  });
});

describe("GotoForm", () => {
  function gotoProps(
    asset: ReturnType<typeof entityFixture>,
    onSubmit: (input: unknown) => void,
    mapPoint = { lat: 37.7749, lng: -122.4194 }
  ) {
    return {
      asset,
      command: {
        command: "flight.goto",
        name: "Go to",
        description: "Fly.",
        input_schema: "atlas.flight.GotoRequest"
      },
      mapPoint,
      submitting: false,
      error: undefined,
      onCancel: () => {},
      onSubmit: onSubmit as CommandInputFormProps["onSubmit"]
    } satisfies CommandInputFormProps;
  }

  it("prefills altitude from fresh telemetry but only submits explicitly", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const asset = entityFixture({
      components: {
        telemetry: { altitude_m: 590, last_update: new Date().toISOString() }
      }
    });
    render(<GotoForm {...gotoProps(asset, onSubmit)} />);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Altitude/)).toHaveValue("590");
    await user.click(screen.getByRole("button", { name: /Submit go-to/ }));
    expect(onSubmit).toHaveBeenCalledWith({ latitude: 37.7749, longitude: -122.4194, altitude_m: 590 });
  });

  it("requires explicit altitude entry when telemetry is stale", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const asset = entityFixture({
      components: {
        telemetry: { altitude_m: 590, last_update: "2020-01-01T00:00:00Z" }
      }
    });
    render(<GotoForm {...gotoProps(asset, onSubmit)} />);

    expect(screen.getByLabelText(/Altitude/)).toHaveValue("");
    expect(screen.getByRole("button", { name: /Submit go-to/ })).toBeDisabled();
    expect(screen.getByText(/enter the destination height explicitly/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Altitude/), "595");
    await user.click(screen.getByRole("button", { name: /Submit go-to/ }));
    expect(onSubmit).toHaveBeenCalledWith({ latitude: 37.7749, longitude: -122.4194, altitude_m: 595 });
  });
});

describe("recovery confirms", () => {
  it("submits empty recovery inputs only on explicit confirmation", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const base = {
      asset: entityFixture({}),
      command: {
        command: "flight.return_to_launch",
        name: "Return to launch",
        description: "Recover.",
        input_schema: "atlas.tasking.EmptyObject"
      },
      submitting: false,
      error: undefined,
      onCancel: () => {},
      onSubmit: onSubmit as CommandInputFormProps["onSubmit"]
    } satisfies CommandInputFormProps;
    const { unmount } = render(<ReturnToLaunchForm {...base} />);
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Submit return to launch/ }));
    expect(onSubmit).toHaveBeenCalledWith({});
    unmount();

    const onLand = vi.fn();
    render(
      <LandForm
        {...base}
        command={{
          command: "flight.land",
          name: "Land",
          description: "Land.",
          input_schema: "atlas.tasking.EmptyObject"
        }}
        onSubmit={onLand as CommandInputFormProps["onSubmit"]}
      />
    );
    await user.click(screen.getByRole("button", { name: /Submit land/ }));
    expect(onLand).toHaveBeenCalledWith({});
  });
});
