import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it, vi } from "vitest";
import { entityFixture, styleFixture } from "../../test/fixtures.js";
import { type AtlasContextValue, AtlasStaticProvider } from "../state/atlas-context.js";
import type { CommandInputFormProps } from "./commands/command-input-registry.js";
import { MapConsole } from "./MapConsole.js";

vi.mock("../ui/map/view/MapView.js", () => ({ MapView: () => <div>Fixture map</div> }));
vi.mock("./commands/command-input-registry.js", async () => {
  const { useState } = await import("react");
  return {
    COMMAND_INPUT_REGISTRY: {
      "fixture.queued": {
        targeting: "none",
        Form: function FixtureForm({ submitting, onSubmit, error }: CommandInputFormProps) {
          const [value, setValue] = useState("");
          return (
            <div>
              <input aria-label="Fixture input" value={value} onChange={(event) => setValue(event.target.value)} />
              <button type="button" disabled={submitting} onClick={() => onSubmit({ value })}>
                Submit fixture
              </button>
              {error ? <span role="alert">{error}</span> : null}
            </div>
          );
        }
      }
    }
  };
});

const manifest = {
  command: "fixture.queued",
  description: "Runs the fixture.",
  scheduling: "queued" as const,
  supports_cancel: true,
  supports_progress: true
};
const rover = entityFixture({ entity_id: "asset-1", alias: "Rover" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("MapConsole command revalidation", () => {
  it("retains entered data and an uncertain attempt through a telemetry detail refresh", async () => {
    const refreshedDetails = deferred<EntityResource>();
    const submitCommand = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue({});
    const loadEntityDetails = vi
      .fn()
      .mockResolvedValueOnce({ ...rover, command_manifest: [manifest] })
      .mockReturnValueOnce(refreshedDetails.promise);
    const value: AtlasContextValue = {
      status: "ready",
      config: {
        atlasBaseUrl: "/atlas",
        protocolRevision: "fixture",
        defaultMapSourceId: "fixture",
        mapSources: [{ id: "fixture", label: "Fixture", style: styleFixture("fixture") }],
        placeSearch: { provider: "maptiler", unavailableReason: "fixture" }
      },
      snapshot: { entities: { [rover.entity_id]: rover }, tasks: {} },
      catalog: [
        {
          command: manifest.command,
          name: "Fixture queued",
          description: "Exercise tasking.",
          input_schema: "atlas.protocol.JSONValue"
        }
      ],
      health: { running: true, healthy: true, degraded: false },
      reconnect: vi.fn(),
      submitCommand,
      loadEntityDetails,
      updateGeometry: vi.fn()
    };
    const view = render(
      <AtlasStaticProvider value={value}>
        <MapConsole />
      </AtlasStaticProvider>
    );
    fireEvent.click(await screen.findByText("Rover"));
    fireEvent.click(await screen.findByRole("button", { name: /Fixture queued/ }));
    const input = screen.getByRole("textbox", { name: "Fixture input" });
    fireEvent.change(input, { target: { value: "keep this input" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit fixture" }));
    await screen.findByText("response lost");

    const refreshedRover = { ...rover, metadata: { ...rover.metadata, version: rover.metadata.version + 1 } };
    view.rerender(
      <AtlasStaticProvider
        value={{ ...value, snapshot: { entities: { [rover.entity_id]: refreshedRover }, tasks: {} } }}
      >
        <MapConsole />
      </AtlasStaticProvider>
    );
    await waitFor(() => expect(loadEntityDetails).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("textbox", { name: "Fixture input" })).toBe(input);
    expect(input).toHaveValue("keep this input");
    expect(screen.getByRole("button", { name: "Submit fixture" })).toBeDisabled();

    await act(async () => refreshedDetails.resolve({ ...refreshedRover, command_manifest: [manifest] }));
    expect(screen.getByRole("textbox", { name: "Fixture input" })).toBe(input);
    expect(input).toHaveValue("keep this input");
    expect(screen.getByRole("button", { name: "Submit fixture" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Submit fixture" }));
    await waitFor(() => expect(submitCommand).toHaveBeenCalledTimes(2));
    expect(submitCommand.mock.calls[1]?.[0]).toEqual(submitCommand.mock.calls[0]?.[0]);
  });
});
