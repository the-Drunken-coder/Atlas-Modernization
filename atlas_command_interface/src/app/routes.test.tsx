import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ConsoleRoutes } from "./routes.js";

describe("console routes", () => {
  it("redirects /home to /map", () => {
    render(
      <MemoryRouter initialEntries={["/home"]}>
        <ConsoleRoutes mapElement={<div>MAP WORKSPACE</div>} />
      </MemoryRouter>
    );
    expect(screen.getByText("MAP WORKSPACE")).toBeInTheDocument();
  });

  it("redirects unknown paths to /map", () => {
    render(
      <MemoryRouter initialEntries={["/somewhere-else"]}>
        <ConsoleRoutes mapElement={<div>MAP WORKSPACE</div>} />
      </MemoryRouter>
    );
    expect(screen.getByText("MAP WORKSPACE")).toBeInTheDocument();
  });

  it("renders the map workspace at /map", () => {
    render(
      <MemoryRouter initialEntries={["/map"]}>
        <ConsoleRoutes mapElement={<div>MAP WORKSPACE</div>} />
      </MemoryRouter>
    );
    expect(screen.getByText("MAP WORKSPACE")).toBeInTheDocument();
  });
});
