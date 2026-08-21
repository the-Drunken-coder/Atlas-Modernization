import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StyleSpecification } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtlasDataSource } from "../atlas/data-source.js";
import { useAtlas } from "../state/atlas-context.js";
import type { AppConfig, CoreConfig } from "./config.js";
import { Providers } from "./providers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const config: AppConfig = {
  atlasBaseUrl: "https://core.test",
  protocolRevision: "rev",
  defaultMapSourceId: "openstreetmap-default",
  mapSources: [{ id: "openstreetmap-default", label: "OpenStreetMap Default", style: style("openstreetmap-default") }]
};
const coreConfig: CoreConfig = { atlasBaseUrl: config.atlasBaseUrl, protocolRevision: config.protocolRevision };

function StartupProbe() {
  const atlas = useAtlas();
  return (
    <div>
      <span>{atlas.status}</span>
      <span data-testid="atlas-base-url">{atlas.config?.atlasBaseUrl}</span>
    </div>
  );
}

describe("Providers", () => {
  it("does not initialize map configuration or Atlas data for an anonymous visit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: false, error_code: "UNAUTHORIZED", message: "unauthorized" }), {
            status: 401
          })
      )
    );
    const loadConfig = vi.fn(async () => config);
    const createDataSource = vi.fn(() => fakeDataSource([]));

    render(
      <Providers coreConfig={coreConfig} loadConfig={loadConfig} createDataSource={createDataSource}>
        <div>map workspace</div>
      </Providers>
    );

    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.queryByText("map workspace")).not.toBeInTheDocument();
    expect(loadConfig).not.toHaveBeenCalled();
    expect(createDataSource).not.toHaveBeenCalled();
  });

  it("checks the session before loading map config and starting the Atlas data source", async () => {
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const startupOrder: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        startupOrder.push("session");
        fetchCalls.push([input, init]);
        return new Response(JSON.stringify({ user: { username: "operator" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      })
    );

    const calls: string[] = [];
    const dataSource = fakeDataSource(calls);
    const loadConfig = vi.fn(async () => {
      startupOrder.push("map-config");
      return config;
    });
    const createDataSource = vi.fn(() => {
      startupOrder.push("data-source");
      return dataSource;
    });

    render(
      <Providers coreConfig={coreConfig} loadConfig={loadConfig} createDataSource={createDataSource}>
        <StartupProbe />
      </Providers>
    );

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(screen.getByTestId("atlas-base-url")).toHaveTextContent("https://core.test");
    expect(createDataSource).toHaveBeenCalledWith(config);
    expect(calls.slice(0, 4)).toEqual(["watch", "start", "snapshot", "loadCommandCatalog"]);
    expect(startupOrder.slice(0, 3)).toEqual(["session", "map-config", "data-source"]);
    await waitFor(() =>
      expect(fetchCalls[0]).toMatchObject(["https://core.test/admin/auth/me", { credentials: "include" }])
    );
  });

  it("retries configuration once when the operator requests it", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ user: { username: "operator" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
      )
    );
    const loadConfig = vi.fn().mockRejectedValueOnce(new Error("config unavailable")).mockResolvedValue(config);
    const calls: string[] = [];

    render(
      <Providers loadConfig={loadConfig} createDataSource={() => fakeDataSource(calls)}>
        <StartupProbe />
      </Providers>
    );

    expect(await screen.findByText("config unavailable")).toBeInTheDocument();
    expect(loadConfig).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Retry configuration" }));

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(calls.slice(0, 4)).toEqual(["watch", "start", "snapshot", "loadCommandCatalog"]);
  });
});

function fakeDataSource(calls: string[]): AtlasDataSource {
  return {
    snapshot() {
      calls.push("snapshot");
      return { entities: {}, tasks: {} };
    },
    async loadCommandCatalog() {
      calls.push("loadCommandCatalog");
      return [];
    },
    watch() {
      calls.push("watch");
      return () => calls.push("unsubscribe");
    },
    async start() {
      calls.push("start");
    },
    async submitCommand() {
      throw new Error("not used");
    },
    async updateGeometry() {
      throw new Error("not used");
    },
    health() {
      return { running: true, healthy: true, degraded: false };
    },
    dispose() {
      calls.push("dispose");
    }
  };
}

function style(id: string): StyleSpecification {
  return { version: 8, sources: {}, layers: [], metadata: { id } };
}
