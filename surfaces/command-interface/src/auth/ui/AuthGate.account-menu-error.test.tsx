import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "./AuthGate.js";

vi.mock("./AccountMenu.js", () => {
  throw new Error("account menu chunk rejected");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AuthGate account menu loading", () => {
  it("keeps a rejected account menu chunk inside the authenticated recovery boundary", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
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

    render(
      <AuthGate baseUrl="https://core.test">
        <div>map console</div>
      </AuthGate>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("The map workspace failed to load.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    expect(screen.queryByText("map console")).not.toBeInTheDocument();
    consoleError.mockRestore();
  });
});
