import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarRail } from "../../ui/layout/SidebarRail.js";
import { ATLAS_AUTH_EXPIRED_EVENT, rotateAuthSession } from "../atlas.js";
import { AuthGate, WorkspaceErrorBoundary } from "./AuthGate.js";

function Workspace() {
  return (
    <>
      <SidebarRail
        collapsed={false}
        activeList="assets"
        counts={{ asset: 0, track: 0, geofeature: 0 }}
        onSelectList={() => {}}
        onToggleCollapsed={() => {}}
      />
      <div>map console</div>
    </>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AuthGate", () => {
  it("offers retry and logout when the authenticated workspace fails", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onLogout = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const BrokenWorkspace = () => {
      throw new Error("chunk rejected");
    };

    render(
      <WorkspaceErrorBoundary loggingOut={false} onRetry={onRetry} onLogout={onLogout}>
        <BrokenWorkspace />
      </WorkspaceErrorBoundary>
    );

    expect(screen.getByRole("alert")).toHaveTextContent("failed to load");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onLogout).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("shows logout progress and errors when the workspace fails", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const BrokenWorkspace = () => {
      throw new Error("chunk rejected");
    };

    render(
      <WorkspaceErrorBoundary loggingOut logoutError="logout unavailable" onRetry={() => {}} onLogout={() => {}}>
        <BrokenWorkspace />
      </WorkspaceErrorBoundary>
    );

    expect(screen.getByRole("button", { name: "Logging out..." })).toBeDisabled();
    expect(screen.getByText("logout unavailable")).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("shows login instead of the console when the session is missing", async () => {
    const fetchStub = stubFetch([
      { status: 401, body: { success: false, error_code: "UNAUTHORIZED", message: "unauthorized" } }
    ]);

    render(
      <AuthGate baseUrl="https://core.test">
        <Workspace />
      </AuthGate>
    );

    expect(await screen.findByLabelText("Username")).toHaveFocus();
    expect(screen.queryByText("map console")).not.toBeInTheDocument();
    expect(fetchStub.calls[0]?.[0]).toBe("https://core.test/admin/auth/me");
    expect(fetchStub.calls[0]?.[1]).toMatchObject({ credentials: "include" });
  });

  it("shows session check failures without presenting the login form", async () => {
    const user = userEvent.setup();
    const secret = "pre-auth-api-key-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`Core is unavailable: https://core.test?api_key=${secret}`);
      })
    );

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    const badge = await screen.findByRole("button", { name: "Atlas connection error" });
    badge.focus();
    await user.keyboard("{Enter}");

    const dialog = screen.getByRole("dialog", { name: "Atlas Core connection error" });
    expect(dialog).toHaveTextContent("Core is unavailable");
    expect(dialog).not.toHaveTextContent(secret);
    expect(screen.getByRole("button", { name: "Close connection details" })).toHaveFocus();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(screen.queryByText("map console")).not.toBeInTheDocument();
  });

  it.each([
    ["a null response", null],
    ["an empty username", { user: { username: "" } }],
    ["a whitespace username", { user: { username: "   " } }],
    ["a missing user", {}]
  ])("rejects %s from the session endpoint", async (_name, body) => {
    stubFetch([{ status: 200, body }]);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Core unavailable");
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(screen.queryByText("map console")).not.toBeInTheDocument();
  });

  it("rejects malformed JSON from the session endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{", { status: 200, headers: { "Content-Type": "application/json" } }))
    );

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Core unavailable");
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
  });

  it("does not treat a non-401 session response as logged out", async () => {
    stubFetch([{ status: 503, body: { message: "session unavailable" } }]);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Core unavailable");
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
  });

  it("retries the initial Core session check only when the operator requests it", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Core is unavailable"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user: { username: "operator" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    await user.click(await screen.findByRole("button", { name: "Atlas connection error" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Retry connection" }));

    expect(await screen.findByText("map console")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns focus to the connection error after a failed pre-auth retry", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Core is unavailable"))
      .mockRejectedValueOnce(new Error("Core is still unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    await user.click(await screen.findByRole("button", { name: "Atlas connection error" }));
    await user.click(screen.getByRole("button", { name: "Retry connection" }));

    const retryBadge = await screen.findByRole("button", { name: "Atlas connection error" });
    expect(retryBadge).toHaveFocus();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await user.click(retryBadge);
    expect(screen.getByRole("button", { name: "Close connection details" })).toHaveFocus();
  });

  it("renders children after successful login", async () => {
    const user = userEvent.setup();
    const fetchStub = stubFetch([
      { status: 401, body: { success: false, error_code: "UNAUTHORIZED", message: "unauthorized" } },
      { status: 200, body: { user: { username: "operator" } } }
    ]);

    render(
      <AuthGate baseUrl="https://core.test">
        <Workspace />
      </AuthGate>
    );

    await user.type(await screen.findByLabelText("Username"), "operator");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("map console")).toBeInTheDocument();
    expect(screen.queryByText("Signed in as")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Account" }));
    const accountMenu = screen.getByRole("group", { name: "Account menu" });
    expect(accountMenu).toBeInTheDocument();
    expect(accountMenu.parentElement).toBe(document.body);
    expect(screen.getByText("Your account")).toBeInTheDocument();
    expect(screen.getByText("operator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Settings/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    expect(fetchStub.calls[1]).toMatchObject([
      "https://core.test/admin/auth/login",
      {
        method: "POST",
        credentials: "include"
      }
    ]);
    expect(JSON.parse(String(fetchStub.calls[1][1]?.body))).toEqual({
      username: "operator",
      password: "correct-password"
    });
  });

  it("sanitizes login failures before displaying them", async () => {
    const user = userEvent.setup();
    const secret = "login-api-key-secret";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: false, error_code: "UNAUTHORIZED", message: "unauthorized" }), {
            status: 401
          })
        )
        .mockRejectedValueOnce(new Error(`Atlas login failed: https://core.test?api_key=${secret}`))
    );

    const { container } = render(
      <AuthGate baseUrl="https://core.test">
        <Workspace />
      </AuthGate>
    );

    await user.type(await screen.findByLabelText("Username"), "operator");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/Atlas login failed/)).toBeInTheDocument();
    expect(container).not.toHaveTextContent(secret);
  });

  it("keeps account controls available without a sidebar child", async () => {
    stubFetch([{ status: 200, body: { user: { username: "operator" } } }]);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>configuration unavailable</div>
      </AuthGate>
    );

    expect(await screen.findByText("configuration unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account" })).toBeInTheDocument();
  });

  it("dismisses the account menu with Escape or an outside click", async () => {
    const user = userEvent.setup();
    const mapEscape = vi.fn();
    const mapKeyListener = (event: KeyboardEvent) => {
      if (event.key === "Escape") mapEscape();
    };
    window.addEventListener("keydown", mapKeyListener);
    stubFetch([{ status: 200, body: { user: { username: "operator" } } }]);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    const account = await screen.findByRole("button", { name: "Account" });
    await user.click(account);
    expect(screen.getByRole("button", { name: "Log out" })).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Account menu" })).not.toBeInTheDocument();
    expect(account).toHaveFocus();
    expect(mapEscape).not.toHaveBeenCalled();

    await user.click(account);
    await user.click(screen.getByText("map console"));
    expect(screen.queryByRole("group", { name: "Account menu" })).not.toBeInTheDocument();
    window.removeEventListener("keydown", mapKeyListener);
  });

  it("keeps the menu open and disables logout while the request is pending", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { username: "operator" } }), { status: 200 }))
      .mockImplementationOnce(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    await user.click(await screen.findByRole("button", { name: "Account" }));
    await user.click(screen.getByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("button", { name: "Logging out..." })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("group", { name: "Account menu" })).toBeInTheDocument();
  });

  it("logs out through Core and returns focus to the login form", async () => {
    const user = userEvent.setup();
    const fetchStub = stubFetch([{ status: 200, body: { user: { username: "operator" } } }, { status: 204 }]);

    render(
      <AuthGate baseUrl="https://core.test">
        <Workspace />
      </AuthGate>
    );

    await user.click(await screen.findByRole("button", { name: "Account" }));
    await user.click(screen.getByRole("button", { name: "Log out" }));

    expect(await screen.findByLabelText("Username")).toHaveFocus();
    expect(screen.queryByText("map console")).not.toBeInTheDocument();
    expect(fetchStub.calls[1]).toMatchObject([
      "https://core.test/admin/auth/logout",
      {
        method: "POST",
        credentials: "include"
      }
    ]);
  });

  it("keeps the workspace mounted when logout fails", async () => {
    const user = userEvent.setup();
    stubFetch([
      { status: 200, body: { user: { username: "operator" } } },
      { status: 503, body: { message: "logout unavailable" } }
    ]);

    render(
      <AuthGate baseUrl="https://core.test">
        <Workspace />
      </AuthGate>
    );

    await user.click(await screen.findByRole("button", { name: "Account" }));
    await user.click(screen.getByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("logout unavailable");
    expect(screen.getByText("map console")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeEnabled();
  });

  it("returns to logged-out state when Atlas auth expires", async () => {
    stubFetch([{ status: 200, body: { user: { username: "operator" } } }]);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    expect(await screen.findByText("map console")).toBeInTheDocument();
    fireEvent(window, new CustomEvent(ATLAS_AUTH_EXPIRED_EVENT, { detail: { session: rotateAuthSession() } }));

    await waitFor(() => expect(screen.getByLabelText("Username")).toBeInTheDocument());
    expect(screen.getByText("Your session has expired. Please sign in again.")).toBeInTheDocument();
    expect(screen.queryByText("map console")).not.toBeInTheDocument();
  });

  it("ignores an auth-expired event without session provenance while login is visible", async () => {
    stubFetch([{ status: 401, body: { success: false, error_code: "UNAUTHORIZED", message: "unauthorized" } }]);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    fireEvent(window, new Event(ATLAS_AUTH_EXPIRED_EVENT));

    await waitFor(() => expect(screen.getByLabelText("Username")).toBeInTheDocument());
    expect(screen.queryByText("Your session has expired. Please sign in again.")).not.toBeInTheDocument();
  });
});

function stubFetch(responses: Array<{ status: number; body?: unknown }>): {
  calls: Array<[RequestInfo | URL, RequestInit | undefined]>;
} {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    const response = responses.shift() ??
      responses.at(-1) ?? {
        status: 401,
        body: { success: false, error_code: "UNAUTHORIZED", message: "unauthorized" }
      };
    return new Response(response.status === 204 ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" }
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}
