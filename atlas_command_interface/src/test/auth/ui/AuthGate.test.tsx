import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate, WorkspaceErrorBoundary } from "../../../auth/ui/AuthGate.js";

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
      <WorkspaceErrorBoundary onRetry={onRetry} onLogout={onLogout}>
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

  it("shows login instead of the console when the session is missing", async () => {
    const fetchStub = stubFetch([{ status: 401, body: { success: false, error_code: "UNAUTHORIZED", message: "unauthorized" } }]);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    expect(await screen.findByLabelText("Username")).toHaveFocus();
    expect(screen.queryByText("map console")).not.toBeInTheDocument();
    expect(fetchStub.calls[0]?.[0]).toBe("https://core.test/admin/auth/me");
    expect(fetchStub.calls[0]?.[1]).toMatchObject({ credentials: "include" });
  });

  it("shows session check failures without presenting the login form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Core is unavailable");
      })
    );

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    expect(await screen.findByText("Core is unavailable")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(screen.queryByText("map console")).not.toBeInTheDocument();
  });

  it("retries the initial Core session check only when the operator requests it", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Core is unavailable"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user: { username: "operator", role: "admin" } }), {
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

    expect(await screen.findByText("Core is unavailable")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Retry connection" }));

    expect(await screen.findByText("map console")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders children after successful login", async () => {
    const user = userEvent.setup();
    const fetchStub = stubFetch([
      { status: 401, body: { success: false, error_code: "UNAUTHORIZED", message: "unauthorized" } },
      { status: 200, body: { user: { username: "operator", role: "admin" } } }
    ]);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    await user.type(await screen.findByLabelText("Username"), "operator");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("map console")).toBeInTheDocument();
    expect(screen.getByText("Operator")).toBeInTheDocument();
    expect(screen.getByText("operator")).toBeInTheDocument();
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

  it("logs out through Core and returns focus to the login form", async () => {
    const user = userEvent.setup();
    const fetchStub = stubFetch([{ status: 200, body: { user: { username: "operator", role: "admin" } } }, { status: 204 }]);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    await user.click(await screen.findByRole("button", { name: "Log out" }));

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
      { status: 200, body: { user: { username: "operator", role: "admin" } } },
      { status: 503, body: { message: "logout unavailable" } }
    ]);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    await user.click(await screen.findByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("logout unavailable");
    expect(screen.getByText("map console")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeEnabled();
  });

  it("returns to logged-out state when Atlas auth expires", async () => {
    stubFetch([{ status: 200, body: { user: { username: "operator", role: "admin" } } }]);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    expect(await screen.findByText("map console")).toBeInTheDocument();
    fireEvent(window, new Event("atlas-auth-expired"));

    await waitFor(() => expect(screen.getByLabelText("Username")).toBeInTheDocument());
    expect(screen.getByText("Your session has expired. Please sign in again.")).toBeInTheDocument();
    expect(screen.queryByText("map console")).not.toBeInTheDocument();
  });

  it("shows expiration reason when auth expires while login is already visible", async () => {
    stubFetch([{ status: 401, body: { success: false, error_code: "UNAUTHORIZED", message: "unauthorized" } }]);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    fireEvent(window, new Event("atlas-auth-expired"));

    await waitFor(() => expect(screen.getByText("Your session has expired. Please sign in again.")).toBeInTheDocument());
  });
});

function stubFetch(responses: Array<{ status: number; body?: unknown }>): { calls: Array<[RequestInfo | URL, RequestInit | undefined]> } {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    const response = responses.shift() ?? responses.at(-1) ?? { status: 401, body: { success: false, error_code: "UNAUTHORIZED", message: "unauthorized" } };
    return new Response(response.status === 204 ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" }
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}
