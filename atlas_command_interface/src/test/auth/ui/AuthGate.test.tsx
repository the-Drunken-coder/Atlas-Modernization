import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "../../../auth/ui/AuthGate.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AuthGate", () => {
  it("shows login instead of the console when the session is missing", async () => {
    stubFetch([{ status: 401, body: { success: false, error_code: "UNAUTHORIZED", message: "unauthorized" } }]);

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.queryByText("map console")).not.toBeInTheDocument();
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
    expect(screen.queryByText("map console")).not.toBeInTheDocument();
  });
});

function stubFetch(responses: Array<{ status: number; body: unknown }>): { calls: Array<[RequestInfo | URL, RequestInit | undefined]> } {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    const response = responses.shift() ?? responses.at(-1) ?? { status: 401, body: { success: false, error_code: "UNAUTHORIZED", message: "unauthorized" } };
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}
