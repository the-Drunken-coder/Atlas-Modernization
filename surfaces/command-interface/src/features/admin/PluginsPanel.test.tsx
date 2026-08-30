import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AtlasAPIError, type PluginStatus } from "@the-drunken-coder/atlas-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { styleFixture } from "../../../test/fixtures.js";
import { emptySnapshot } from "../../atlas/store.js";
import { type AtlasContextValue, AtlasStaticProvider } from "../../state/atlas-context.js";
import { PluginsPanel } from "./PluginsPanel.js";

const available: PluginStatus = {
  plugin_id: "reference",
  display_name: "Reference Fixture",
  status: "available",
  reason_code: null,
  checked_at: "2026-08-28T12:00:00Z",
  operations: [{ operation_id: "inspect_fixture", display_name: "Inspect fixture", timeout_ms: 5000 }],
  tool_asset_id: null
};

const starting: PluginStatus = {
  plugin_id: "starting_plugin",
  display_name: null,
  status: "starting",
  reason_code: null,
  checked_at: null,
  operations: [],
  tool_asset_id: null
};

const unavailable: PluginStatus = {
  ...available,
  plugin_id: "weather_feed",
  display_name: "Weather Feed",
  status: "unavailable",
  reason_code: "transport_timeout"
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PluginsPanel", () => {
  it("renders dense available, starting, and unavailable status rows", async () => {
    renderPanel({ list: vi.fn(async () => [available, starting, unavailable]) });

    expect(await screen.findByText("Reference Fixture")).toBeInTheDocument();
    expect(screen.getAllByText("starting_plugin")).toHaveLength(2);
    expect(screen.getByText("transport timeout")).toBeInTheDocument();
    expect(screen.getAllByText("inspect_fixture")).toHaveLength(2);
    expect(screen.queryByText(/invoke/i)).not.toBeInTheDocument();
  });

  it("reports the empty configuration state", async () => {
    renderPanel({ list: vi.fn(async () => []) });
    expect(await screen.findByText("No Plugins are configured.")).toBeInTheDocument();
  });

  it("polls while mounted, refreshes manually, retains stale data, and aborts on close", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const signals: AbortSignal[] = [];
    const list = vi
      .fn<(options?: { signal?: AbortSignal }) => Promise<PluginStatus[]>>()
      .mockImplementationOnce(async (options) => {
        if (options?.signal) signals.push(options.signal);
        return [available];
      })
      .mockRejectedValueOnce(new Error("gateway offline"))
      .mockImplementation((options) => {
        if (options?.signal) signals.push(options.signal);
        return new Promise(() => undefined);
      });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = renderPanel({ list });

    expect(await screen.findByText("Reference Fixture")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Refresh failed. Showing last successful check.")).toBeInTheDocument();
    expect(screen.getByText("Reference Fixture")).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(list).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(list).toHaveBeenCalledTimes(3);
    view.unmount();
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it("dispatches auth expiry and supports roving keyboard focus", async () => {
    const expired = vi.fn();
    window.addEventListener("atlas-auth-expired", expired);
    const reader = {
      list: vi
        .fn<() => Promise<PluginStatus[]>>()
        .mockResolvedValueOnce([available, unavailable])
        .mockRejectedValueOnce(new AtlasAPIError("unauthorized", 401, {}))
    };
    const user = userEvent.setup();
    try {
      renderPanel(reader);
      const rows = await screen.findAllByRole("row");
      const firstDataRow = rows[1];
      const secondDataRow = rows[2];
      firstDataRow.focus();
      await user.keyboard("{ArrowDown}");
      expect(secondDataRow).toHaveFocus();

      await user.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
      expect(screen.getByText("Reference Fixture")).toBeInTheDocument();
    } finally {
      window.removeEventListener("atlas-auth-expired", expired);
    }
  });
});

function renderPanel(reader: { list(options?: { signal?: AbortSignal }): Promise<PluginStatus[]> }) {
  const value: AtlasContextValue = {
    status: "ready",
    config: {
      atlasBaseUrl: "https://core.test",
      protocolRevision: "rev",
      defaultMapSourceId: "openstreetmap-default",
      placeSearch: { provider: "maptiler", unavailableReason: "missing key" },
      mapSources: [
        { id: "openstreetmap-default", label: "OpenStreetMap Default", style: styleFixture("openstreetmap-default") }
      ]
    },
    snapshot: emptySnapshot(),
    health: { running: true, healthy: true, degraded: false },
    reconnect() {},
    submitCommand: async () => {
      throw new Error("not used");
    },
    updateGeometry: async () => {
      throw new Error("not used");
    }
  };
  return render(
    <AtlasStaticProvider value={value}>
      <PluginsPanel reader={reader} />
    </AtlasStaticProvider>
  );
}
