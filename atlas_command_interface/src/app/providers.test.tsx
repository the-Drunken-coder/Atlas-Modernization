import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StyleSpecification } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.js";
import { Providers } from "./providers.js";
import type { AtlasDataSource } from "../atlas/data-source.js";
import { useAtlas } from "../state/atlas-context.js";

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
  it("loads config, checks the real auth session path, and starts the Atlas data source", async () => {
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push([input, init]);
        return new Response(JSON.stringify({ user: { username: "operator", role: "admin" } }), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );

    const calls: string[] = [];
    const dataSource = fakeDataSource(calls);
    const createDataSource = vi.fn(() => dataSource);

    render(
      <Providers loadConfig={async () => config} createDataSource={createDataSource}>
        <StartupProbe />
      </Providers>
    );

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(screen.getByTestId("atlas-base-url")).toHaveTextContent("https://core.test");
    expect(createDataSource).toHaveBeenCalledWith(config);
    expect(calls.slice(0, 4)).toEqual(["watch", "start", "snapshot", "loadCommandCatalog"]);
    await waitFor(() => expect(fetchCalls[0]).toMatchObject(["https://core.test/admin/auth/me", { credentials: "include" }]));
  });

  it("retries configuration once when the operator requests it", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ user: { username: "operator", role: "admin" } }), { status: 200, headers: { "Content-Type": "application/json" } }))
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
      return { type: "command_catalog", name: "Catalog", description: "Test", commands: [] };
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
