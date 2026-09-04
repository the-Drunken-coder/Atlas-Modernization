import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginStatus, SpatialOperationResult } from "@the-drunken-coder/atlas-sdk";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { styleFixture } from "../../../test/fixtures.js";
import { emptySnapshot } from "../../atlas/store.js";
import { ATLAS_AUTH_EXPIRED_EVENT, rotateAuthSession } from "../../auth/atlas.js";
import { type AtlasContextValue, AtlasStaticProvider } from "../../state/atlas-context.js";
import { MapWindowWorkspace } from "../../ui/map/view/MapWindowWorkspace.js";
import { SpatialResultsInspector } from "../plugins/SpatialResultsInspector.js";
import { type SpatialOperationExecutor, useSpatialOperationRunner } from "../plugins/use-spatial-operation-runner.js";
import { type PluginSelection, PluginsPanel } from "./PluginsPanel.js";

const available: PluginStatus = {
  plugin_id: "reference",
  display_name: "Reference Fixture",
  status: "available",
  reason_code: null,
  checked_at: "2026-08-28T12:00:00Z",
  operations: [
    {
      operation_id: "inspect_fixture",
      display_name: "Inspect fixture",
      timeout_ms: 5000,
      interaction: { kind: "map_area" }
    }
  ],
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
    renderPanel({
      list: vi.fn(async () => [available, starting, unavailable])
    });

    expect(await screen.findByText("Reference Fixture")).toBeInTheDocument();
    expect(screen.getByText("starting_plugin")).toBeInTheDocument();
    expect(screen.getByText(/unavailable: transport timeout/)).toBeInTheDocument();
    expect(screen.queryByText("inspect_fixture")).not.toBeInTheDocument();
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
    expect(await screen.findByText("Refresh failed. Showing the last check.")).toBeInTheDocument();
    expect(screen.getByText("Reference Fixture")).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(list).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(list).toHaveBeenCalledTimes(3);
    view.unmount();
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it("keeps a polling failure visible in the selected plugin detail and marks its status unknown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reader = {
      list: vi
        .fn<() => Promise<PluginStatus[]>>()
        .mockResolvedValueOnce([available])
        .mockRejectedValueOnce(new Error("gateway offline"))
    };
    renderPanel(reader, { pluginId: available.plugin_id, name: available.display_name ?? available.plugin_id });

    expect(await screen.findByText(/available · 1 operation/)).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await screen.findByRole("alert")).toHaveTextContent("gateway offline");
    expect(screen.getByText(/status unknown \(last check: available\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inspect fixture/ })).toBeDisabled();
  });

  it("keeps a discovery error visible while a retry is pending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let releaseRetry!: (next: PluginStatus[]) => void;
    const retry = new Promise<PluginStatus[]>((resolve) => {
      releaseRetry = resolve;
    });
    const reader = {
      list: vi
        .fn<() => Promise<PluginStatus[]>>()
        .mockResolvedValueOnce([available])
        .mockRejectedValueOnce(new Error("gateway offline"))
        .mockImplementationOnce(() => retry)
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(reader);

    expect(await screen.findByText("Reference Fixture")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("gateway offline");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.getByRole("alert")).toHaveTextContent("gateway offline");
    expect(screen.getByText(/status unknown \(last check: available\)/)).toBeInTheDocument();

    releaseRetry([available]);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("keeps a polling failure visible and disables stale operation controls", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reader = {
      list: vi
        .fn<() => Promise<PluginStatus[]>>()
        .mockResolvedValueOnce([available])
        .mockRejectedValueOnce(new Error("gateway offline"))
    };
    const executor: SpatialOperationExecutor = {
      invokeSpatial: vi.fn(async () => spatialResponse())
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    renderSpatialPanel(reader, executor);
    await openSpatialOperation(user, available.display_name ?? available.plugin_id, "Inspect fixture");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await screen.findByRole("alert")).toHaveTextContent("gateway offline");
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(executor.invokeSpatial).not.toHaveBeenCalled();
  });

  it("dispatches auth expiry and supports roving keyboard focus", async () => {
    const expired = vi.fn();
    window.addEventListener(ATLAS_AUTH_EXPIRED_EVENT, expired);
    rotateAuthSession();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([available, unavailable]))
      .mockResolvedValueOnce(jsonResponse({ error_code: "UNAUTHORIZED", message: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    try {
      renderPanel();
      const firstDataRow = await screen.findByRole("button", {
        name: /Reference Fixture/
      });
      const secondDataRow = screen.getByRole("button", {
        name: /Weather Feed/
      });
      firstDataRow.focus();
      await user.keyboard("{ArrowDown}");
      expect(secondDataRow).toHaveFocus();

      await user.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
      expect(screen.getByText("Reference Fixture")).toBeInTheDocument();
    } finally {
      window.removeEventListener(ATLAS_AUTH_EXPIRED_EVENT, expired);
    }
  });

  it.each([
    ["terrain_probe", "Inspect terrain", "terrain_result"],
    ["parcel_lookup", "Inspect parcels", "parcel_result"]
  ])("runs map-area operations identically for %s", async (pluginId, operationName, featureId) => {
    const plugin: PluginStatus = {
      ...available,
      plugin_id: pluginId,
      display_name: pluginId.replaceAll("_", " "),
      operations: [
        {
          operation_id: `${pluginId}_search`,
          display_name: operationName,
          timeout_ms: 8000,
          interaction: { kind: "map_area" }
        }
      ]
    };
    const response: SpatialOperationResult = {
      features: [
        {
          id: featureId,
          title: `Result from ${pluginId}`,
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-71.001, 42.001],
                [-71.0, 42.001],
                [-71.0, 42.0],
                [-71.001, 42.001]
              ]
            ]
          },
          fields: [{ label: "Kind", value: "Fixture" }]
        }
      ],
      provenance: {
        connector_id: "fixture_source",
        source: "Fixture source"
      },
      attribution: {
        text: "Fixture attribution",
        url: "https://example.test/attribution"
      },
      retrieved_at: "2026-08-30T12:00:00Z",
      truncation: null
    };
    const executor: SpatialOperationExecutor = {
      invokeSpatial: vi.fn(async () => response)
    };
    const user = userEvent.setup();

    renderSpatialPanel({ list: vi.fn(async () => [plugin]) }, executor);
    const pluginButton = (await screen.findByText(pluginId.replaceAll("_", " "))).closest("button");
    expect(pluginButton).not.toBeNull();
    await user.click(pluginButton as HTMLButtonElement);
    await user.click(screen.getByRole("button", { name: new RegExp(operationName, "i") }));
    await user.click(screen.getByRole("button", { name: "Use current view" }));
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(
      await screen.findByRole("button", {
        name: new RegExp(`Result from ${pluginId}`)
      })
    ).toBeInTheDocument();
    expect(screen.queryByText("West")).not.toBeInTheDocument();
    expect(screen.getByText("0.01 km²")).toBeInTheDocument();
    expect(executor.invokeSpatial).toHaveBeenCalledWith(
      pluginId,
      `${pluginId}_search`,
      { west: -71.001, south: 42, east: -71, north: 42.001 },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("keeps prior results visible through refresh, cancellation, and source failure", async () => {
    const firstResponse = spatialResponse({
      truncation: { reason: "feature_limit" }
    });
    const signals: AbortSignal[] = [];
    const executor: SpatialOperationExecutor = {
      invokeSpatial: vi
        .fn<SpatialOperationExecutor["invokeSpatial"]>()
        .mockResolvedValueOnce(firstResponse)
        .mockImplementationOnce((_pluginId, _operationId, _area, options) => {
          if (options?.signal) signals.push(options.signal);
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        })
        .mockRejectedValue(new Error("fixture source offline"))
    };
    const user = userEvent.setup();

    renderSpatialPanel({ list: vi.fn(async () => [available]) }, executor);
    await openSpatialOperation(user, available.display_name ?? available.plugin_id, "Inspect fixture");

    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("button", { name: /Fixture result/ })).toBeInTheDocument();
    expect(screen.getByText("Results truncated: feature limit")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Searching. Previous results remain visible.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fixture result/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(signals[0]?.aborted).toBe(true);
    expect(await screen.findByText("Results are stale.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Source error")).toBeInTheDocument();
    expect(screen.getByText("fixture source offline Previous results retained.")).toBeInTheDocument();
    expect(screen.getByText("stale")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fixture result/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(executor.invokeSpatial).toHaveBeenCalledTimes(4));
    expect(executor.invokeSpatial).toHaveBeenLastCalledWith(
      available.plugin_id,
      available.operations[0].operation_id,
      { west: -71.001, south: 42, east: -71, north: 42.001 },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("blocks invocation when polling reports that the open plugin became unavailable", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reader = {
      list: vi
        .fn<() => Promise<PluginStatus[]>>()
        .mockResolvedValueOnce([available])
        .mockResolvedValue([
          {
            ...available,
            status: "unavailable",
            reason_code: "transport_timeout"
          }
        ])
    };
    const executor: SpatialOperationExecutor = {
      invokeSpatial: vi.fn(async () => spatialResponse())
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    renderSpatialPanel(reader, executor);
    await openSpatialOperation(user, available.display_name ?? available.plugin_id, "Inspect fixture");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("button", { name: /Fixture result/ })).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(await screen.findByText("Plugin unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fixture result/ })).toBeInTheDocument();
    expect(executor.invokeSpatial).toHaveBeenCalledOnce();
  });

  it("closes a spatial runner when refreshed discovery removes its operation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reader = {
      list: vi
        .fn<() => Promise<PluginStatus[]>>()
        .mockResolvedValueOnce([available])
        .mockResolvedValue([{ ...available, operations: [] }])
    };
    const executor: SpatialOperationExecutor = {
      invokeSpatial: vi.fn(async () => spatialResponse())
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    renderSpatialPanel(reader, executor);
    await openSpatialOperation(user, available.display_name ?? available.plugin_id, "Inspect fixture");
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await screen.findByText("This plugin has no map area operations.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
  });
});

async function openSpatialOperation(
  user: ReturnType<typeof userEvent.setup>,
  pluginName: string,
  operationName: string
) {
  const pluginButton = (await screen.findByText(pluginName)).closest("button");
  expect(pluginButton).not.toBeNull();
  await user.click(pluginButton as HTMLButtonElement);
  await user.click(screen.getByRole("button", { name: new RegExp(operationName, "i") }));
  await user.click(screen.getByRole("button", { name: "Use current view" }));
}

function spatialResponse({
  truncation = null
}: Partial<Pick<SpatialOperationResult, "truncation">> = {}): SpatialOperationResult {
  return {
    features: [
      {
        id: "fixture_result",
        title: "Fixture result",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-71.001, 42.001],
              [-71, 42.001],
              [-71, 42],
              [-71.001, 42.001]
            ]
          ]
        },
        fields: [{ label: "Kind", value: "Fixture" }]
      }
    ],
    provenance: { connector_id: "fixture_source", source: "Fixture source" },
    attribution: {
      text: "Fixture attribution",
      url: "https://example.test/attribution"
    },
    retrieved_at: "2026-08-30T12:00:00Z",
    truncation
  };
}

function renderPanel(
  reader?: { list(options?: { signal?: AbortSignal }): Promise<PluginStatus[]> },
  selection?: PluginSelection
) {
  const value = atlasContextValue();
  return render(
    <AtlasStaticProvider value={value}>
      <PluginsPanel reader={reader} selection={selection} onSelectionChange={() => undefined} />
    </AtlasStaticProvider>
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderSpatialPanel(
  reader: { list(options?: { signal?: AbortSignal }): Promise<PluginStatus[]> },
  executor: SpatialOperationExecutor
) {
  const value = atlasContextValue();
  return render(
    <AtlasStaticProvider value={value}>
      <SpatialPanel reader={reader} executor={executor} />
    </AtlasStaticProvider>
  );
}

function SpatialPanel({
  reader,
  executor
}: {
  reader: { list(options?: { signal?: AbortSignal }): Promise<PluginStatus[]> };
  executor: SpatialOperationExecutor;
}) {
  const spatial = useSpatialOperationRunner({ executor });
  const [selection, setSelection] = useState<PluginSelection>();
  useEffect(() => {
    spatial.setViewportArea({
      west: -71.001,
      south: 42,
      east: -71,
      north: 42.001
    });
  }, [spatial.setViewportArea]);
  return (
    <>
      <PluginsPanel reader={reader} selection={selection} onSelectionChange={setSelection} spatial={spatial} />
      <MapWindowWorkspace>
        <SpatialResultsInspector spatial={spatial} onPreviewFeature={() => {}} onFocusFeature={() => {}} />
      </MapWindowWorkspace>
    </>
  );
}

function atlasContextValue(): AtlasContextValue {
  return {
    status: "ready",
    config: {
      atlasBaseUrl: "https://core.test",
      protocolRevision: "rev",
      defaultMapSourceId: "openstreetmap-default",
      placeSearch: { provider: "maptiler", unavailableReason: "missing key" },
      mapSources: [
        {
          id: "openstreetmap-default",
          label: "OpenStreetMap Default",
          style: styleFixture("openstreetmap-default")
        }
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
}
