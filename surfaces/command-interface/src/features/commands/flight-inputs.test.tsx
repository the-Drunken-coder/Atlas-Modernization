import { fireEvent, render, screen } from "@testing-library/react";
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
  it.each(["", " ", "10m", "10,5", "10 trailing", "Infinity", "NaN", "0x10", "1e2", "9".repeat(400), "0.1", "0.3"])(
    "withholds invalid takeoff height %s",
    (height) => {
      const onSubmit = vi.fn();
      const asset = entityFixture({
        components: {
          telemetry: {
            launch_elevation_m: 560,
            last_update: new Date().toISOString()
          }
        }
      });
      render(<TakeoffForm {...takeoffProps(asset, onSubmit)} />);
      fireEvent.change(screen.getByLabelText(/Height above launch/), { target: { value: height } });
      expect(screen.getByRole("button", { name: /Submit takeoff/ })).toBeDisabled();
      fireEvent.submit(screen.getByRole("form", { name: "Takeoff" }));
      expect(onSubmit).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, "2020-01-01T00:00:00Z", "2036-01-01T00:00:00Z"])(
    "withholds takeoff without a fresh launch reference at %s",
    (last_update) => {
      const onSubmit = vi.fn();
      const asset = entityFixture({ components: { telemetry: { launch_elevation_m: 560, last_update } } });
      render(<TakeoffForm {...takeoffProps(asset, onSubmit)} />);
      fireEvent.change(screen.getByLabelText(/Height above launch/), { target: { value: "10" } });
      expect(screen.getByRole("button", { name: /Submit takeoff/ })).toBeDisabled();
    }
  );

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

  it("rechecks launch telemetry freshness when submitting an idle form", () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const onSubmit = vi.fn();
      const asset = entityFixture({
        components: {
          telemetry: {
            launch_elevation_m: 560,
            last_update: new Date(now).toISOString()
          }
        }
      });
      render(<TakeoffForm {...takeoffProps(asset, onSubmit)} />);
      fireEvent.change(screen.getByLabelText(/Height above launch/), { target: { value: "10" } });
      expect(screen.getByRole("button", { name: /Submit takeoff/ })).toBeEnabled();
      clock.mockReturnValue(now + 10_001);
      fireEvent.submit(screen.getByRole("form", { name: "Takeoff" }));
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
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

  it.each(["", " ", "10m", "10,5", "10 trailing", "Infinity", "NaN", "0x10", "1e2", "9".repeat(400)])(
    "withholds invalid go-to altitude %s",
    (altitude) => {
      const onSubmit = vi.fn();
      render(<GotoForm {...gotoProps(entityFixture({}), onSubmit)} />);
      fireEvent.change(screen.getByLabelText(/Altitude/), { target: { value: altitude } });
      expect(screen.getByRole("button", { name: /Submit go-to/ })).toBeDisabled();
      fireEvent.submit(screen.getByRole("form", { name: "Go to" }));
      expect(onSubmit).not.toHaveBeenCalled();
    }
  );

  it.each([
    [" -10.5 ", -10.5],
    ["+.5", 0.5],
    ["0", 0]
  ] as const)("accepts signed decimal MSL altitude %s", async (text, altitude_m) => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<GotoForm {...gotoProps(entityFixture({}), onSubmit)} />);
    fireEvent.change(screen.getByLabelText(/Altitude/), { target: { value: text } });
    await user.click(screen.getByRole("button", { name: /Submit go-to/ }));
    expect(onSubmit).toHaveBeenCalledWith({ latitude: 37.7749, longitude: -122.4194, altitude_m });
  });

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
