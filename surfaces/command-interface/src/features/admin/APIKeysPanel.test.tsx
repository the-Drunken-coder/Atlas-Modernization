import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AtlasAPIError } from "@the-drunken-coder/atlas-sdk/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { styleFixture } from "../../../test/fixtures.js";
import { emptySnapshot } from "../../atlas/store.js";
import { type AtlasContextValue, AtlasStaticProvider } from "../../state/atlas-context.js";
import { APIKeysPanel } from "./APIKeysPanel.js";

const atlasValue: AtlasContextValue = {
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
  createGeofeature: async () => {
    throw new Error("Unexpected Geo Feature creation");
  },
  updateGeometry: async () => {
    throw new Error("not used");
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("APIKeysPanel", () => {
  it("loads, creates, copies, and revokes API keys with Core admin credentials", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "atlas_ak_existing",
            name: "existing",
            key_prefix: "atlas_ak_existing",
            created_at: "2026-07-01T12:00:00Z",
            created_by: "admin"
          }
        ])
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "atlas_ak_created",
          name: "sim runner",
          key_prefix: "atlas_ak_created",
          created_at: "2026-07-01T12:01:00Z",
          created_by: "admin",
          api_key: "atlas_ak_created.secret"
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();

    expect(await screen.findByText("existing")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("https://core.test/admin/api-keys");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "include" });

    await user.type(screen.getByLabelText("Name"), "sim runner");
    await user.click(screen.getByRole("button", { name: /Create/ }));
    expect(await screen.findByText("atlas_ak_created.secret")).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][0]).toBe("https://core.test/admin/api-keys");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", credentials: "include" });

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("atlas_ak_created.secret");

    await user.click(screen.getByRole("button", { name: "Revoke existing" }));
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByText("existing")).not.toBeInTheDocument());
    expect(fetchMock.mock.calls[2][0]).toBe("https://core.test/admin/api-keys/atlas_ak_existing");
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "DELETE", credentials: "include" });
  });

  it("disables every revoke action while one revoke is pending", async () => {
    const user = userEvent.setup();
    let releaseRevoke!: () => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "atlas_ak_first",
            name: "first",
            key_prefix: "atlas_ak_first",
            created_at: "2026-07-01T12:00:00Z",
            created_by: "admin"
          },
          {
            id: "atlas_ak_second",
            name: "second",
            key_prefix: "atlas_ak_second",
            created_at: "2026-07-01T12:01:00Z",
            created_by: "admin"
          }
        ])
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseRevoke = () => resolve(new Response(null, { status: 204 }));
          })
      );
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();

    await screen.findByText("first");
    await user.click(screen.getByRole("button", { name: "Revoke first" }));
    await user.click(screen.getByRole("button", { name: "Revoke" }));

    expect(screen.getByRole("button", { name: "Revoke first" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke second" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    releaseRevoke();
    await waitFor(() => expect(screen.queryByText("first")).not.toBeInTheDocument());
  });

  it("offers Retry after the initial API-key list fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "list unavailable" }, 503))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "atlas_ak_recovered",
            name: "recovered",
            key_prefix: "atlas_ak_recovered",
            created_at: "2026-07-01T12:00:00Z",
            created_by: "admin"
          }
        ])
      );
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();

    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("No API keys.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("recovered")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains loaded keys and announces a later list failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "atlas_ak_existing",
            name: "existing",
            key_prefix: "atlas_ak_existing",
            created_at: "2026-07-01T12:00:00Z",
            created_by: "admin"
          }
        ])
      )
      .mockResolvedValueOnce(jsonResponse({ message: "list unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderPanel();

    expect(await screen.findByText("existing")).toBeInTheDocument();
    view.rerender(
      <AtlasStaticProvider
        value={{
          ...atlasValue,
          config: { ...atlasValue.config!, atlasBaseUrl: "https://other-core.test" }
        }}
      >
        <APIKeysPanel />
      </AtlasStaticProvider>
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("list unavailable");
    expect(screen.getByText("existing")).toBeInTheDocument();
  });

  it("does not let a reconnect refresh overwrite a completed revoke", async () => {
    const user = userEvent.setup();
    const revoke = deferred<Response>();
    const refresh = deferred<Response>();
    const existing = {
      id: "atlas_ak_existing",
      name: "existing",
      key_prefix: "atlas_ak_existing",
      created_at: "2026-07-01T12:00:00Z",
      created_by: "admin"
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([existing]))
      .mockImplementationOnce(() => revoke.promise)
      .mockImplementationOnce(() => refresh.promise);
    vi.stubGlobal("fetch", fetchMock);
    const view = renderPanel();

    await screen.findByText("existing");
    await user.click(screen.getByRole("button", { name: "Revoke existing" }));
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    view.rerender(
      <AtlasStaticProvider value={{ ...atlasValue, config: { ...atlasValue.config! } }}>
        <APIKeysPanel />
      </AtlasStaticProvider>
    );

    expect(screen.getByLabelText("Name")).toBeDisabled();
    await act(async () => revoke.resolve(new Response(null, { status: 204 })));
    expect(screen.queryByText("existing")).not.toBeInTheDocument();
    expect(screen.getByText("Loading API keys...")).toBeInTheDocument();

    await act(async () => refresh.resolve(jsonResponse([existing])));
    expect(screen.queryByText("existing")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeEnabled();
  });

  it("announces dynamic API-key errors", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse({ message: "create failed" }, 500))
    );
    renderPanel();

    await user.type(await screen.findByLabelText("Name"), "sim runner");
    await user.click(screen.getByRole("button", { name: /Create/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("create failed");
  });

  it("dispatches auth-expired when Core rejects the admin session", async () => {
    const expired = vi.fn();
    window.addEventListener("atlas-auth-expired", expired);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ success: false, message: "unauthorized", error_code: "UNAUTHORIZED" }, 401))
    );

    try {
      renderPanel();
      await waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
    } finally {
      window.removeEventListener("atlas-auth-expired", expired);
    }
  });

  it("does not expire a newer session when an old key mutation rejects", async () => {
    const user = userEvent.setup();
    const expired = vi.fn();
    let rejectCreate!: (cause: unknown) => void;
    const pendingCreate = new Promise<Response>((_resolve, reject) => {
      rejectCreate = reject;
    });
    window.addEventListener("atlas-auth-expired", expired);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([]))
        .mockImplementationOnce(() => pendingCreate)
    );

    try {
      renderPanel();
      await user.type(await screen.findByLabelText("Name"), "old session key");
      await user.click(screen.getByRole("button", { name: /Create/ }));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

      window.dispatchEvent(new Event("atlas-auth-session-changed"));
      rejectCreate(new AtlasAPIError("unauthorized", 401, {}));

      await waitFor(() => expect(screen.getByText("unauthorized")).toBeInTheDocument());
      expect(expired).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("atlas-auth-expired", expired);
    }
  });

  it("shows an error when copying the generated key fails", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(
          jsonResponse({
            id: "atlas_ak_created",
            name: "sim runner",
            key_prefix: "atlas_ak_created",
            created_at: "2026-07-01T12:01:00Z",
            created_by: "admin",
            api_key: "atlas_ak_created.secret"
          })
        )
    );

    renderPanel();

    await user.type(await screen.findByLabelText("Name"), "sim runner");
    await user.click(screen.getByRole("button", { name: /Create/ }));
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    expect(await screen.findByText("Failed to copy key to clipboard.")).toBeInTheDocument();
  });
});

function renderPanel() {
  return render(
    <AtlasStaticProvider value={atlasValue}>
      <APIKeysPanel />
    </AtlasStaticProvider>
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
